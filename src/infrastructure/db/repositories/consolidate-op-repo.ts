import type { DatabaseSync } from '../database.js';
import { countIndependentSources } from '../../../domain/graph/confidence.js';
import { derivedGroups } from './graph-repo.js';

import type {
  ConsolidateOpKind,
  ConsolidateOpState,
} from '../../../domain/research/consolidate.js';

type Raw = Record<string, unknown>;

export interface ConsolidateOpRow {
  readonly id: string;
  readonly researchId: string;
  readonly ord: number;
  readonly kind: ConsolidateOpKind;
  readonly payloadJson: string;
  readonly why: string;
  readonly checked: boolean;
  readonly state: ConsolidateOpState;
  readonly code: string | null;
  readonly runId: string | null;
  readonly undoJson: string | null;
  readonly executedAt: number | null;
}

function toRow(raw: Raw): ConsolidateOpRow {
  return {
    id: String(raw['id']),
    researchId: String(raw['research_id']),
    ord: Number(raw['ord']),
    kind: String(raw['kind']) as ConsolidateOpKind,
    payloadJson: String(raw['payload_json']),
    why: String(raw['why'] ?? ''),
    checked: Number(raw['checked']) === 1,
    state: String(raw['state']) as ConsolidateOpState,
    code: raw['code'] === null || raw['code'] === undefined ? null : String(raw['code']),
    runId: raw['run_id'] === null || raw['run_id'] === undefined ? null : String(raw['run_id']),
    undoJson:
      raw['undo_json'] === null || raw['undo_json'] === undefined ? null : String(raw['undo_json']),
    executedAt:
      raw['executed_at'] === null || raw['executed_at'] === undefined
        ? null
        : Number(raw['executed_at']),
  };
}

export function insertOp(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly researchId: string;
    readonly ord: number;
    readonly kind: ConsolidateOpKind;
    readonly payloadJson: string;
    readonly why: string;
  },
): void {
  db.prepare(
    `INSERT INTO consolidate_op (id, research_id, ord, kind, payload_json, why)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.researchId, input.ord, input.kind, input.payloadJson, input.why);
}

export function getOp(db: DatabaseSync, id: string): ConsolidateOpRow | null {
  const row = db.prepare('SELECT * FROM consolidate_op WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? null : toRow(row);
}

export function listOps(db: DatabaseSync, researchId: string): readonly ConsolidateOpRow[] {
  const rows = db
    .prepare('SELECT * FROM consolidate_op WHERE research_id = ? ORDER BY ord')
    .all(researchId) as Raw[];
  return rows.map(toRow);
}

export function setChecked(db: DatabaseSync, id: string, checked: boolean): boolean {
  const result = db
    .prepare(
      `UPDATE consolidate_op SET checked = ?
       WHERE id = ? AND state = 'proposed' AND kind = 'extract'`,
    )
    .run(checked ? 1 : 0, id);
  return Number(result.changes) === 1;
}

export function setState(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly state: ConsolidateOpState;
    readonly code?: string | null;
    readonly runId?: string | null;
    readonly undoJson?: string | null;
    readonly executedAt?: number | null;
  },
): void {
  db.prepare(
    `UPDATE consolidate_op
     SET state = ?, code = ?, run_id = ?, undo_json = ?, executed_at = ?
     WHERE id = ?`,
  ).run(
    input.state,
    input.code ?? null,
    input.runId ?? null,
    input.undoJson ?? null,
    input.executedAt ?? null,
    input.id,
  );
}

/** 整理規劃用的提及數：同一資料節點在任一方向出現多次仍只算一次。 */
export function entityMentionCounts(db: DatabaseSync): ReadonlyMap<string, number> {
  const mentionRows = db
    .prepare(
      "SELECT x.id, x.mentions FROM (SELECT entity_id AS id, COUNT(DISTINCT item_id) AS mentions FROM (SELECT e.source_id AS entity_id, e.target_id AS item_id FROM edge e WHERE e.source_kind = 'entity' AND e.target_kind = 'item' UNION ALL SELECT e.target_id AS entity_id, e.source_id AS item_id FROM edge e WHERE e.target_kind = 'entity' AND e.source_kind = 'item') GROUP BY entity_id) x ORDER BY x.mentions DESC, x.id",
    )
    .all() as Raw[];
  return new Map(mentionRows.map((row) => [String(row['id']), Number(row['mentions'])]));
}

export interface SingleEvidenceEdgeRow {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly rel: string;
  readonly itemId: string;
  readonly quote: string;
}

/** 未被否決的具名關聯，以與可信度相同的轉載分群計算獨立來源。 */
function singleEvidenceEdges(db: DatabaseSync): readonly SingleEvidenceEdgeRow[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.source_id, e.target_id, e.rel, ev.item_id, ev.quote,
      COALESCE(se.name_zh, si.title, e.source_id) AS source_title,
      COALESCE(te.name_zh, ti.title, e.target_id) AS target_title
     FROM edge e JOIN edge_evidence ev ON ev.edge_id=e.id
     LEFT JOIN item si ON e.source_kind='item' AND si.id=e.source_id
     LEFT JOIN item ti ON e.target_kind='item' AND ti.id=e.target_id
     LEFT JOIN entity se ON e.source_kind='entity' AND se.id=e.source_id
     LEFT JOIN entity te ON e.target_kind='entity' AND te.id=e.target_id
     WHERE e.layer='named' AND e.status!='rejected'
     ORDER BY e.created_at DESC, e.id, ev.id`,
    )
    .all() as Raw[];
  // 包含未直接被引用的中間轉載資料，才不會把同一連通分量誤算成兩份來源。
  const groups = derivedGroups(db, listItemIds(db));
  const byEdge = new Map<string, Raw[]>();
  for (const row of rows) {
    const id = String(row['id']);
    const evidence = byEdge.get(id) ?? [];
    evidence.push(row);
    byEdge.set(id, evidence);
  }
  return [...byEdge.values()].flatMap((evidence) => {
    if (
      countIndependentSources(
        evidence.map((row) => ({ itemId: String(row['item_id']) })),
        groups,
      ) !== 1
    )
      return [];
    const row = evidence[0];
    if (row === undefined) return [];
    return [
      {
        id: String(row['id']),
        source: String(row['source_title']),
        target: String(row['target_title']),
        rel: String(row['rel']),
        itemId: String(row['item_id']),
        quote: String(row['quote']),
      },
    ];
  });
}

