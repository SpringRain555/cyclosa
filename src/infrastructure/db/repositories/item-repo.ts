/**
 * 資料節點的讀寫。
 *
 * **snake_case ↔ camelCase 的轉換只在這一層做一次** ——
 * 不要讓 `title_rank`、`read_at` 這種名字漏進 domain（glossary）。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { ItemKind, ItemStatus } from '../../../domain/ingest/state.js';

export interface ItemRow {
  readonly id: string;
  readonly kind: ItemKind;
  readonly title: string;
  readonly requestedUrl: string | null;
  readonly sourceUrl: string | null;
  readonly lang: string;
  readonly sha256: string | null;
  readonly sourceExt: string | null;
  readonly mime: string | null;
  readonly byteSize: number | null;
  readonly fetchedAt: number | null;
  readonly status: ItemStatus;
  readonly lowConfidence: boolean;
  readonly lowConfidenceReasons: readonly string[];
  readonly excerpt: string;
  readonly extractorVersion: number | null;
  readonly pageCount: number | null;
  readonly imageWidth: number | null;
  readonly imageHeight: number | null;
  readonly errorCode: string | null;
  readonly readAt: number | null;
  readonly runId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * 初讀給的繁中標題與摘要（schema v11，Stage 21）。**衍生物，原文欄位永遠不被覆蓋**（R15）——
   * `title` 還是原文那一個。`digestedBy` 是實際跑的那一個模型，`digestedAt` 是什麼時候。
   */
  readonly titleZh: string | null;
  readonly summaryZh: string | null;
  readonly digestedBy: string | null;
  readonly digestedAt: number | null;
}

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toItem(row: Raw): ItemRow {
  let reasons: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row['low_confidence_reasons'] ?? '[]'));
    if (Array.isArray(parsed)) reasons = parsed.map((r) => String(r));
  } catch {
    // 壞掉的 JSON 不該讓整份清單失敗 —— 這一欄只是理由，不是資料本身
    reasons = [];
  }

  return {
    id: String(row['id']),
    kind: String(row['kind']) as ItemKind,
    title: String(row['title'] ?? ''),
    requestedUrl: str(row['requested_url']),
    sourceUrl: str(row['source_url']),
    lang: String(row['lang'] ?? 'und'),
    sha256: str(row['sha256']),
    sourceExt: str(row['source_ext']),
    mime: str(row['mime']),
    byteSize: num(row['byte_size']),
    fetchedAt: num(row['fetched_at']),
    status: String(row['status']) as ItemStatus,
    lowConfidence: Number(row['low_confidence'] ?? 0) === 1,
    lowConfidenceReasons: reasons,
    excerpt: String(row['excerpt'] ?? ''),
    extractorVersion: num(row['extractor_version']),
    pageCount: num(row['page_count']),
    imageWidth: num(row['image_width']),
    imageHeight: num(row['image_height']),
    errorCode: str(row['error_code']),
    readAt: num(row['read_at']),
    runId: str(row['run_id']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    titleZh: str(row['title_zh']),
    summaryZh: str(row['summary_zh']),
    digestedBy: str(row['digested_by']),
    digestedAt: num(row['digested_at']),
  };
}

/**
 * 寫一份初讀的繁中標題與摘要（Stage 21）。**只動那四欄** —— `title` 與正文一個字都不碰（R15）。
 *
 * **不動 `updated_at`**：那一欄是「這份資料本身變了」（重新抽取、狀態改變），而初讀是它旁邊多一段衍生的說明；
 * 把它算成「資料變了」，清單的排序與「最近更新」都會被一次初讀打亂。
 */
export function setItemDigest(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly titleZh: string;
    readonly summaryZh: string;
    readonly digestedBy: string;
    readonly now: number;
  },
): void {
  db.prepare(
    'UPDATE item SET title_zh = ?, summary_zh = ?, digested_by = ?, digested_at = ? WHERE id = ?',
  ).run(
    input.titleZh.length > 0 ? input.titleZh : null,
    input.summaryZh.length > 0 ? input.summaryZh : null,
    input.digestedBy,
    input.now,
    input.id,
  );
}

