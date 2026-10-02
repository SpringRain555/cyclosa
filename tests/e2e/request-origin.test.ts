/**
 * 端對端：**別的網頁叫不動這個工具**（ADR-0036）。
 *
 * ## 它在修什麼（2026-10-02 查到的）
 *
 * - 跨站的 `text/plain` POST 不需要預檢，Fastify 預設的解析器把它交給路由 ——
 *   `POST /api/providers` 收到一個字串、解析成預設值，**把模型設定整份蓋掉**。
 * - DNS rebinding 之後什麼請求都送得出去：把 CLI 指令設成任意程式，下一次探針就會執行它。
 *
 * 判斷本身的每一種組合在 `tests/interface/request-guard.test.ts`；這一份驗的是
 * **它真的掛在 `buildServer()` 上**、被擋的請求**碰不到路由**（設定檔一個字都沒寫）。
 *
 * **完全隔離**：`LOCALAPPDATA` 與資料根都指到臨時目錄。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';

let sandbox: string;
let localAppData: string;
let app: FastifyInstance;
let saved: string | undefined;

/** CLI 不設（不 spawn）、Ollama 指到一個沒人聽的埠（不碰這台機器上真的 Ollama）。 */
const SETTINGS = {
  version: 2,
  connections: { cli: null, ollama: { baseUrl: 'http://127.0.0.1:9' }, openai: null },
  tasks: {},
};

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-origin-'));
  localAppData = join(sandbox, 'LocalAppData');
  await mkdir(localAppData, { recursive: true });
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = localAppData;

  const built = await buildServer();
  app = built.app;
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

async function providersFileExists(): Promise<boolean> {
  try {
    await access(join(localAppData, 'Cyclosa', 'providers.json'));
    return true;
  } catch {
    return false;
  }
}

describe('只收這個工具自己的頁面送來的請求', () => {
  it('啟動器的 /healthz（沒有 Origin）照常', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { host: '127.0.0.1:7433' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ app: 'cyclosa' });
  });

  it('**DNS rebinding**：Host 是別的網域 → 403，連讀的請求也擋', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/cases',
      headers: { host: 'evil.example:7433' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, code: 'IO_REQUEST_FOREIGN' });
  });

  it.each([
    ['別的網站', 'http://evil.example'],
    ['同一台機器別的埠', 'http://localhost:8080'],
    ['sandbox 的 iframe', 'null'],
  ])('跨站改設定（%s）→ 403，設定檔一個字都沒寫', async (_label, origin) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: { host: '127.0.0.1:7433', origin },
      payload: SETTINGS,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'IO_REQUEST_FOREIGN' });
    expect(await providersFileExists()).toBe(false);
  });

  it('Sec-Fetch-Site: cross-site（沒有 Origin）→ 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: { host: '127.0.0.1:7433', 'sec-fetch-site': 'cross-site' },
      payload: SETTINGS,
    });
    expect(res.statusCode).toBe(403);
    expect(await providersFileExists()).toBe(false);
  });

  it('**跨站的簡單請求**：text/plain 的 POST 碰不到路由（原本會把設定蓋成預設值）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: { host: '127.0.0.1:7433', 'content-type': 'text/plain' },
      payload: 'anything',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ ok: false, code: 'IO_REQUEST_FOREIGN' });
    expect(await providersFileExists()).toBe(false);
  });

  it('自己的頁面送的 POST（Origin ＝ http:// ＋ Host）照常寫入', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      headers: {
        host: '127.0.0.1:7433',
        origin: 'http://127.0.0.1:7433',
        'sec-fetch-site': 'same-origin',
      },
      payload: SETTINGS,
    });
    expect(res.statusCode).toBe(200);
    expect(await providersFileExists()).toBe(true);
  });

  it('Vite 代理（Host 與 Origin 都是 localhost:5173）照常', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/system/shutdown',
      headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
      payload: {},
    });
    // 沒帶 force 只回狀態 —— 這裡只要它過了守門、到得了路由
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { shuttingDown: false } });
  });
});