/** 按建立時間由新到舊，並非可信度或推薦排序。 */
export function listSingleEvidenceEdges(
  db: DatabaseSync,
  limit: number,
): readonly SingleEvidenceEdgeRow[] {
  return singleEvidenceEdges(db).slice(0, limit);
}

/** 未截斷總數與清單共用判準。 */
export function countSingleEvidenceEdges(db: DatabaseSync): number {
  return singleEvidenceEdges(db).length;
}

/** 筆記按建立時間與識別碼排序；字數裁切留在應用層。 */
export function listNoteBodies(
  db: DatabaseSync,
): readonly { readonly id: string; readonly body: string }[] {
  const rows = db.prepare('SELECT id, body FROM note ORDER BY created_at, id').all() as Raw[];
  return rows.map((row) => ({ id: String(row['id']), body: String(row['body'] ?? '') }));
}

/** 全部資料節點識別碼，包含筆記與已排除的資料，供提案參照驗證。 */
export function listItemIds(db: DatabaseSync): readonly string[] {
  const rows = db.prepare('SELECT id FROM item').all() as Raw[];
  return rows.map((row) => String(row['id']));
}

/** 清單跳轉到關聯來源附近，面板仍以關聯 id 讀取。 */
export function singleEvidenceFocus(db: DatabaseSync, edgeId: string): string {
  const row = db.prepare('SELECT source_id FROM edge WHERE id=?').get(edgeId) as Raw | undefined;
  return String(row?.['source_id'] ?? '');
}

/** 分頁沿用固定排序，以上一頁最後的關聯識別碼作游標。 */
export function singleEvidencePage(db: DatabaseSync, after: string | null) {
  const rows = singleEvidenceEdges(db);
  const previous = after === null ? -1 : rows.findIndex((row) => row.id === after);
  const start = after !== null && previous < 0 ? rows.length : previous + 1;
  const entries = rows.slice(start, start + 100);
  return {
    entries,
    total: rows.length,
    nextCursor: start + entries.length < rows.length ? (entries.at(-1)?.id ?? null) : null,
  };
}
