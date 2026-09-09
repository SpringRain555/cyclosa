/**
 * 索引讀取。切分與排序規則在 `domain/search/`，這一層只碰資料庫。
 *
 * 它是 `writer.ts` 的另一端，而兩邊有一條必須一致的東西：**正規化**。
 * 寫入時 `bigrams()` 對內容做 NFKC ＋ 小寫，查詢時同一支函式對查詢字串做同一件事 ——
 * 兩邊各自寫一份是這類索引最典型的失效方式，**而且它不會報錯，只會查不到**。
 * 所以兩邊都走 `domain/search/tokenize.ts`，這裡一個字都不重寫。
 *
 * ## 這一層回的是「候選」，不是「結果」
 *
 * bigram 索引裡沒有位置，所以「兩個 gram 都在這份文件裡」不等於
 * 「這串字在這份文件裡」（ADR-0009 的代價那一節）。
 * 確認是 `application/search-service.ts` 拿正文做的，這裡只負責**快速縮小範圍**。
 */
import type { DatabaseSync } from 'node:sqlite';

export interface IndexCandidate {
  readonly id: string;
  /** bigram 是命中 gram 的次數總和；FTS5 是 `-bm25`（越大越相關）。 */
  readonly score: number;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/**
 * bigram 候選。**每個 gram 都要命中**（AND）。
 *
 * `HAVING COUNT(DISTINCT gram) = ?` 就是那個 AND ——
 * 用 `OR` 的話，查「台積電」會把所有出現過「積電」的東西全部撈進來。
 *
 * 排序用次數總和只是**縮小範圍的順序**，不是給使用者看的順序：
 * 真正的順序要等正文確認完才算得出來（`domain/search/query.ts` 的 `rankHits`）。
 */
export function bigramCandidates(
  db: DatabaseSync,
  grams: readonly string[],
  limit: number,
): readonly IndexCandidate[] {
  if (grams.length === 0) return [];
  const holes = grams.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT owner_id AS id, SUM(freq) AS score
         FROM bigram
        WHERE owner_kind = 'item' AND gram IN (${holes})
        GROUP BY owner_id
       HAVING COUNT(DISTINCT gram) = ?
        ORDER BY score DESC
        LIMIT ?`,
    )
    .all(...grams, grams.length, limit) as Record<string, unknown>[];
  return rows.map((r) => ({ id: str(r['id']), score: num(r['score']) }));
}

/**
 * FTS5 候選。
 *
 * `bm25()` 越小越相關（它回的是負數），而這一層對外的約定是「越大越相關」——
 * 所以取負號。**兩個來源的分數不會互相比較**（合併時各自排各自的），
 * 這個轉換只是為了讓同一個欄位的意思在兩條路上一致。
 */
export function ftsCandidates(
  db: DatabaseSync,
  phrase: string,
  limit: number,
): readonly IndexCandidate[] {
  const rows = db
    .prepare(
      `SELECT owner_id AS id, -bm25(fts_text) AS score
         FROM fts_text
        WHERE fts_text MATCH ? AND owner_kind = 'item'
        ORDER BY score DESC
        LIMIT ?`,
    )
    .all(phrase, limit) as Record<string, unknown>[];
  return rows.map((r) => ({ id: str(r['id']), score: num(r['score']) }));
}

export interface EntityCandidate {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly titleRank: string;
}

/**
 * 實體用名字直接找，**不走索引**。
 *
 * 實體沒有正文 —— 它只有一個名字與幾個別名，而那是一張小表。
 * 為它多維護一份 bigram 索引，換到的是一個在幾萬列上也只要幾毫秒的全表掃描。
 *
 * `instr(lower(...))` 的 `lower()` 在 SQLite 裡**只處理 ASCII**，
 * 所以帶重音的拉丁字母（`Ångström`）大小寫不等價。中文不受影響，
 * 而這一條的代價寫在 `docs/architecture/multilingual.md`。
 */
export function entityCandidates(
  db: DatabaseSync,
  needle: string,
  limit: number,
): readonly EntityCandidate[] {
  const like = needle.toLowerCase();
  const rows = db
    .prepare(
      `SELECT id, name_zh AS name, type, title_rank AS titleRank
         FROM entity
        WHERE instr(lower(name_zh), ?) > 0 OR instr(lower(aliases_json), ?) > 0
        ORDER BY title_rank
        LIMIT ?`,
    )
    .all(like, like, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: str(r['id']),
    name: str(r['name']),
    type: str(r['type']),
    titleRank: str(r['titleRank']),
  }));
}

/**
 * 這幾份的中文標題名次。**同分時的穩定決勝**（`domain/search/collate.ts`）。
 *
 * 單獨查而不是塞進 `ItemRow`：`title_rank` 只有排序用得到，
 * 而 `ItemRow` 是整個應用都在傳的東西 —— 為一個排序鍵改它的形狀不划算。
 */
export function titleRanks(db: DatabaseSync, ids: readonly string[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400);
    if (batch.length === 0) continue;
    const holes = batch.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT id, title_rank AS rank FROM item WHERE id IN (${holes})`)
      .all(...batch) as Record<string, unknown>[];
    for (const row of rows) out.set(str(row['id']), str(row['rank']));
  }
  return out;
}

/**
 * 索引還在寫嗎。
 *
 * 有作業還在跑就代表**這一次搜尋看到的不是全部**，而使用者要知道這件事
 * （`SEARCH_INDEX_INCOMPLETE`，notice 不是 error）——
 * 否則他會把「還沒抓完」讀成「沒有這筆資料」。
 */
export function hasRunningRun(db: DatabaseSync): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM run WHERE status = 'running'`).get() as
    Record<string, unknown> | undefined;
  return num(row?.['n']) > 0;
}
