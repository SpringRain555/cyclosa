/**
 * 作業紀錄的讀取。
 *
 * **這一頁只顯示發生了什麼**（ui-workflows）—— 沒有任何修改抓回來的東西的入口。
 */
import { join } from 'node:path';

import { openCaseDatabase } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';
import { isActive, isPaused } from './run-registry.js';
import { sweepStaleRuns } from './run-sweep.js';
import { viewAngles, type AngleView } from './expand-service.js';

const CASE_DB_FILE = 'case.sqlite';

async function open(dataRoot: string, slug: string, cid: string) {
  const opened = await openCaseDatabase(join(casesDir(dataRoot), slug, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new')
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  if (opened.kind === 'migrate-failed')
    return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { at: opened.at });
  if (readCase(opened.db) === null) {
    opened.db.close();
    return err('CASE_NOT_FOUND', cid, { slug });
  }
  // **這個行程第一次打開這個專題時，把上一次沒有收尾的作業掃掉。**
  // 不掃的話，一個上次被強制結束的作業會永遠標著「執行中」，
  // 而且連取消都取消不掉（`run-sweep.ts` 寫了完整的理由）。
  sweepStaleRuns(opened.db, slug);
  return opened.db;
}

export interface RunSummary extends runs.RunRow {
  /** 這一次作業現在還在跑嗎。**資料庫看不出來**（狀態是收尾時才寫的）。 */
  readonly live: boolean;
  /**
   * 暫停中。
   *
   * **跟 `live` 一樣是執行時的事實，資料庫裡沒有它** ——
   * 「暫停」的意思是「等一下會接著跑」，而那個承諾只有這個行程活著才成立
   * （`run-registry.ts` 寫了為什麼不存進 `run.status`）。
   */
  readonly paused: boolean;
}

export async function listRuns(
  dataRoot: string,
  slug: string,
  limit = 50,
): Promise<Result<readonly RunSummary[]>> {
  const cid = correlationId();
  const db = await open(dataRoot, slug, cid);
  if ('ok' in db) return db;
  try {
    return ok(
      runs.listRuns(db, limit).map((r) => ({ ...r, live: isActive(r.id), paused: isPaused(r.id) })),
      cid,
    );
  } finally {
    db.close();
  }
}

export interface RunDetail {
  readonly run: RunSummary;
  readonly items: readonly runs.RunItemRow[];
  /**
   * 切入角度（擴展才有，匯入是空陣列）。
   *
   * **沒被勾的那幾條也在裡面** —— 「工具提了六條、你只要兩條」
   * 是這次作業發生過的事實的一部分。
   */
  readonly angles: readonly AngleView[];
}

export async function getRun(
  dataRoot: string,
  slug: string,
  runId: string,
): Promise<Result<RunDetail>> {
  const cid = correlationId();
  const db = await open(dataRoot, slug, cid);
  if ('ok' in db) return db;
  try {
    const row = runs.getRun(db, runId);
    if (row === null) return err('RUN_NOT_FOUND', cid, { runId });
    return ok(
      {
        run: { ...row, live: isActive(runId), paused: isPaused(runId) },
        items: runs.listRunItems(db, runId),
        angles: viewAngles(db, runId),
      },
      cid,
    );
  } finally {
    db.close();
  }
}
