/**
 * 端對端：**換一個資料根，而且既有的東西跟著搬過去。**
 *
 * ## 為什麼是 e2e
 *
 * 這件事的失敗模式全部在檔案系統上，而不在型別上：
 * 搬進自己底下、蓋掉別人的資料夾、搬完之後指標檔指到哪。
 * **「搬失敗的時候什麼都沒動」只有真的動過檔案才驗得到。**
 *
 * **完全隔離**：`LOCALAPPDATA` 與資料根都指到臨時目錄。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { moveDataRoot } from '../../src/application/bootstrap-service.js';

let sandbox: string;
let localAppData: string;
let dataRoot: string;
let app: FastifyInstance;
let saved: string | undefined;

interface Envelope {
  ok: boolean;
  code?: string;
  data?: { dataRoot: string };
  detail?: Record<string, unknown>;
}

async function move(to: string): Promise<{ code: number; body: Envelope }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/system/data-root/move',
    payload: { dataRoot: to },
  });
  return { code: res.statusCode, body: res.json() };
}

async function caseNames(): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: '/api/cases' });
  return (res.json() as { data: { name: string }[] }).data.map((c) => c.name);
}

async function pointerTarget(): Promise<string> {
  const raw = await readFile(join(localAppData, 'Cyclosa', 'system_paths.json'), 'utf8');
  return (JSON.parse(raw) as { dataRoot: string }).dataRoot;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-move-'));
  localAppData = join(sandbox, 'LocalAppData');
  dataRoot = join(sandbox, 'Before');
  await mkdir(localAppData, { recursive: true });
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = localAppData;

  const built = await buildServer();
  app = built.app;
  await app.ready();
  await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
  await app.inject({ method: 'POST', url: '/api/cases', payload: { name: '既有專題' } });
});

afterEach(async () => {
  await app?.close();
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

describe('換一個資料根', () => {
  it('既有的專題跟著過去 —— 搬完清單上的數目一樣', async () => {
    const to = join(sandbox, 'After');
    const { body } = await move(to);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.data?.dataRoot).toBe(to);

    // **這是這個功能存在的全部理由。** 只改指標檔的話這裡會是空的。
    expect(await caseNames()).toEqual(['既有專題']);

    // 舊的地方**沒有留下一份**，指標檔指著新的。
    await expect(readdir(join(sandbox, 'Before'))).rejects.toThrow();
    expect(await pointerTarget()).toBe(to);
  });

  it('搬完之後五個頂層資料夾都在', async () => {
    const to = join(sandbox, 'After');
    await move(to);
    expect((await readdir(to)).sort()).toEqual(['backups', 'cases', 'exports', 'logs', 'tmp']);
  });

  it('目標還不存在也可以 —— 連中間那幾層一起建起來', async () => {
    const to = join(sandbox, '深', '一點', 'After');
    expect((await move(to)).body.ok).toBe(true);
    expect(await caseNames()).toEqual(['既有專題']);
  });

  it('搬到現在這個位置 → same，什麼都不動', async () => {
    const { body } = await move(dataRoot);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('IO_DATA_ROOT_TARGET_INVALID');
    expect(body.detail?.['reason']).toBe('same');
    expect(await caseNames()).toEqual(['既有專題']);
  });

  /**
   * **把一個資料夾搬進它自己底下**是這裡最容易寫錯的一條。
   *
   * 它在檔案系統上不是一個乾淨的失敗 —— 有些平台會直接開始搬，
   * 然後在自己造出來的無限深度上失敗，而那時候資料已經動過了。
   * 所以這一條要**在動任何一個檔案之前**擋掉。
   */
  it('搬進自己底下 → nested，而且是在動任何檔案之前擋掉', async () => {
    const { body } = await move(join(dataRoot, '子資料夾'));
    expect(body.ok).toBe(false);
    expect(body.detail?.['reason']).toBe('nested');
    // 原本的東西一個都沒少。
    expect((await readdir(dataRoot)).sort()).toEqual([
      'backups',
      'cases',
      'exports',
      'logs',
      'tmp',
    ]);
    expect(await caseNames()).toEqual(['既有專題']);
  });

  it('名字開頭一樣但不是子資料夾的不算 nested', async () => {
    // `…\Before2` 不在 `…\Before` 底下。**用分隔符結尾比對**才分得出來，
    // 光比字首會把它誤判成子孫，而使用者會得到一句沒道理的拒絕。
    const to = dataRoot + '2';
    expect((await move(to)).body.ok, `搬到 ${to}`).toBe(true);
    expect(await caseNames()).toEqual(['既有專題']);
  });

  it('目標已經有東西 → not-empty，不覆蓋', async () => {
    const to = join(sandbox, 'Occupied');
    await mkdir(to, { recursive: true });
    await writeFile(join(to, '別人的東西.txt'), 'x', 'utf8');

    const { body } = await move(to);
    expect(body.ok).toBe(false);
    expect(body.detail?.['reason']).toBe('not-empty');
    // **那個「別人」很可能是使用者的另一份資料。**
    expect(await readdir(to)).toEqual(['別人的東西.txt']);
    expect(await caseNames()).toEqual(['既有專題']);
  });

  it('目標是一個空資料夾可以用', async () => {
    const to = join(sandbox, 'EmptyButThere');
    await mkdir(to, { recursive: true });
    expect((await move(to)).body.ok).toBe(true);
    expect(await caseNames()).toEqual(['既有專題']);
  });

  it('空字串是 400，不是一個要去搬的路徑', async () => {
    const { code, body } = await move('   ');
    expect(code).toBe(400);
    expect(body.ok).toBe(false);
  });

  it('失敗的時候指標檔一個字都沒改', async () => {
    await move(join(dataRoot, '子資料夾'));
    expect(await pointerTarget()).toBe(dataRoot);
  });

  /**
   * **有作業在跑就不准搬。**
   *
   * 走端點的話要真的起一個抓取才能讓 `activeCount()` 不是 0，
   * 而那會把這條測試變成一條網路測試。守門的判斷本身是一個參數，
   * 所以直接餵給它 —— 端點那一側把 `activeCount()` 接上去的那一行
   * 在 `routes.ts` 裡只有一句。
   */
  it('有作業在跑的時候擋下來，而且說出有幾個', async () => {
    const r = await moveDataRoot(dataRoot, join(sandbox, 'After'), 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('IO_DATA_ROOT_BUSY');
    expect(r.detail?.['activeRuns']).toBe(2);
    // 一個檔都沒動。
    expect(await caseNames()).toEqual(['既有專題']);
  });
});
