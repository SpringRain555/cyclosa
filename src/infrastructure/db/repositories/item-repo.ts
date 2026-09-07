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
  };
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

export function setStatus(db: DatabaseSync, id: string, status: ItemStatus, now: number): void {
  db.prepare('UPDATE item SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
}

/** **已讀是正交旗標，不是狀態轉移**（state-machines）。存時間戳而不是布林。 */
export function setReadAt(db: DatabaseSync, id: string, at: number | null): void {
  db.prepare('UPDATE item SET read_at = ? WHERE id = ?').run(at, id);
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

export function countByStatus(db: DatabaseSync): Readonly<Record<string, number>> {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM item GROUP BY status').all() as Raw[];
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r['status'])] = Number(r['n']);
  return out;
}
