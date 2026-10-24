import type { DatabaseSync } from '../database.js';

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
       WHERE id = ? AND state = 'proposed' AND kind IN ('extract', 'merge', 'retype', 'add-edge', 'digest')`,
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

/** 只由一份資料提供出處的關聯；取識別碼最小的出處，關聯按建立時間由新到舊。 */
export function listSingleEvidenceEdges(
  db: DatabaseSync,
  limit: number,
): readonly SingleEvidenceEdgeRow[] {
  const edgeRows = db
    .prepare(
      "SELECT e.id, e.source_id, e.source_kind, e.target_id, e.target_kind, e.rel, ev.item_id, ev.quote, si.title AS source_item_title, ti.title AS target_item_title, se.name_zh AS source_entity_name, te.name_zh AS target_entity_name FROM edge e JOIN edge_evidence ev ON ev.id = (SELECT e2.id FROM edge_evidence e2 WHERE e2.edge_id = e.id ORDER BY e2.id LIMIT 1) LEFT JOIN item si ON e.source_kind = 'item' AND si.id = e.source_id LEFT JOIN item ti ON e.target_kind = 'item' AND ti.id = e.target_id LEFT JOIN entity se ON e.source_kind = 'entity' AND se.id = e.source_id LEFT JOIN entity te ON e.target_kind = 'entity' AND te.id = e.target_id WHERE (SELECT COUNT(DISTINCT e2.item_id) FROM edge_evidence e2 WHERE e2.edge_id = e.id) = 1 ORDER BY e.created_at DESC, e.id LIMIT ?",
    )
    .all(limit) as Raw[];
  return edgeRows.map((row) => ({
    id: String(row['id']),
    source: String(row['source_entity_name'] ?? row['source_item_title'] ?? row['source_id']),
    target: String(row['target_entity_name'] ?? row['target_item_title'] ?? row['target_id']),
    rel: String(row['rel']),
    itemId: String(row['item_id']),
    quote: String(row['quote']),
  }));
}

/** 未截斷的總數，供整理規劃揭露涵蓋範圍。 */
export function countSingleEvidenceEdges(db: DatabaseSync): number {
  const edgeCountRow = db
    .prepare(
      'SELECT COUNT(*) AS n FROM edge e WHERE (SELECT COUNT(DISTINCT e2.item_id) FROM edge_evidence e2 WHERE e2.edge_id = e.id) = 1',
    )
    .get() as Raw | undefined;
  return Number(edgeCountRow?.['n'] ?? 0);
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

/** 人工型別紀錄依實際執行順序，保留已復原的歷史。 */
export function listRetypeOps(db: DatabaseSync, entityId: string): readonly ConsolidateOpRow[] {
  return (
    db
      .prepare(
        "SELECT * FROM consolidate_op WHERE kind = 'retype' AND state = 'done' AND json_extract(payload_json, '$.entityId') = ? ORDER BY executed_at DESC, rowid DESC",
      )
      .all(entityId) as Raw[]
  ).map(toRow);
}

/** 勾選時綁住當下的人工決定版本；執行後改存真正的復原值。 */
export function setRetypeExpectation(db: DatabaseSync, id: string, undoJson: string | null): void {
  db.prepare(
    "UPDATE consolidate_op SET undo_json = ? WHERE id = ? AND kind = 'retype' AND state = 'proposed'",
  ).run(undoJson, id);
}