export function insertPendingItem(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly kind: ItemKind;
    readonly requestedUrl: string | null;
    readonly title: string;
    readonly runId: string;
    readonly now: number;
  },
): void {
  db.prepare(
    `INSERT INTO item (id, kind, title, requested_url, status, run_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(input.id, input.kind, input.title, input.requestedUrl, input.runId, input.now, input.now);
}

export function findByRequestedUrl(db: DatabaseSync, url: string): ItemRow | null {
  const row = db.prepare('SELECT * FROM item WHERE requested_url = ?').get(url) as Raw | undefined;
  return row === undefined ? null : toItem(row);
}

export function findBySha256(db: DatabaseSync, sha256: string): ItemRow | null {
  const row = db.prepare('SELECT * FROM item WHERE sha256 = ?').get(sha256) as Raw | undefined;
  return row === undefined ? null : toItem(row);
}

export function getItem(db: DatabaseSync, id: string): ItemRow | null {
  const row = db.prepare('SELECT * FROM item WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? null : toItem(row);
}

/**
 * 一次拿一批。子圖畫面上有幾百個節點，**逐個 `getItem` 是幾百次查詢**。
 *
 * 分批是因為 `IN (?, ?, …)` 的參數個數有上限，而且一次塞幾千個
 * 對排查沒有好處 —— 400 這個數字沒有特別的意義，它只是「明顯夠小」。
 */
export function loadItems(db: DatabaseSync, ids: readonly string[]): readonly ItemRow[] {
  const out: ItemRow[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400);
    if (batch.length === 0) continue;
    const rows = db
      .prepare(`SELECT * FROM item WHERE id IN (${new Array(batch.length).fill('?').join(',')})`)
      .all(...(batch as never[])) as Raw[];
    for (const row of rows) out.push(toItem(row));
  }
  return out;
}

/** 快照寫好、雜湊算完 —— **`待處理 → 已擷取`**。 */
export function markFetched(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly sourceUrl: string;
    readonly sha256: string;
    readonly mime: string;
    readonly sourceExt: string;
    readonly byteSize: number;
    readonly kind: ItemKind;
    readonly now: number;
  },
): void {
  db.prepare(
    `UPDATE item SET status = 'fetched', source_url = ?, sha256 = ?, mime = ?, source_ext = ?,
                     byte_size = ?, kind = ?, fetched_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.sourceUrl,
    input.sha256,
    input.mime,
    input.sourceExt,
    input.byteSize,
    input.kind,
    input.now,
    input.now,
    input.id,
  );
}

/**
 * 正文抽出、語言判定、信心值記錄 —— **`已擷取 → 已解析 → 已納入`**。
 *
 * 兩步併成一步是刻意的：匯入是使用者主動發起的，所以「進到圖裡」不需要
 * 再一次確認。**「已排除」才是需要人的那一個方向**，而它不在這條路上。
 */
export function markParsed(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly title: string;
    readonly lang: string;
    readonly excerpt: string;
    readonly lowConfidence: boolean;
    readonly reasons: readonly string[];
    readonly extractorVersion: number;
    readonly pageCount: number | null;
    readonly imageWidth: number | null;
    readonly imageHeight: number | null;
    readonly now: number;
  },
): void {
  db.prepare(
    `UPDATE item SET status = 'included', title = ?, lang = ?, excerpt = ?,
                     low_confidence = ?, low_confidence_reasons = ?, extractor_version = ?,
                     page_count = ?, image_width = ?, image_height = ?,
                     error_code = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.title,
    input.lang,
    input.excerpt,
    input.lowConfidence ? 1 : 0,
    JSON.stringify(input.reasons),
    input.extractorVersion,
    input.pageCount,
    input.imageWidth,
    input.imageHeight,
    input.now,
    input.id,
  );
}

/**
 * 整批重算之後把抽取結果寫回去 —— **但不碰 `status`**。
 *
 * 跟 `markParsed` 差的就是那一欄，而那一欄是差別的全部意義：
 * 一份已經被人排除的資料，重抽一次之後**仍然是被排除的**。
 * 用 `markParsed` 重算會把使用者的判斷靜默地還原回「已納入」，
 * 而那是「機器永遠不得覆寫人工判定」在這個專案裡的第 N 種寫法。
 */
export function markReextracted(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly title: string;
    readonly lang: string;
    readonly excerpt: string;
    readonly lowConfidence: boolean;
    readonly reasons: readonly string[];
    readonly extractorVersion: number;
    readonly pageCount: number | null;
    readonly imageWidth: number | null;
    readonly imageHeight: number | null;
    readonly now: number;
  },
): void {
  db.prepare(
    `UPDATE item SET title = ?, lang = ?, excerpt = ?,
                     low_confidence = ?, low_confidence_reasons = ?, extractor_version = ?,
                     page_count = ?, image_width = ?, image_height = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    input.title,
    input.lang,
    input.excerpt,
    input.lowConfidence ? 1 : 0,
    JSON.stringify(input.reasons),
    input.extractorVersion,
    input.pageCount,
    input.imageWidth,
    input.imageHeight,
    input.now,
    input.id,
  );
}

