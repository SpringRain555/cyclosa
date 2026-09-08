/**
 * 專題的讀寫。
 *
 * **snake_case ↔ camelCase 的轉換只在這一層做一次** ——
 * 不要讓 `title_rank`、`read_at` 這種名字漏進 domain（glossary）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CaseStatus } from '../../../domain/case/state.js';

export interface CaseRow {
  readonly id: string;
  readonly name: string;
  readonly seed: string | null;
  readonly status: CaseStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 專題清單那一頁的每一列。**「待查證」是「回來之後該做什麼」的直接答案。** */
export interface CaseStats {
  /** 資料節點。**不含點註** —— 點註是標在資料上的東西，不是資料。 */
  readonly itemCount: number;
  /** 點註。分開數，因為「我蒐集了多少」與「我想了多少」是兩件事。 */
  readonly noteCount: number;
  readonly entityCount: number;
  readonly edgeCount: number;
  /** **只數 `layer='named'`** —— 其餘三層不進裁決佇列，數進來會是假的待辦 */
  readonly pendingNamedEdgeCount: number;
  readonly lastRunAt: number | null;
}

export function readCase(db: DatabaseSync): CaseRow | null {
  const row = db.prepare('SELECT * FROM "case" WHERE id = ?').get('self') as
    Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    id: String(row['id']),
    name: String(row['name']),
    seed: row['seed'] === null || row['seed'] === undefined ? null : String(row['seed']),
    status: String(row['status']) as CaseStatus,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

export function insertCase(
  db: DatabaseSync,
  input: { readonly name: string; readonly seed: string | null; readonly now: number },
): void {
  db.prepare(
    `INSERT INTO "case" (id, name, seed, status, created_at, updated_at)
     VALUES ('self', ?, ?, 'new', ?, ?)`,
  ).run(input.name, input.seed, input.now, input.now);
}

export function updateCaseStatus(db: DatabaseSync, status: CaseStatus, now: number): void {
  db.prepare('UPDATE "case" SET status = ?, updated_at = ? WHERE id = ?').run(status, now, 'self');
}

/**
 * 改名。
 *
 * **這張表裡的 `name` 與資料夾名（slug）是同一件事的兩種寫法**，
 * 所以改名的兩半（這一支與 `fs.rename`）要一起成功 ——
 * 呼叫端負責那個順序與失敗時的回復（`case-service.ts` 的 `renameCase`）。
 */
export function updateCaseName(db: DatabaseSync, name: string, now: number): void {
  db.prepare('UPDATE "case" SET name = ?, updated_at = ? WHERE id = ?').run(name, now, 'self');
}

/**
 * 清單那一頁要的統計。
 *
 * 全部走索引：`idx_edge_layer_status` 讓「待查證的具名關聯有幾條」
 * 不必掃整張 edge 表 —— 那是 20 萬列規模下唯一撐得住的做法。
 */
export function readStats(db: DatabaseSync): CaseStats {
  const one = (sql: string, ...params: unknown[]): number => {
    const r = db.prepare(sql).get(...(params as never[])) as { n?: unknown } | undefined;
    return Number(r?.n ?? 0);
  };

  const lastRun = db.prepare('SELECT MAX(ended_at) AS n FROM run').get() as
    { n?: unknown } | undefined;

  return {
    itemCount: one("SELECT COUNT(*) AS n FROM item WHERE status != 'excluded' AND kind != 'note'"),
    noteCount: one("SELECT COUNT(*) AS n FROM item WHERE status != 'excluded' AND kind = 'note'"),
    // 被合併掉的實體還在表裡（那是為了取消得掉），**但它不再是一個節點**。
    entityCount: one('SELECT COUNT(*) AS n FROM entity WHERE merged_into IS NULL'),
    edgeCount: one("SELECT COUNT(*) AS n FROM edge WHERE status != 'rejected'"),
    pendingNamedEdgeCount: one(
      "SELECT COUNT(*) AS n FROM edge WHERE layer = 'named' AND status = 'pending'",
    ),
    lastRunAt: lastRun?.n === null || lastRun?.n === undefined ? null : Number(lastRun.n),
  };
}
