/**
 * 孤兒作業的掃除。
 *
 * **它修的是一個沒有症狀像 bug 的 bug**：程式被強制結束之後，
 * 資料庫裡那一列留在 `執行中`，而畫面上它看起來只是「一個沒跑完的作業」。
 * 實際上它連取消都取消不掉（取消端點問的是記憶體裡的執行表），
 * 而且它會讓**之後每一次搜尋**都掛一句「有作業還在跑」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import {
  insertCase,
  readCase,
  updateCaseStatus,
} from '../../src/infrastructure/db/repositories/case-repo.js';
import { hasRunningRun } from '../../src/infrastructure/index/reader.js';
import { forgetSwept, sweepStaleRuns } from '../../src/application/run-sweep.js';
import { register, unregister } from '../../src/application/run-registry.js';

let sandbox: string;
let db: DatabaseSync;

async function openDb(): Promise<DatabaseSync> {
  const opened = await openCaseDatabase(join(sandbox, 'case.sqlite'), { create: true });
  if (opened.kind !== 'ok') throw new Error(`開不起來：${opened.kind}`);
  return opened.db;
}

function insertRunning(id: string): void {
  runs.insertRun(db, {
    id,
    kind: 'import',
    label: '測試',
    total: 2,
    correlationId: 'cid',
    now: Date.now(),
  });
  runs.insertRunItem(db, { id: `${id}-a`, runId: id, requested: 'https://例.tw/1', host: '例.tw' });
  runs.startRun(db, id, Date.now());
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-sweep-'));
  db = await openDb();
  insertCase(db, { name: '測試專題', seed: null, now: Date.now() });
  forgetSwept();
});

afterEach(async () => {
  db.close();
  forgetSwept();
  await rm(sandbox, { recursive: true, force: true });
});

describe('掃掉上一次沒有收尾的作業', () => {
  it('留在「執行中」的那一列會變成已取消，而且說得出是為什麼', () => {
    insertRunning('r1');
    expect(sweepStaleRuns(db, '測試專題')).toBe(1);

    const row = runs.getRun(db, 'r1');
    expect(row?.status).toBe('cancelled');
    // **這一欄就是「你按了取消」與「上次沒有正常關閉」的差別。**
    // 少了它，畫面上兩者長得一模一樣。
    expect(row?.endedReason).toBe('stale');
    expect(row?.endedAt).not.toBeNull();
  });

  it('沒處理完的項目也要標成已取消，不是留在排隊中', () => {
    insertRunning('r1');
    sweepStaleRuns(db, '測試專題');
    expect(runs.listRunItems(db, 'r1').map((i) => i.outcome)).toEqual(['cancelled']);
  });

  it('掃完之後搜尋不再宣稱「有作業還在跑」', () => {
    insertRunning('r1');
    // 這是使用者真的會遇到的症狀：**每一次搜尋**都掛一句結果可能不完整。
    expect(hasRunningRun(db)).toBe(true);
    sweepStaleRuns(db, '測試專題');
    expect(hasRunningRun(db)).toBe(false);
  });

  it('本行程正在跑的作業不算孤兒', () => {
    insertRunning('r1');
    register('r1');
    try {
      expect(sweepStaleRuns(db, '測試專題')).toBe(0);
      expect(runs.getRun(db, 'r1')?.status).toBe('running');
    } finally {
      unregister('r1');
    }
  });

  it('同一個專題只掃一次 —— 之後開資料庫不再付這個成本', () => {
    insertRunning('r1');
    expect(sweepStaleRuns(db, '測試專題')).toBe(1);
    insertRunning('r2');
    expect(sweepStaleRuns(db, '測試專題')).toBe(0);
    // 第二列是這個行程自己剛建的，掃描不該碰它 —— 它本來就還沒收尾。
    expect(runs.getRun(db, 'r2')?.status).toBe('running');
  });

  it.each(['import', 'extract', 'research', 'consolidate'] as const)(
    '排隊中的 %s 作業不能被掃掉 —— 那個狀態撐得過重新啟動',
    (kind) => {
      runs.insertRun(db, {
        id: 'e1',
        kind,
        label: '測試',
        total: 0,
        correlationId: 'cid',
        now: Date.now(),
        topic: '主題',
      });

      expect(sweepStaleRuns(db, '測試專題')).toBe(0);
      expect(runs.getRun(db, 'e1')?.status).toBe('queued');
    },
  );

  it('已經收尾的作業一列都不動', () => {
    insertRunning('r1');
    runs.settleRunRow(db, { id: 'r1', status: 'done', succeeded: 1, failed: 0, now: Date.now() });
    expect(sweepStaleRuns(db, '測試專題')).toBe(0);
    expect(runs.getRun(db, 'r1')?.status).toBe('done');
    expect(runs.getRun(db, 'r1')?.endedReason).toBeNull();
  });
});

/**
 * **卡在「蒐集中」的專題**（v0.17.0 找到的第二個症狀）。
 *
 * 專題狀態在作業開始時寫成 `collecting`、結束時寫回 `ready`，
 * 而**兩邊都在行程裡** —— 行程沒機會跑完第二步就死掉，那一列永遠留著。
 *
 * 它到 v0.17.0 才被看見，因為在這之前**沒有任何按鈕會讀這個欄位**：
 * 封存的 API 從 v0.1.0 就在，而它零個呼叫點。
 */
describe('把卡在「蒐集中」的專題放回「就緒」', () => {
  it('沒有作業在跑的時候會放回去', () => {
    updateCaseStatus(db, 'collecting', Date.now());
    sweepStaleRuns(db, '測試專題');
    expect(readCase(db)?.status).toBe('ready');
  });

  /**
   * **這一條是這個修復真正要涵蓋的路。**
   *
   * v0.14.0 的正常關閉會把作業寫成 `已取消`，於是孤兒掃描
   * 一列都掃不到 —— 舊的實作在那裡直接早退，而專題仍然停在 `collecting`。
   * 也就是說**那條修好的路反而繞過了這個修復**。
   */
  it('作業已經是「已取消」（正常關閉留下的）也要放回去 —— 掃不到東西不等於沒事', () => {
    insertRunning('r1');
    runs.settleRunRow(db, {
      id: 'r1',
      status: 'cancelled',
      succeeded: 0,
      failed: 0,
      now: Date.now(),
    });
    updateCaseStatus(db, 'collecting', Date.now());

    expect(sweepStaleRuns(db, '測試專題')).toBe(0);
    expect(readCase(db)?.status).toBe('ready');
  });

  it('這個行程真的還有作業在跑的時候不動它 —— 那時候「蒐集中」是對的', () => {
    insertRunning('r1');
    register('r1');
    updateCaseStatus(db, 'collecting', Date.now());
    try {
      sweepStaleRuns(db, '測試專題');
      expect(readCase(db)?.status).toBe('collecting');
    } finally {
      unregister('r1');
    }
  });

  it('不是「蒐集中」的專題一個字都不改', () => {
    // 已封存的專題不能被這條路悄悄改回「就緒」——
    // 那會讓一個使用者明確封存過的東西自己解除封存。
    updateCaseStatus(db, 'archived', Date.now());
    sweepStaleRuns(db, '測試專題');
    expect(readCase(db)?.status).toBe('archived');
  });
});