/** 點註改標題時用。**圖上那個節點的標籤就是它。** */
export function setTitle(db: DatabaseSync, id: string, title: string, now: number): void {
  db.prepare('UPDATE item SET title = ?, title_rank = ?, updated_at = ? WHERE id = ?').run(
    title,
    title,
    now,
    id,
  );
}

export function setExcerpt(db: DatabaseSync, id: string, excerpt: string): void {
  db.prepare('UPDATE item SET excerpt = ? WHERE id = ?').run(excerpt, id);
}

export function markFailed(db: DatabaseSync, id: string, code: string, now: number): void {
  db.prepare("UPDATE item SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?").run(
    code,
    now,
    id,
  );
}

/** 重試：**回到待處理，不產生第二個節點**（REQ-0003）。 */
export function markPending(db: DatabaseSync, id: string, now: number): void {
  db.prepare(
    "UPDATE item SET status = 'pending', error_code = NULL, updated_at = ? WHERE id = ?",
  ).run(now, id);
}

/**
 * 換這一份是哪一筆作業寫的。**只有「替一個網址上傳」會用到**：那個網址抓失敗留下的那一列
 * 被你上傳的檔案接手之後，它屬於那一筆上傳，不屬於當初沒抓到的那一筆（「復原」看的是這一欄）。
 */
export function setRunId(db: DatabaseSync, id: string, runId: string): void {
  db.prepare('UPDATE item SET run_id = ? WHERE id = ?').run(runId, id);
}

