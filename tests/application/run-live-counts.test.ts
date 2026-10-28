/**
 * 跑著的作業標題列的「成功／失敗」（2026-10-28 試用回饋 9）。
 *
 * `run.succeeded`／`failed` 是收尾才寫的，畫面一路寫「成功 0」到結束。
 * 跑著的時候改從逐項紀錄數；收尾之後照資料庫那一列（它才是權威）。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import { insertCase } from '../../src/infrastructure/db/repositories/case-repo.js';

let sandbox: string;
let db: DatabaseSync;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-live-counts-'));
  const opened = await openCaseDatabase(join(sandbox, 'case.sqlite'), { create: true });
  if (opened.kind !== 'ok') throw new Error(`開不起來：${opened.kind}`);
  db = opened.db;
  insertCase(db, { name: '測試專題', seed: null, now: Date.now() });
  runs.insertRun(db, {
    id: 'r1',
    kind: 'consolidate',
    label: '抽進圖',
    total: 4,
    correlationId: 'cid',
    now: Date.now(),
  });
  for (const id of ['a', 'b', 'c', 'd']) {
    runs.insertRunItem(db, { id, runId: 'r1', requested: id, host: null });
  }
  runs.startRun(db, 'r1', Date.now());
});

afterEach(async () => {
  db.close();
  await rm(sandbox, { recursive: true, force: true });
});

it('做完的才算：ok 與重複算成功、failed 算失敗，還在排隊與跑的都不算', () => {
  runs.updateRunItem(db, { id: 'a', outcome: 'ok', now: Date.now() });
  runs.updateRunItem(db, { id: 'b', outcome: 'duplicate', now: Date.now() });
  runs.updateRunItem(db, {
    id: 'c',
    outcome: 'failed',
    code: 'PARSE_EMPTY_CONTENT',
    now: Date.now(),
  });
  runs.updateRunItem(db, { id: 'd', outcome: 'running', now: Date.now() });
  expect(runs.liveItemCounts(db, 'r1')).toEqual({ succeeded: 2, failed: 1 });
  // 資料庫那一列還是 0 —— 那正是畫面原本讀到的。
  expect(runs.getRun(db, 'r1')).toMatchObject({ succeeded: 0, failed: 0 });
});

it('一項都還沒做完：0 與 0，不是 null', () => {
  expect(runs.liveItemCounts(db, 'r1')).toEqual({ succeeded: 0, failed: 0 });
  expect(runs.liveItemCounts(db, 'no-such-run')).toEqual({ succeeded: 0, failed: 0 });
});
