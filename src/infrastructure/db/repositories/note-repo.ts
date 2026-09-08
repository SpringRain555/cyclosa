/**
 * 點註的讀寫。
 *
 * ## 一則點註是兩列
 *
 * | 表 | 那一列是什麼 |
 * |---|---|
 * | `item`（`kind='note'`）| **圖上的那個節點** —— 它才能參與關聯（ADR-0010 第 4 條）|
 * | `note` | 錨點：選擇器、對著哪一份、對著那一份的哪一個快照 |
 *
 * **兩列同一個 id。** migration 005 的 trigger 守著這件事，
 * 所以這裡的 `insertNote` 一定要先建 item 那一列。
 *
 * ## `item_id` 與 `id` 是兩個不同的東西，而它們長得一樣
 *
 * - `note.id` ＝ **這則點註自己**（也是它在圖上那個節點的 id）
 * - `note.item_id` ＝ **它標在哪一份上**
 *
 * 這是這個檔案裡最容易寫錯的一行，所以兩個欄位在下面的 SQL 裡永遠寫全名，
 * 不用 `*`。
 */
import type { DatabaseSync } from '../database.js';

export interface NoteRow {
  readonly id: string;
  /** 標在哪一份上。**那一份被刪掉之後這裡是 `null`**，而註記本身還在。 */
  readonly itemId: string | null;
  readonly body: string;
  readonly selectorJson: string;
  /** 標的時候那一份的快照。**「錨在 sources/」在 schema 上的對應物。** */
  readonly snapshotSha256: string | null;
  readonly anchorOk: boolean;
  readonly mdPath: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toRow(raw: Raw): NoteRow {
  return {
    id: String(raw['id']),
    itemId: str(raw['item_id']),
    body: String(raw['body'] ?? ''),
    selectorJson: String(raw['selector_json'] ?? '[]'),
    snapshotSha256: str(raw['snapshot_sha256']),
    anchorOk: Number(raw['anchor_ok'] ?? 1) === 1,
    mdPath: str(raw['md_path']),
    createdAt: Number(raw['created_at']),
    updatedAt: Number(raw['updated_at']),
  };
}

const COLUMNS =
  'id, item_id, body, selector_json, snapshot_sha256, anchor_ok, md_path, created_at, updated_at';

export interface NewNote {
  readonly id: string;
  readonly itemId: string;
  /** 圖上那個節點的標題。**引文的前幾個字**，不是使用者打的正文。 */
  readonly title: string;
  readonly body: string;
  readonly selectorJson: string;
  readonly snapshotSha256: string | null;
  readonly anchorOk: boolean;
  readonly now: number;
}

/**
 * 建立一則點註 —— **item 那一列先，note 那一列後**。
 *
 * 順序不是偏好，是 trigger 逼的：`note` 那一列進不去，除非同 id 的
 * `item` 已經在了而且 `kind='note'`。
 *
 * `status` 直接寫 `included`：點註不走擷取管線，沒有「待處理→已抓→已解析」
 * 可言 —— 它一寫下來就是這個專題的一部分。**排除仍然做得到**
 * （`included → excluded` 是人可以推的轉移），而那是使用者的判斷。
 */
export function insertNote(db: DatabaseSync, note: NewNote): NoteRow {
  db.prepare(
    `INSERT INTO item (id, kind, title, title_rank, lang, status, created_at, updated_at)
     VALUES (?, 'note', ?, ?, 'und', 'included', ?, ?)`,
  ).run(note.id, note.title, note.title, note.now, note.now);

  db.prepare(
    `INSERT INTO note (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    note.id,
    note.itemId,
    note.body,
    note.selectorJson,
    note.snapshotSha256,
    note.anchorOk ? 1 : 0,
    note.now,
    note.now,
  );

  return getNote(db, note.id) as NoteRow;
}

export function getNote(db: DatabaseSync, id: string): NoteRow | null {
  const raw = db.prepare(`SELECT ${COLUMNS} FROM note WHERE id = ?`).get(id) as Raw | undefined;
  return raw === undefined ? null : toRow(raw);
}

/** 一份資料上的所有點註。**依 id 排序**，不依建立時間 —— 見下面。 */
export function listNotesFor(db: DatabaseSync, itemId: string): readonly NoteRow[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM note WHERE item_id = ? ORDER BY created_at, id`)
    .all(itemId) as Raw[];
  return rows.map(toRow);
}

/**
 * 專題全部的點註。
 *
 * **這就是「不為三種來源開三張表」買到的東西**（ADR-0019）——
 * 這句話是一條 SELECT，不是三張表的 UNION。
 */
export function listNotes(db: DatabaseSync, limit = 500): readonly NoteRow[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM note ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(limit) as Raw[];
  return rows.map(toRow);
}

/** 對不上原文的那幾則。整批重算之後要問的就是這一句。 */
export function countUnresolved(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM note WHERE anchor_ok = 0').get() as
    Raw | undefined;
  return Number(row?.['n'] ?? 0);
}

export function countNotes(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM note').get() as Raw | undefined;
  return Number(row?.['n'] ?? 0);
}

/** 改註記內容。**錨點不動** —— 改的是你寫的字，不是你標的位置。 */
export function updateBody(db: DatabaseSync, id: string, body: string, now: number): void {
  db.prepare('UPDATE note SET body = ?, updated_at = ? WHERE id = ?').run(body, now, id);
}

/**
 * 記下這一次解析的結果。
 *
 * **只寫 `anchor_ok`，不寫解出來的位置。** 位置是算出來的，
 * 存下來就會有一份跟 `derived/` 不同步的副本 —— 而那正是這一階段
 * 要驗的東西（重算前後差異為 0）。存了它，那條驗收就變成在驗自己的快取。
 */
export function setAnchorOk(db: DatabaseSync, id: string, ok: boolean, now: number): void {
  db.prepare('UPDATE note SET anchor_ok = ?, updated_at = ? WHERE id = ?').run(ok ? 1 : 0, now, id);
}

export function setMdPath(db: DatabaseSync, id: string, path: string | null): void {
  db.prepare('UPDATE note SET md_path = ? WHERE id = ?').run(path, id);
}

/**
 * 刪一則點註 —— **兩列一起刪**。
 *
 * `edge` 上關到這個節點的線由呼叫端決定怎麼處理；
 * 這裡不做 cascade，因為「刪掉一則筆記順便刪掉三條人工確認過的關聯」
 * 是那種按下去才發現的事。
 */
export function deleteNote(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM note WHERE id = ?').run(id);
  db.prepare("DELETE FROM item WHERE id = ? AND kind = 'note'").run(id);
}

/** 這則點註在圖上還有沒有連著的線。刪之前要問。 */
export function edgeCountFor(db: DatabaseSync, id: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM edge WHERE source_id = ? OR target_id = ?')
    .get(id, id) as Raw | undefined;
  return Number(row?.['n'] ?? 0);
}

/**
 * 一整批的線數，**一次查完**。
 *
 * 清單上每一則都要顯示「刪掉會連帶拿掉幾條線」，
 * 而逐則問一次就是 N 次查詢 —— 一份文件上有 30 則點註是正常的。
 */
export function edgeCounts(db: DatabaseSync, anchorRel: string): ReadonlyMap<string, number> {
  // **不算那條錨點線自己。** 它跟著點註一起生、一起死，
  // 而「刪掉會連帶拿掉幾條線」問的是**你另外建的那些**。
  const rows = db
    .prepare(
      `SELECT n.id AS id, COUNT(e.id) AS n
       FROM note n
       LEFT JOIN edge e
         ON (e.source_id = n.id OR e.target_id = n.id)
        AND NOT (e.source_id = n.id AND e.target_id = n.item_id AND e.rel = ?)
       GROUP BY n.id`,
    )
    .all(anchorRel) as Raw[];
  return new Map(rows.map((r) => [String(r['id']), Number(r['n'] ?? 0)]));
}
