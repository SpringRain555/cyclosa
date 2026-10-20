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
