/**
 * 專題的用例編排。
 *
 * **一律回 `Result{ok, code, correlationId}`，不丟例外當控制流。**
 * 業務規則在 `domain/`，I/O 在 `infrastructure/` —— 這一層只負責把它們接起來。
 */
import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { isMutable, nextCaseStatus, type CaseStatus } from '../domain/case/state.js';
import { isUsableSlug, toSlug } from '../domain/case/slug.js';
import { openCaseDatabase } from '../infrastructure/db/database.js';
import {
  insertCase,
  readCase,
  readStats,
  updateCaseStatus,
  type CaseStats,
} from '../infrastructure/db/repositories/case-repo.js';
import { casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';

export interface CaseSummary {
  readonly slug: string;
  readonly name: string;
  readonly seed: string | null;
  readonly status: CaseStatus;
  readonly stats: CaseStats;
  readonly updatedAt: number;
  /** 資料夾的絕對路徑。**執行期顯示可以，寫進版控不行。** */
  readonly folder: string;
}

const CASE_DB_FILE = 'case.sqlite';

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 清單頁。
 *
 * **單一專題壞掉不讓整份清單失敗** —— 讀不動的那一個略過並記日誌，
 * 其餘照常顯示。這與 run 的「部分失敗是一等公民」是同一條原則，
 * 只是這裡的單位是專題。
 */
export async function listCases(dataRoot: string): Promise<Result<readonly CaseSummary[]>> {
  const cid = correlationId();
  const dir = casesDir(dataRoot);

  let entries: string[];
  try {
    await mkdir(dir, { recursive: true });
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (e) {
    logger.error('讀取專題目錄失敗', { correlationId: cid, reason: String((e as Error).message) });
    return err('IO_UNEXPECTED', cid, { at: 'readdir' });
  }

  const out: CaseSummary[] = [];
  for (const slug of entries) {
    const folder = join(dir, slug);
    const dbPath = join(folder, CASE_DB_FILE);
    if (!(await pathExists(dbPath))) continue;

    const opened = await openCaseDatabase(dbPath);
    if (opened.kind !== 'ok') {
      logger.warn('略過一個打不開的專題', { correlationId: cid, slug, why: opened.kind });
      continue;
    }
    try {
      const row = readCase(opened.db);
      if (row === null) continue;
      out.push({
        slug,
        name: row.name,
        seed: row.seed,
        status: row.status,
        stats: readStats(opened.db),
        updatedAt: row.updatedAt,
        folder,
      });
    } finally {
      opened.db.close();
    }
  }

  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return ok(out, cid);
}

export interface CreateCaseInput {
  readonly name: string;
  readonly seed?: string | undefined;
}

/**
 * 建立專題。**三次點擊以內**（REQ-0001）—— 所以只要一個名稱。
 *
 * 建到一半失敗時**把資料夾刪掉**：留下一個沒有 `case.sqlite` 的空資料夾，
 * 下次清單會略過它，而使用者會看到「我明明建過」卻找不到。
 */
export async function createCase(
  dataRoot: string,
  input: CreateCaseInput,
): Promise<Result<CaseSummary>> {
  const cid = correlationId();
  const name = input.name.trim();
  if (name.length === 0) return err('CASE_NAME_EMPTY', cid);

  const slug = toSlug(name);
  if (!isUsableSlug(slug)) return err('CASE_NAME_EMPTY', cid, { reason: 'slug-empty' });

  const folder = join(casesDir(dataRoot), slug);
  if (await pathExists(folder)) {
    const hasDb = await pathExists(join(folder, CASE_DB_FILE));
    return err(hasDb ? 'CASE_NAME_DUPLICATE' : 'CASE_FOLDER_EXISTS', cid, { slug });
  }

  let created = false;
  try {
    await mkdir(folder, { recursive: true });
    created = true;
    for (const sub of ['sources', 'derived', 'notes']) {
      await mkdir(join(folder, sub), { recursive: true });
    }

    const opened = await openCaseDatabase(join(folder, CASE_DB_FILE));
    if (opened.kind === 'schema-too-new') {
      return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
    }
    if (opened.kind === 'migrate-failed') {
      return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { at: opened.at });
    }

    const now = Date.now();
    try {
      insertCase(opened.db, { name, seed: input.seed ?? null, now });
      const row = readCase(opened.db);
      if (row === null) return err('CASE_UNEXPECTED', cid, { at: 'read-after-insert' });
      created = false; // 成功了，下面的 catch 不該再刪
      return ok(
        {
          slug,
          name: row.name,
          seed: row.seed,
          status: row.status,
          stats: readStats(opened.db),
          updatedAt: row.updatedAt,
          folder,
        },
        cid,
      );
    } finally {
      opened.db.close();
    }
  } catch (e) {
    logger.error('建立專題失敗', { correlationId: cid, reason: String((e as Error).message) });
    return err('CASE_UNEXPECTED', cid);
  } finally {
    if (created) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 封存與重新開啟。**已封存的專題不能被改動，要先重新開啟。** */
export async function changeCaseStatus(
  dataRoot: string,
  slug: string,
  action: 'archive' | 'reopen',
): Promise<Result<CaseStatus>> {
  const cid = correlationId();
  const dbPath = join(casesDir(dataRoot), slug, CASE_DB_FILE);
  if (!(await pathExists(dbPath))) return err('CASE_NOT_FOUND', cid, { slug });

  const opened = await openCaseDatabase(dbPath);
  if (opened.kind === 'schema-too-new') {
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  }
  if (opened.kind === 'migrate-failed') {
    return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { at: opened.at });
  }

  try {
    const row = readCase(opened.db);
    if (row === null) return err('CASE_NOT_FOUND', cid, { slug });

    const to = nextCaseStatus(row.status, action);
    if (to === null) return err('CASE_ARCHIVED', cid, { from: row.status, action });

    updateCaseStatus(opened.db, to, Date.now());
    return ok(to, cid);
  } finally {
    opened.db.close();
  }
}

/** 一個專題能不能被寫入。**寫入路徑呼叫它，不要自己比對狀態字串。** */
export function assertMutable(status: CaseStatus, cid: string): Result<true> {
  return isMutable(status) ? ok(true, cid) : err('CASE_ARCHIVED', cid, { status });
}
