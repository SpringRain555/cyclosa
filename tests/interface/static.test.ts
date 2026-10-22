/**
 * 靜態檔的路徑圍堵。
 *
 * **這條測試是「不引 `@fastify/static`」那個決定的代價。**
 * 自己做路徑圍堵就要自己驗它，而且要用真的穿越字串驗，不是看程式碼覺得對。
 */
import { describe, expect, it } from 'vitest';
import { resolve, sep, join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { registerParamGuard } from '../../src/interface/http/param-guard.js';
import { safeResolve, registerStatic } from '../../src/interface/http/static.js';

const ROOT = resolve('/srv/web');

describe('safeResolve 的路徑圍堵', () => {
  it('正常路徑解得出來', () => {
    expect(safeResolve(ROOT, '/index.html')).toBe(resolve(ROOT, 'index.html'));
    expect(safeResolve(ROOT, '/assets/app.js')).toBe(resolve(ROOT, 'assets', 'app.js'));
  });

  it.each([
    '/../secret',
    '/../../etc/passwd',
    '/assets/../../secret',
    '/..%2fsecret',
    '/%2e%2e/secret',
    '/%2e%2e%2f%2e%2e%2fsecret',
  ])('擋掉穿越：%s', (path) => {
    expect(safeResolve(ROOT, path)).toBeNull();
  });

  it('擋掉 null byte', () => {
    expect(safeResolve(ROOT, '/index.html%00.png')).toBeNull();
  });

  it('壞掉的 percent-encoding 直接拒絕，不是丟例外', () => {
    expect(safeResolve(ROOT, '/%zz')).toBeNull();
  });

  it('**前綴檢查要帶分隔符號** —— 兄弟目錄不算在裡面', () => {
    // `/srv/web-evil` 的前綴是 `/srv/web`，但它不在 `/srv/web` 底下
    const sibling = safeResolve(ROOT, '/../web-evil/x');
    expect(sibling).toBeNull();
  });

  it('根目錄本身可以', () => {
    expect(safeResolve(ROOT, '/')).toBe(ROOT);
  });

  it('解出來的一定在 root 底下', () => {
    for (const p of ['/a', '/a/b/c.js', '/中文.html']) {
      const r = safeResolve(ROOT, p);
      expect(r).not.toBeNull();
      expect(r === ROOT || r!.startsWith(ROOT + sep)).toBe(true);
    }
  });
});

/**
 * pdf.js 的資料檔（v0.24.1，閱讀器的「版面」檢視）。**同一套圍堵，再多兩道**：
 * 只准四個資料夾、檔名只准英數與 `._-`。
 */
describe('/pdfjs/:dir/:file', () => {
  async function server(): Promise<import('fastify').FastifyInstance> {
    const { default: Fastify } = await import('fastify');
    const { pdfjsRoot, registerPdfjsAssets } = await import('../../src/interface/http/static.js');
    const app = Fastify({ logger: false });
    registerPdfjsAssets(app, pdfjsRoot());
    return app;
  }

  it('給得出 CMap 與 wasm，wasm 的 MIME 是 application/wasm', async () => {
    const app = await server();
    const cmap = await app.inject({ method: 'GET', url: '/pdfjs/cmaps/UniGB-UCS2-H.bcmap' });
    expect(cmap.statusCode).toBe(200);
    expect(cmap.rawPayload.length).toBeGreaterThan(0);
    const wasm = await app.inject({ method: 'GET', url: '/pdfjs/wasm/openjpeg.wasm' });
    expect(wasm.statusCode).toBe(200);
    expect(wasm.headers['content-type']).toBe('application/wasm');
    await app.close();
  });

  it.each([
    '/pdfjs/build/pdf.mjs',
    '/pdfjs/cmaps/..%2f..%2fpackage.json',
    '/pdfjs/cmaps/%2e%2e',
    '/pdfjs/cmaps/nope.bcmap',
    '/pdfjs/..%2fbuild/pdf.mjs',
  ])('擋掉：%s', async (url) => {
    const app = await server();
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

it('路徑參數守門與靜態檔共存：JS、CSS 與巢狀 SPA 可載入，API 路徑穿越仍擋下', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'cyclosa-static-guard-'));
  const app = Fastify();
  try {
    await mkdir(join(folder, 'assets'));
    await writeFile(join(folder, 'index.html'), '<div id="app">fixture</div>');
    await writeFile(join(folder, 'assets/app.js'), 'export const ready=true;');
    await writeFile(join(folder, 'assets/app.css'), 'body { color: black; }');
    registerParamGuard(app);
    app.get<{ Params: { slug: string } }>('/api/cases/:slug/runs', async () => ({ ok: true }));
    registerStatic(app, folder);
    const script = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toContain('text/javascript');
    expect(script.body).toContain('export const ready');
    const css = await app.inject({ method: 'GET', url: '/assets/app.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    const spa = await app.inject({ method: 'GET', url: '/case/fixture/runs' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('id="app"');
    const unsafe = await app.inject({ method: 'GET', url: '/api/cases/..%2Fsecret/runs' });
    expect(unsafe.statusCode).toBe(404);
    expect(unsafe.json().correlationId).toBe('bad-slug');
    expect((await app.inject({ method: 'GET', url: '/api/missing' })).statusCode).toBe(404);
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});
