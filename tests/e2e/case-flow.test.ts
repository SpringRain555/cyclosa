/**
 * 端對端：指標檔的四種失敗 → 設定資料根 → 建專題 → 清單。
 *
 * **完全隔離**：`LOCALAPPDATA` 與資料根都指到臨時目錄，
 * 所以這條測試碰不到使用者的真實資料 —— 那是不可違反的規則之一
 * （agent 與測試都不寫資料根）。
 *
 * 用 Fastify 的 `inject` 而不是真的 listen：不佔 7433，也不需要網路。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, open, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';

let sandbox: string;
let localAppData: string;
let dataRoot: string;
let app: FastifyInstance;
let savedLocalAppData: string | undefined;

async function boot(): Promise<void> {
  const built = await buildServer();
  app = built.app;
  await app.ready();
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-e2e-'));
  localAppData = join(sandbox, 'LocalAppData');
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(localAppData, { recursive: true });
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = localAppData;
});

afterEach(async () => {
  await app?.close();
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

describe('健康檢查', () => {
  it('回傳可辨識的 app 名稱 —— 單一實例偵測靠它', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ app: 'cyclosa' });
  });
});

describe('指標檔的四種失敗各自說得出原因', () => {
  it('指標檔不存在 → IO_POINTER_MISSING，而且帶著指標檔的位置', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/cases' });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('IO_POINTER_MISSING');
    // **不是一個空清單** —— 這是 REQ-0001 的驗收條件
    expect(body.data).toBeUndefined();
    expect(String(body.detail.pointerPath)).toContain('system_paths.json');
  });

  it('指標檔壞掉 → IO_POINTER_MALFORMED', async () => {
    await mkdir(join(localAppData, 'Cyclosa'), { recursive: true });
    await writeFile(join(localAppData, 'Cyclosa', 'system_paths.json'), '{ 這不是 JSON', 'utf8');
    await boot();
    const body = (await app.inject({ method: 'GET', url: '/api/cases' })).json();
    expect(body.code).toBe('IO_POINTER_MALFORMED');
    expect(String(body.detail.pointerPath)).toContain('system_paths.json');
  });

  it('缺 dataRoot 欄位也是 IO_POINTER_MALFORMED', async () => {
    await mkdir(join(localAppData, 'Cyclosa'), { recursive: true });
    await writeFile(
      join(localAppData, 'Cyclosa', 'system_paths.json'),
      JSON.stringify({ version: 1 }),
      'utf8',
    );
    await boot();
    expect((await app.inject({ method: 'GET', url: '/api/cases' })).json().code).toBe(
      'IO_POINTER_MALFORMED',
    );
  });

  it('指到的路徑不存在 → IO_DATA_ROOT_MISSING，而且同時說出指標檔在哪、它指到哪', async () => {
    await mkdir(join(localAppData, 'Cyclosa'), { recursive: true });
    const ghost = join(sandbox, 'this-does-not-exist');
    await writeFile(
      join(localAppData, 'Cyclosa', 'system_paths.json'),
      JSON.stringify({ version: 1, dataRoot: ghost, updatedAt: '' }),
      'utf8',
    );
    await boot();
    const body = (await app.inject({ method: 'GET', url: '/api/cases' })).json();
    expect(body.code).toBe('IO_DATA_ROOT_MISSING');
    // 「指標檔在哪、它指到哪、那個路徑怎麼了」是同一句話裡的三件事
    expect(String(body.detail.pointerPath)).toContain('system_paths.json');
    expect(String(body.detail.dataRoot)).toBe(ghost);
  });
});

describe('設定資料根 → 建專題 → 清單', () => {
  it('走完一整輪', async () => {
    await boot();

    // 1. 設定資料根
    const setup = await app.inject({
      method: 'POST',
      url: '/api/system/data-root',
      payload: { dataRoot },
    });
    expect(setup.statusCode).toBe(200);
    expect(setup.json().data.dataRoot).toBe(dataRoot);

    // 2. 一開始沒有專題 —— 這次是**真的空清單**，跟上面那種失敗不同
    const empty = await app.inject({ method: 'GET', url: '/api/cases' });
    expect(empty.json()).toMatchObject({ ok: true, data: [] });

    // 3. 建一個
    const created = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: { name: '蓬萊塵蛛的網上裝飾行為', seed: '塵蛛屬' },
    });
    expect(created.statusCode).toBe(200);
    const c = created.json().data;
    expect(c.name).toBe('蓬萊塵蛛的網上裝飾行為');
    // **中文保留原樣** —— 使用者要在檔案總管裡認得出來
    expect(c.slug).toBe('蓬萊塵蛛的網上裝飾行為');
    expect(c.status).toBe('new');
    expect(c.stats).toEqual({
      itemCount: 0,
      noteCount: 0,
      entityCount: 0,
      edgeCount: 0,
      pendingNamedEdgeCount: 0,
      lastRunAt: null,
    });

    // 4. 清單看得到它
    const list = await app.inject({ method: 'GET', url: '/api/cases' });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].slug).toBe(c.slug);
  });

  it('同名再建一次會被擋下來', async () => {
    await boot();
    await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
    await app.inject({ method: 'POST', url: '/api/cases', payload: { name: '重複' } });
    const again = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: { name: '重複' },
    });
    expect(again.json().code).toBe('CASE_NAME_DUPLICATE');
    expect(again.statusCode).toBe(409);
  });

  it('空名稱回 400', async () => {
    await boot();
    await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
    const res = await app.inject({ method: 'POST', url: '/api/cases', payload: { name: '   ' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CASE_NAME_EMPTY');
  });

  it('封存之後不能再封存，但可以重新開啟', async () => {
    await boot();
    await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
    const c = (
      await app.inject({ method: 'POST', url: '/api/cases', payload: { name: '封存測試' } })
    ).json().data;

    // new 狀態不能直接封存 —— 轉移表上沒有那一條
    const tooEarly = await app.inject({
      method: 'POST',
      url: `/api/cases/${encodeURIComponent(c.slug)}/status`,
      payload: { action: 'archive' },
    });
    expect(tooEarly.json().code).toBe('CASE_ARCHIVED');
  });

  it('找不到的專題回 404', async () => {
    await boot();
    await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/cases/nope/status',
      payload: { action: 'archive' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('CASE_NOT_FOUND');
  });
});

describe('API 的 404 不會回 HTML', () => {
  it('打不存在的 API 端點回 JSON —— 回 index.html 會讓前端在 JSON.parse 炸掉', async () => {
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(() => res.json()).not.toThrow();
  });
});

describe('改名：名稱與資料夾一起改', () => {
  async function makeCase(name: string): Promise<string> {
    const created = await app.inject({ method: 'POST', url: '/api/cases', payload: { name } });
    return (created.json() as { data: { slug: string } }).data.slug;
  }

  async function rename(slug: string, name: string) {
    return app.inject({ method: 'POST', url: `/api/cases/${slug}/rename`, payload: { name } });
  }

  beforeEach(async () => {
    await boot();
    await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
  });

  it('資料夾真的被搬走了 —— 舊的不在，新的在', async () => {
    const slug = await makeCase('點註驗收');
    const res = await rename(slug, '蓬萊塵蛛的網上裝飾行為');
    expect(res.statusCode).toBe(200);

    const data = res.json().data as { slug: string; name: string };
    expect(data.name).toBe('蓬萊塵蛛的網上裝飾行為');
    expect(data.slug).toBe('蓬萊塵蛛的網上裝飾行為');

    const cases = join(dataRoot, 'cases');
    const dirs = await readdir(cases);
    expect(dirs).toContain('蓬萊塵蛛的網上裝飾行為');
    expect(dirs).not.toContain('點註驗收');
  });

  it('資料還在裡面 —— 搬的是資料夾，不是重建一個', async () => {
    const slug = await makeCase('原本的名字');
    await rename(slug, '改過的名字');
    const db = join(dataRoot, 'cases', '改過的名字', 'case.sqlite');
    await expect(stat(db)).resolves.toBeDefined();
  });

  it('清單上只會有一個，而且是新名字', async () => {
    const slug = await makeCase('原本的名字');
    await rename(slug, '改過的名字');
    const list = await app.inject({ method: 'GET', url: '/api/cases' });
    const rows = (list.json() as { data: { name: string }[] }).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('改過的名字');
  });

  it('改成一個已經存在的名字會被擋下來，而且兩個都沒被動到', async () => {
    await makeCase('甲專題');
    const slug = await makeCase('乙專題');
    const res = await rename(slug, '甲專題');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CASE_NAME_DUPLICATE');

    const dirs = await readdir(join(dataRoot, 'cases'));
    expect(dirs.sort()).toEqual(['乙專題', '甲專題']);
  });

  it('空名字擋下來', async () => {
    const slug = await makeCase('原本的名字');
    const res = await rename(slug, '   ');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('CASE_NAME_EMPTY');
  });

  it('只有標點不同、slug 一樣的話，資料夾不動而名字改得掉', async () => {
    // 斜線在檔名裡不合法，`toSlug` 會把它換掉 —— 所以這兩個名字的 slug 相同。
    const slug = await makeCase('甲 / 乙');
    const res = await rename(slug, '甲 : 乙');
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { slug: string; name: string };
    expect(data.slug).toBe(slug);
    expect(data.name).toBe('甲 : 乙');
  });

  it('已封存的改不了 —— 改名是一次改動', async () => {
    const slug = await makeCase('要封存的');
    // **狀態機只允許 `ready → archived`**，而要走到 `ready` 得先真的跑一次作業。
    // 這一條測的是改名對封存的反應，不是狀態機本身（那在 domain 測過了），
    // 所以直接把狀態寫進去。
    const opened = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'));
    if (opened.kind !== 'ok') throw new Error(opened.kind);
    opened.db.prepare("UPDATE \"case\" SET status = 'archived' WHERE id = 'self'").run();
    opened.db.close();

    const res = await rename(slug, '新名字');
    expect(res.json().code).toBe('CASE_ARCHIVED');

    // **資料夾沒有被動到。**
    const dirs = await readdir(join(dataRoot, 'cases'));
    expect(dirs).toEqual(['要封存的']);
  });

  it('資料夾被開著的時候搬不動 —— 回 CASE_RENAME_BLOCKED，而且什麼都沒動', async () => {
    const slug = await makeCase('正在被使用的');
    // Windows 上開著資料夾裡任何一個檔案，那個資料夾就搬不動。
    // **這條路只有作業系統會觸發**，所以它需要一個真的檔案握把。
    const held = await open(join(dataRoot, 'cases', slug, 'case.sqlite'), 'r');
    try {
      const res = await rename(slug, '新名字');
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CASE_RENAME_BLOCKED');

      // **名字也沒有被改掉** —— 先搬資料夾再改名字，所以失敗時兩邊都還是原樣。
      const list = await app.inject({ method: 'GET', url: '/api/cases' });
      const rows = (list.json() as { data: { name: string; slug: string }[] }).data;
      expect(rows[0]?.name).toBe('正在被使用的');
      expect(rows[0]?.slug).toBe(slug);
    } finally {
      await held.close();
    }
  });

  it('不存在的專題回 404', async () => {
    const res = await rename('沒有這個', '新名字');
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('CASE_NOT_FOUND');
  });
});
