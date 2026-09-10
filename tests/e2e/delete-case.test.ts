/**
 * 端對端：**刪除專題**，以及順帶接上按鈕的**封存／重新開啟**。
 *
 * ## 為什麼是 e2e
 *
 * 刪除的守門是「逐字打對名稱」，而**那個比對在伺服器端** ——
 * 只在畫面上比的話它是一個繞得過的門。「沒帶名字什麼都不動」
 * 與「名字錯了什麼都不動」這兩件事，只有真的打過那一支端點才驗得到。
 *
 * **完全隔離**：`LOCALAPPDATA` 與資料根都指到臨時目錄。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';

let sandbox: string;
let localAppData: string;
let dataRoot: string;
let app: FastifyInstance;
let saved: string | undefined;
let slug: string;

const NAME = '要刪掉的專題';

interface CaseDeletion {
  name: string;
  stats: { itemCount: number; noteCount: number; entityCount: number; edgeCount: number };
  bytes: number;
  done: boolean;
  movedTo: string | null;
}

interface Envelope {
  ok: boolean;
  code?: string;
  data?: CaseDeletion;
}

async function del(confirmName: string | null): Promise<{ code: number; body: Envelope }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/cases/${encodeURIComponent(slug)}/delete`,
    payload: confirmName === null ? {} : { confirmName },
  });
  return { code: res.statusCode, body: res.json() };
}

async function caseSlugs(): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: '/api/cases' });
  return (res.json() as { data: { slug: string }[] }).data.map((c) => c.slug);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-del-'));
  localAppData = join(sandbox, 'LocalAppData');
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(localAppData, { recursive: true });
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = localAppData;

  const built = await buildServer();
  app = built.app;
  await app.ready();
  await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
  const made = await app.inject({ method: 'POST', url: '/api/cases', payload: { name: NAME } });
  slug = (made.json() as { data: { slug: string } }).data.slug;
});

afterEach(async () => {
  await app?.close();
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

describe('刪除專題', () => {
  it('沒帶名字只回「你會失去什麼」，**一個檔都不動**', async () => {
    const { body } = await del(null);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    const data = body.data as CaseDeletion;
    expect(data.done).toBe(false);
    expect(data.movedTo).toBeNull();
    expect(data.name).toBe(NAME);

    // 專題還在，而且 backups\ 裡沒有多出東西。
    expect(await caseSlugs()).toContain(slug);
    expect(await readdir(join(dataRoot, 'backups'))).toEqual([]);
  });

  it('名字打錯 → CASE_NAME_MISMATCH，而且什麼都沒動', async () => {
    const { body } = await del(NAME + '一');
    expect(body.ok).toBe(false);
    expect(body.code).toBe('CASE_NAME_MISMATCH');
    expect(await caseSlugs()).toContain(slug);
    expect(await readdir(join(dataRoot, 'backups'))).toEqual([]);
  });

  it('空字串不算「跳過確認」 —— 它就是一個打錯的名字', async () => {
    // **這一條是那道門的邊界。** `''` 與 `null` 在 JSON 上很近，
    // 而它們的意思相反：一個是「我確認」，一個是「先問問看」。
    const { body } = await del('');
    expect(body.ok).toBe(false);
    expect(body.code).toBe('CASE_NAME_MISMATCH');
    expect(await caseSlugs()).toContain(slug);
  });

  it('打對了才真的刪，而且資料夾搬進 backups\\', async () => {
    const { body } = await del(NAME);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    const data = body.data as CaseDeletion;
    expect(data.done).toBe(true);

    // app 這一側：清單上沒有它了。
    expect(await caseSlugs()).not.toContain(slug);
    expect(await readdir(join(dataRoot, 'cases'))).toEqual([]);

    // 磁碟這一側：**東西還在**，在 backups\ 底下一個帶時間戳的資料夾裡。
    const kept = await readdir(join(dataRoot, 'backups'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^deleted-/);
    expect(String(data.movedTo)).toContain(kept[0] as string);
    // 而且它是**整個專題資料夾**，不是只有一個 .sqlite。
    expect(await readdir(join(dataRoot, 'backups', kept[0] as string))).toContain('case.sqlite');
  });

  it('前後空白會被 trim —— 貼上來的名字常常帶一個空白', async () => {
    const { body } = await del(`  ${NAME}  `);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(await caseSlugs()).not.toContain(slug);
  });

  it('刪同名專題兩次不會互相蓋掉 —— 時間戳在資料夾名字裡', async () => {
    await del(NAME);
    const again = await app.inject({ method: 'POST', url: '/api/cases', payload: { name: NAME } });
    slug = (again.json() as { data: { slug: string } }).data.slug;
    const { body } = await del(NAME);
    expect(body.ok, JSON.stringify(body)).toBe(true);

    expect(await readdir(join(dataRoot, 'backups'))).toHaveLength(2);
  });

  it('回報的大小含 sources\\ 裡的東西，不是只有資料庫', async () => {
    // **`sources\` 通常就是大部分。** 只算 `case.sqlite` 的話，
    // 畫面上會對一個 4 GB 的專題說「佔 200 KB」。
    const bare = ((await del(null)).body.data as CaseDeletion).bytes;
    await mkdir(join(dataRoot, 'cases', slug, 'sources'), { recursive: true });
    await writeFile(join(dataRoot, 'cases', slug, 'sources', 'big.bin'), Buffer.alloc(200_000));

    expect(((await del(null)).body.data as CaseDeletion).bytes).toBeGreaterThan(bare + 190_000);
  });

  it('刪掉的專題再刪一次 → CASE_NOT_FOUND', async () => {
    await del(NAME);
    const { body } = await del(NAME);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('CASE_NOT_FOUND');
  });
});

describe('封存與重新開啟', () => {
  async function status(action: 'archive' | 'reopen'): Promise<{ ok: boolean; code?: string }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/cases/${encodeURIComponent(slug)}/status`,
      payload: { action },
    });
    return res.json() as { ok: boolean; code?: string };
  }

  it('封存之後清單上的狀態就是已封存', async () => {
    expect((await status('archive')).ok).toBe(true);
    const res = await app.inject({ method: 'GET', url: '/api/cases' });
    expect((res.json() as { data: { status: string }[] }).data[0]?.status).toBe('archived');
  });

  it('重新開啟之後又可以改動了', async () => {
    await status('archive');
    // 封存的不能改名 —— 這是「已封存」這個狀態的全部意義。
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/cases/${encodeURIComponent(slug)}/rename`,
      payload: { name: '新名字' },
    });
    expect(blocked.json().code).toBe('CASE_ARCHIVED');

    expect((await status('reopen')).ok).toBe(true);
    const okNow = await app.inject({
      method: 'POST',
      url: `/api/cases/${encodeURIComponent(slug)}/rename`,
      payload: { name: '新名字' },
    });
    expect(okNow.json().ok, okNow.body).toBe(true);
  });

  /**
   * **已封存的專題刪得掉。**
   *
   * 這裡刻意不套 `assertMutable`：封存的意思是「不再改動它的內容」，
   * 而刪除不是一次改動 —— 「封存起來，過一陣子確定不要了再刪」
   * 本來就是那兩個狀態最常見的走法。
   */
  it('已封存的專題刪得掉', async () => {
    await status('archive');
    const { body } = await del(NAME);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(await caseSlugs()).not.toContain(slug);
  });
});
