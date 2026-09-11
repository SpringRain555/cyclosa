/**
 * 端對端：**整個專題全部標成未讀。**
 *
 * ## 為什麼是 e2e
 *
 * 這個動作沒有回頭路，而它的守門（二次確認）**在伺服器端** ——
 * 沒帶 `force` 的呼叫必須什麼都不改。只在畫面上擋的話，那是一個繞得過的提醒。
 * 「什麼都不改」這件事只有真的打過那一支端點才驗得到。
 *
 * **完全隔離**：`LOCALAPPDATA` 與資料根都指到臨時目錄。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import * as items from '../../src/infrastructure/db/repositories/item-repo.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import { readCase } from '../../src/infrastructure/db/repositories/case-repo.js';

let sandbox: string;
let localAppData: string;
let dataRoot: string;
let app: FastifyInstance;
let saved: string | undefined;
let slug: string;

interface ReadReset {
  read: number;
  cleared: number;
  done: boolean;
}

async function post(force: boolean): Promise<ReadReset> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/cases/${encodeURIComponent(slug)}/items/unread-all`,
    payload: { force },
  });
  const body = res.json() as { ok: boolean; data: ReadReset };
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return body.data;
}

/** 直接在資料庫裡放幾份資料，其中 `read` 份標成已讀。 */
async function seed(total: number, read: number): Promise<void> {
  const opened = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  const db = opened.db;
  try {
    expect(readCase(db)).not.toBeNull();
    runs.insertRun(db, {
      id: 'r1',
      kind: 'import',
      label: '測試',
      total,
      correlationId: 'cid',
      now: Date.now(),
    });
    for (let i = 0; i < total; i++) {
      items.insertPendingItem(db, {
        id: `i${i}`,
        kind: 'web',
        requestedUrl: `https://例.tw/${i}`,
        title: `第 ${i} 份`,
        runId: 'r1',
        now: Date.now(),
      });
      if (i < read) items.setReadAt(db, `i${i}`, Date.now());
    }
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-unread-'));
  localAppData = join(sandbox, 'LocalAppData');
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(localAppData, { recursive: true });
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = localAppData;

  const built = await buildServer();
  app = built.app;
  await app.ready();
  await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
  const made = await app.inject({
    method: 'POST',
    url: '/api/cases',
    payload: { name: '未讀測試' },
  });
  slug = (made.json() as { data: { slug: string } }).data.slug;
});

afterEach(async () => {
  await app?.close();
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

describe('全部標成未讀', () => {
  it('沒帶 force 的呼叫只回數字，**一列都不改**', async () => {
    await seed(5, 3);

    const probe = await post(false);
    expect(probe).toEqual({ read: 3, cleared: 0, done: false });

    // 再問一次還是 3 —— 上一次真的什麼都沒做。
    expect((await post(false)).read).toBe(3);
  });

  it('帶了 force 才真的清，而且回報清了幾份', async () => {
    await seed(5, 3);

    const done = await post(true);
    expect(done).toEqual({ read: 3, cleared: 3, done: true });

    // 清完之後就沒有已讀了。
    expect((await post(false)).read).toBe(0);
  });

  it('回報的是「真的被清掉幾份」，不是「這個專題有幾份」', async () => {
    // **兩個數字在畫面上是兩句不同的話。** 5 份資料、只有 1 份讀過，
    // 那句話要說 1 不是 5。
    await seed(5, 1);
    expect((await post(true)).cleared).toBe(1);
  });

  it('一份都沒讀過的時候是 0，不是錯誤', async () => {
    await seed(4, 0);
    expect(await post(false)).toEqual({ read: 0, cleared: 0, done: false });
    expect((await post(true)).cleared).toBe(0);
  });

  it('不會把專題推到清單最上面 —— 已讀是關於你的事實，不是關於這份資料的', async () => {
    await seed(3, 3);
    const before = await app.inject({ method: 'GET', url: '/api/cases' });
    const at = (before.json() as { data: { updatedAt: number }[] }).data[0]?.updatedAt;

    await post(true);

    const after = await app.inject({ method: 'GET', url: '/api/cases' });
    expect((after.json() as { data: { updatedAt: number }[] }).data[0]?.updatedAt).toBe(at);
  });

  it('找不到的專題會失敗，不是安靜地成功', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cases/沒有這個專題/items/unread-all',
      payload: { force: true },
    });
    /**
     * **現在釘住了。** 2026-09-10 寫這條的時候刻意不釘那個碼 ——
     * 那時這一支（還有 `markRead`、`rebuild` 在內的十幾支）一律回
     * `IO_UNEXPECTED`（500），而釘死 500 等於把那個錯誤變成規格。
     *
     * 2026-09-11 `openCaseDatabase` 多了一個 `missing` 的結果之後，
     * 它回的就是它該回的。**跨端點的那一張表在 `case-not-found.test.ts`。**
     */
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, code: 'CASE_NOT_FOUND' });
  });
});
