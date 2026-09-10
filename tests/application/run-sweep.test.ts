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
import { insertCase } from '../../src/infrastructure/db/repositories/case-repo.js';
import { hasRunningRun } from '../../src/infrastructure/index/reader.js';
import { forgetSwept, sweepStaleRuns } from '../../src/application/run-sweep.js';
import { register, unregister } from '../../src/application/run-registry.js';

let sandbox: string;
let db: DatabaseSync;

async function openDb(): Promise<DatabaseSync> {
  const opened = await openCaseDatabase(join(sandbox, 'case.sqlite'));
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

  it('**等你勾的擴展作業不能被掃掉** —— 那個狀態撐得過重新啟動', () => {
    // 這一條是實際踩到的：第一版連 `排隊中` 一起掃，而擴展的「排隊」
    // 的意思是「在等你勾」。它不在記憶體的執行表裡（沒有東西在跑），
    // 所以掃描會把它當成孤兒 —— 於是使用者還沒回答的問題被丟掉了。
    //
    // `chooseAngles` 只看資料庫裡的 `status === 'queued'`，
    // **所以那個狀態本來就撐得過重新啟動。**
    runs.insertRun(db, {
      id: 'e1',
      kind: 'expand',
      label: '擴展',
      total: 0,
      correlationId: 'cid',
      now: Date.now(),
      topic: '主題',
    });

    expect(sweepStaleRuns(db, '測試專題')).toBe(0);
    expect(runs.getRun(db, 'e1')?.status).toBe('queued');
  });

  it('已經收尾的作業一列都不動', () => {
    insertRunning('r1');
    runs.settleRunRow(db, { id: 'r1', status: 'done', succeeded: 1, failed: 0, now: Date.now() });
    expect(sweepStaleRuns(db, '測試專題')).toBe(0);
    expect(runs.getRun(db, 'r1')?.status).toBe('done');
    expect(runs.getRun(db, 'r1')?.endedReason).toBeNull();
  });
});
