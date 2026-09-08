/**
 * 專題的用例編排。
 *
 * **一律回 `Result{ok, code, correlationId}`，不丟例外當控制流。**
 * 業務規則在 `domain/`，I/O 在 `infrastructure/` —— 這一層只負責把它們接起來。
 */
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { isMutable, nextCaseStatus, type CaseStatus } from '../domain/case/state.js';
import { isUsableSlug, toSlug } from '../domain/case/slug.js';
import { openCaseDatabase } from '../infrastructure/db/database.js';
import {
  insertCase,
  readCase,
  readStats,
  updateCaseName,
  updateCaseStatus,
  type CaseStats,
} from '../infrastructure/db/repositories/case-repo.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
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

    const opened = await openCaseDatabase(dbPath, {
      backupDir: backupsDir(dataRoot),
      backupLabel: slug,
    });
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

  const opened = await openCaseDatabase(dbPath, {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
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

/**
 * 改名 —— **名稱與資料夾一起改。**
 *
 * ## 為什麼不能只改顯示名稱
 *
 * 「一個專題是一個資料夾。整個搬走、備份、丟給別人，都是搬那一個資料夾」
 * 是這個工具寫在清單頁上的承諾（REQ-0001）。
 * 只改資料庫裡的名字，資料夾就會停在一個沒有人記得的舊名字上 ——
 * 而**使用者是在檔案總管裡找那個資料夾的**，那正是承諾要保護的動作。
 *
 * ## 順序：先搬資料夾，再改名字
 *
 * 搬資料夾是**唯一會因為外部原因失敗的那一步**（有東西開著它）。
 * 把它排在前面，失敗的時候什麼都還沒動。
 * 反過來的話，資料庫已經改了而資料夾沒搬 —— 兩邊對不上，
 * 而下一次列清單時使用者會看到一個新名字配一個舊資料夾。
 *
 * 改名字那一步真的失敗的話，**資料夾搬回去**。
 *
 * ## `exports\<舊 slug>\` 刻意不動
 *
 * 一份已經匯出的證據包裡面寫著**當時那個名字**（`# 證據包：舊名`），
 * 而那份檔案可能已經寄出去了。把它的資料夾改成新名字，
 * 資料夾名就跟它的內容對不上了 —— **舊的匯出屬於舊的名字**。
 */
export async function renameCase(
  dataRoot: string,
  slug: string,
  rawName: string,
): Promise<Result<CaseSummary>> {
  const cid = correlationId();
  const name = rawName.trim();
  if (name.length === 0) return err('CASE_NAME_EMPTY', cid);

  const nextSlug = toSlug(name);
  if (!isUsableSlug(nextSlug)) return err('CASE_NAME_EMPTY', cid, { reason: 'slug-empty' });

  const from = join(casesDir(dataRoot), slug);
  if (!(await pathExists(join(from, CASE_DB_FILE)))) return err('CASE_NOT_FOUND', cid, { slug });

  const to = join(casesDir(dataRoot), nextSlug);
  const moving = nextSlug !== slug;

  if (moving && (await pathExists(to))) {
    const hasDb = await pathExists(join(to, CASE_DB_FILE));
    return err(hasDb ? 'CASE_NAME_DUPLICATE' : 'CASE_FOLDER_EXISTS', cid, { slug: nextSlug });
  }

  // **已封存的不能改。** 改名是一次改動，而封存的意思就是不再改動它。
  // 這一次開檔在搬資料夾**之前**，而且開完就關 —— 開著的話資料夾搬不動。
  const current = await openCaseDatabase(join(from, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (current.kind !== 'ok') return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { slug });
  let status: CaseStatus;
  try {
    const row = readCase(current.db);
    if (row === null) return err('CASE_NOT_FOUND', cid, { slug });
    status = row.status;
  } finally {
    current.db.close();
  }
  const mutable = assertMutable(status, cid);
  if (!mutable.ok) return mutable;

  if (moving) {
    try {
      await rename(from, to);
    } catch (e) {
      // Windows 上開著資料夾裡任何一個檔案都會讓它搬不動。
      // **這不是「不知道發生什麼事」** —— 見 `CASE_RENAME_BLOCKED` 的註解。
      logger.warn('改名時資料夾搬不動', {
        correlationId: cid,
        reason: String((e as Error).message),
      });
      return err('CASE_RENAME_BLOCKED', cid, { slug, nextSlug });
    }
  }

  const opened = await openCaseDatabase(join(to, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: nextSlug,
  });
  if (opened.kind !== 'ok') {
    if (moving) await rename(to, from).catch(() => undefined);
    return err(
      opened.kind === 'schema-too-new' ? 'CASE_SCHEMA_TOO_NEW' : 'CASE_SCHEMA_MIGRATE_FAILED',
      cid,
      { slug: nextSlug },
    );
  }

  try {
    updateCaseName(opened.db, name, Date.now());
    const row = readCase(opened.db);
    if (row === null) return err('CASE_UNEXPECTED', cid, { at: 'read-after-rename' });
    return ok(
      {
        slug: nextSlug,
        name: row.name,
        seed: row.seed,
        status: row.status,
        stats: readStats(opened.db),
        updatedAt: row.updatedAt,
        folder: to,
      },
      cid,
    );
  } catch (e) {
    opened.db.close();
    // 名字沒改成 —— **把資料夾搬回去**，不要留下一個兩邊對不上的狀態。
    if (moving) await rename(to, from).catch(() => undefined);
    logger.error('改名失敗', { correlationId: cid, reason: String((e as Error).message) });
    return err('CASE_UNEXPECTED', cid, { at: 'update-name' });
  } finally {
    // 上面那條 catch 已經關過了，重複關是安全的（`node:sqlite` 允許）。
    try {
      opened.db.close();
    } catch {
      /* 已經關了 */
    }
  }
}

/** 一個專題能不能被寫入。**寫入路徑呼叫它，不要自己比對狀態字串。** */
export function assertMutable(status: CaseStatus, cid: string): Result<true> {
  return isMutable(status) ? ok(true, cid) : err('CASE_ARCHIVED', cid, { status });
}