export function setStatus(db: DatabaseSync, id: string, status: ItemStatus, now: number): void {
  db.prepare('UPDATE item SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
}

/** **已讀是正交旗標，不是狀態轉移**（state-machines）。存時間戳而不是布林。 */
export function setReadAt(db: DatabaseSync, id: string, at: number | null): void {
  db.prepare('UPDATE item SET read_at = ? WHERE id = ?').run(at, id);
}

/**
 * 整個專題全部標成未讀。回傳**被改動的列數**。
 *
 * **跟 `setReadAt` 一樣不寫 `updated_at`**，而這一條在批次版特別重要：
 * 寫了的話，「把已讀清掉」這個動作會把專題推到清單最上面
 * （`listCases` 依 `updatedAt` 排序），看起來像剛剛編輯過它。
 * **已讀是關於「你」的事實，不是關於這份資料的事實。**
 *
 * `WHERE read_at IS NOT NULL` 讓回傳的數字是「真的被清掉幾份」，
 * 而不是「這個專題有幾份資料」—— 那兩個數字在畫面上是兩句不同的話。
 */
export function clearAllReadAt(db: DatabaseSync): number {
  const result = db.prepare('UPDATE item SET read_at = NULL WHERE read_at IS NOT NULL').run();
  return Number(result.changes);
}

/** 現在有幾份標著已讀。**確認對話框要說出這個數字。** */
export function countRead(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM item WHERE read_at IS NOT NULL').get() as
    Record<string, unknown> | undefined;
  return Number(row?.['n'] ?? 0);
}

export function setTitleRank(db: DatabaseSync, id: string, rank: string): void {
  db.prepare('UPDATE item SET title_rank = ? WHERE id = ?').run(rank, id);
}

export function allTitles(
  db: DatabaseSync,
): readonly { readonly id: string; readonly title: string }[] {
  const rows = db.prepare('SELECT id, title FROM item').all() as Raw[];
  return rows.map((r) => ({ id: String(r['id']), title: String(r['title'] ?? '') }));
}

export type ItemSort = 'recent' | 'title';

export interface ListItemsQuery {
  readonly sort: ItemSort;
  readonly limit: number;
  /** cursor 分頁（**不是 offset**）—— 5 萬筆規模下 `OFFSET 40000` 會逐列掃過去。 */
  readonly cursor?: string | undefined;
  readonly status?: ItemStatus | undefined;
  readonly onlyLowConfidence?: boolean | undefined;
  readonly unreadOnly?: boolean | undefined;
  /**
   * 把點註也列進來。**預設不列。**
   *
   * 一則點註是一個 `kind='note'` 的 `item`（ADR-0010 第 4 條）——
   * 那個決定對圖是對的，對這份清單是錯的：閱讀器左邊那一欄問的是
   * 「這個專題有哪些**資料**」，而點註是**標在資料上的東西**，不是資料。
   *
   * 不擋的話，一份文件標了 30 則之後，清單上有 30 列點註跟 1 列文件 ——
   * 而那 30 列點開來都是「沒有重構後的正文」，因為點註本來就沒有正文。
   * 2026-09-08 第一次把畫面開起來就是那樣。
   */
  readonly includeNotes?: boolean | undefined;
}

export interface ItemPage {
  readonly items: readonly ItemRow[];
  readonly nextCursor: string | null;
}

/**
 * cursor 的形狀是 `<排序鍵>|<id>`。
 *
 * **一定要帶 id**：排序鍵會重複（同名標題、同一毫秒建立的兩筆），
 * 而重複的 cursor 會讓分頁在那個位置**跳過或重複一列**。
 */
function encodeCursor(sortKey: string, id: string): string {
  return `${sortKey}|${id}`;
}

function decodeCursor(cursor: string): { readonly key: string; readonly id: string } | null {
  const at = cursor.lastIndexOf('|');
  if (at < 0) return null;
  return { key: cursor.slice(0, at), id: cursor.slice(at + 1) };
}

export function listItems(db: DatabaseSync, query: ListItemsQuery): ItemPage {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (query.status !== undefined) {
    where.push('status = ?');
    params.push(query.status);
  } else {
    // 預設不顯示已排除的 —— 它是墓碑，預設隱藏（state-machines）
    where.push("status != 'excluded'");
  }
  if (query.onlyLowConfidence === true) where.push('low_confidence = 1');
  if (query.unreadOnly === true) where.push('read_at IS NULL');
  if (query.includeNotes !== true) where.push("kind != 'note'");

  const byTitle = query.sort === 'title';
  // `created_at DESC` 走的是「最近匯入的排前面」；`title_rank` 走 idx_item_title_rank。
  const orderKey = byTitle ? 'title_rank' : 'created_at';
  const direction = byTitle ? 'ASC' : 'DESC';
  const compare = byTitle ? '>' : '<';

  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (cursor !== null) {
    where.push(`(${orderKey} ${compare} ? OR (${orderKey} = ? AND id ${compare} ?))`);
    params.push(
      byTitle ? cursor.key : Number(cursor.key),
      byTitle ? cursor.key : Number(cursor.key),
      cursor.id,
    );
  }

  const sql =
    `SELECT * FROM item${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}` +
    ` ORDER BY ${orderKey} ${direction}, id ${direction} LIMIT ?`;
  const rows = db.prepare(sql).all(...([...params, query.limit + 1] as never[])) as Raw[];

  const page = rows.slice(0, query.limit).map(toItem);
  const hasMore = rows.length > query.limit;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last !== undefined
      ? encodeCursor(byTitle ? readTitleRank(db, last.id) : String(last.createdAt), last.id)
      : null;

  return { items: page, nextCursor };
}

function readTitleRank(db: DatabaseSync, id: string): string {
  const row = db.prepare('SELECT title_rank AS r FROM item WHERE id = ?').get(id) as
    Raw | undefined;
  return String(row?.['r'] ?? '');
}

/** 專題清單的「快照佔用」。 */
export function totalSnapshotBytes(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(SUM(byte_size), 0) AS n FROM item').get() as
    Raw | undefined;
  return Number(row?.['n'] ?? 0);
}

/** 依狀態數。**不含點註** —— 統計列上的「幾份資料」問的是資料，不是註記。 */
export function countByStatus(db: DatabaseSync): Readonly<Record<string, number>> {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS n FROM item WHERE kind != 'note' GROUP BY status")
    .all() as Raw[];
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r['status'])] = Number(r['n']);
  return out;
}
