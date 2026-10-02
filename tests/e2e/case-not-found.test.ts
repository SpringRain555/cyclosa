/**
 * 端對端：**不存在的專題，每一支端點都說「找不到」，而且什麼都不寫。**
 *
 * ## 它在修什麼
 *
 * 2026-09-10 實測：不存在的 slug 在 `markRead`、`rebuild`、`unread-all`
 * 上**一律回 `IO_UNEXPECTED`（500）**。`openCaseDatabase` 在一個不存在的資料夾裡
 * 開檔就直接丟例外，走不到任何一個「這個專題不存在」的分支 ——
 * 使用者看到「出了預期外的問題」，而我們其實完全知道發生了什麼事。
 *
 * 查下去還有第二半，而它更糟：**資料夾在、檔案不在的時候，
 * `new DatabaseSync()` 會悄悄建一個新的空資料庫**。畫面上答對了，
 * 資料根裡卻多了一個沒有人要的 `case.sqlite` —— 而來源清單的狀態彙整
 * （`historyByHost()`）每一次都會逐一打開 `cases\` 底下的每個資料夾。
 *
 * ## 為什麼是一張表
 *
 * 這個錯是**跨十幾支端點**的，因為每個 service 各有一份 `withCase`。
 * 只測修掉的那三支，第四支就會在下一次有人抄 `withCase` 的時候長回來。
 *
 * **完全隔離**：`LOCALAPPDATA` 與資料根都指到臨時目錄。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';

let sandbox: string;
let localAppData: string;
let dataRoot: string;
let app: FastifyInstance;
let saved: string | undefined;

const GHOST = '沒有這個專題';

/**
 * 每一支專題範圍的端點各一個代表。**讀與寫都要有** ——
 * 寫的那些原本的失敗方式不一樣（有的在 service 裡，有的在 run 登記之前）。
 */
const ENDPOINTS: ReadonlyArray<{
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly payload?: Record<string, unknown>;
}> = [
  { method: 'GET', path: 'items' },
  { method: 'GET', path: 'items/i1' },
  { method: 'GET', path: 'items/i1/content' },
  { method: 'POST', path: 'items/i1/read', payload: { read: true } },
  { method: 'POST', path: 'items/unread-all', payload: { force: true } },
  { method: 'GET', path: 'notes' },
  { method: 'GET', path: 'runs' },
  { method: 'GET', path: 'notices' },
  { method: 'POST', path: 'notices/missing/dismiss' },
  { method: 'GET', path: 'queue' },
  { method: 'GET', path: 'edges/e1' },
  { method: 'GET', path: 'subgraph/focus' },
  { method: 'GET', path: 'subgraph/size?focus=x&hops=1' },
  { method: 'GET', path: 'subgraph?focus=x&hops=1' },
  { method: 'GET', path: 'entities/merges' },
  { method: 'GET', path: 'search?q=法律' },
  { method: 'POST', path: 'rebuild' },
  { method: 'POST', path: 'status', payload: { action: 'archive' } },
  { method: 'POST', path: 'rename', payload: { name: '新名字' } },
  { method: 'POST', path: 'delete', payload: { confirmName: null } },
];

async function hit(e: (typeof ENDPOINTS)[number]): Promise<{ status: number; code?: string }> {
  const res = await app.inject({
    method: e.method,
    url: `/api/cases/${encodeURIComponent(GHOST)}/${e.path}`,
    ...(e.payload !== undefined ? { payload: e.payload } : {}),
  });
  const body = res.json() as { ok: boolean; code?: string };
  return { status: res.statusCode, ...(body.code !== undefined ? { code: body.code } : {}) };
}

/** 資料根底下所有叫 `case.sqlite` 的檔案（遞迴）。 */
async function databasesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.startsWith('case.sqlite')) {
      out.push(join(entry.parentPath, entry.name));
    }
  }
  return out;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-notfound-'));
  localAppData = join(sandbox, 'LocalAppData');
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(localAppData, { recursive: true });
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = localAppData;

  const built = await buildServer();
  app = built.app;
  await app.ready();
  await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
});

afterEach(async () => {
  await app?.close();
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

describe('不存在的專題', () => {
  it.each(ENDPOINTS)('$method $path → 404 CASE_NOT_FOUND', async (e) => {
    const got = await hit(e);
    expect(got, `${e.method} ${e.path}`).toEqual({ status: 404, code: 'CASE_NOT_FOUND' });
  });

  /**
   * **資料夾在、檔案不在** —— 原本會悄悄建一個空資料庫的那一種。
   *
   * 這個情境是真的會出現的：刪除搬到一半被中斷、使用者手動清掉檔案、
   * 或者某個外部同步工具只同步了資料夾結構。
   */
  it('資料夾在而資料庫不在時，一樣是 404，而且不會建出一個 case.sqlite', async () => {
    await mkdir(join(dataRoot, 'cases', GHOST), { recursive: true });
    const before = await databasesUnder(dataRoot);

    for (const e of ENDPOINTS) {
      const got = await hit(e);
      expect(got, `${e.method} ${e.path}`).toEqual({ status: 404, code: 'CASE_NOT_FOUND' });
    }

    expect(await databasesUnder(dataRoot)).toEqual(before);
  });

  /**
   * **來源清單的狀態彙整會走過 `cases\` 底下的每個資料夾。**
   *
   * 修之前，一個殘留的空資料夾會在每一次打開「來源網站」分頁時被寫進一個
   * `case.sqlite` —— 從一個唯讀的畫面裡。
   *
   * > **這條測試的第一版打的是 `GET /api/system/sample`，而那一支不存在。**
   * > 它照樣是綠的：404 小於 500，而且什麼都沒被打開。
   * > 寫它的人（2026-09-11）以為 `sampleExists()` 每次啟動都會跑，
   * > 查下去它**零個呼叫點** —— 是 v0.17.0 寫了而從來沒接上的。
   * > 注入舊行為的時候這條沒有紅，才發現它什麼都沒測到。
   */
  it('來源清單與專題清單走過一個空資料夾，不會在裡面寫任何東西', async () => {
    await mkdir(join(dataRoot, 'cases', '殘留的空資料夾'), { recursive: true });

    const list = await app.inject({ method: 'GET', url: '/api/cases' });
    expect(list.statusCode).toBe(200);
    const sources = await app.inject({ method: 'GET', url: '/api/sources' });
    expect(sources.statusCode).toBe(200);

    expect(await databasesUnder(dataRoot)).toEqual([]);
  });
});
