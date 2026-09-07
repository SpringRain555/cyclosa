/**
 * 作業與作業項目的讀寫。
 *
 * **`run_item` 才是作業紀錄那一頁的資料來源**，不是 `item` ——
 * 一個輸入不一定會變成一個 `item`（robots 不准、404、已經有了），
 * 而那一頁必須看得到它們。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { RunStatus } from '../../../domain/ingest/state.js';

export type RunItemOutcome =
  'queued' | 'running' | 'ok' | 'duplicate' | 'failed' | 'skipped' | 'cancelled';

export interface RunRow {
  readonly id: string;
  readonly kind: 'import' | 'expand';
  readonly status: RunStatus;
  readonly label: string;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errorCode: string | null;
  readonly correlationId: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly createdAt: number;
}

export interface RunItemRow {
  readonly id: string;
  readonly runId: string;
  readonly requested: string;
  readonly host: string | null;
  readonly itemId: string | null;
  readonly outcome: RunItemOutcome;
  readonly code: string | null;
  readonly newNodes: number;
  readonly newEdges: number;
  readonly waitedMs: number | null;
  readonly at: number | null;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toRun(row: Raw): RunRow {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as 'import' | 'expand',
    status: String(row['status']) as RunStatus,
    label: String(row['label'] ?? ''),
    total: Number(row['total'] ?? 0),
    succeeded: Number(row['succeeded'] ?? 0),
    failed: Number(row['failed'] ?? 0),
    errorCode: str(row['error_code']),
    correlationId: String(row['correlation_id'] ?? ''),
    startedAt: num(row['started_at']),
    endedAt: num(row['ended_at']),
    createdAt: Number(row['created_at']),
  };
}

function toRunItem(row: Raw): RunItemRow {
  return {
    id: String(row['id']),
    runId: String(row['run_id']),
    requested: String(row['requested']),
    host: str(row['host']),
    itemId: str(row['item_id']),
    outcome: String(row['outcome']) as RunItemOutcome,
    code: str(row['code']),
    newNodes: Number(row['new_nodes'] ?? 0),
    newEdges: Number(row['new_edges'] ?? 0),
    waitedMs: num(row['waited_ms']),
    at: num(row['at']),
  };
}

export function insertRun(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly kind: 'import' | 'expand';
    readonly label: string;
    readonly total: number;
    readonly correlationId: string;
    readonly now: number;
  },
): void {
  db.prepare(
    `INSERT INTO run (id, kind, status, label, total, correlation_id, created_at)
     VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
  ).run(input.id, input.kind, input.label, input.total, input.correlationId, input.now);
}

export function startRun(db: DatabaseSync, id: string, now: number): void {
  db.prepare("UPDATE run SET status = 'running', started_at = ? WHERE id = ?").run(now, id);
}

export function settleRunRow(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly status: RunStatus;
    readonly succeeded: number;
    readonly failed: number;
    readonly errorCode?: string | null;
    readonly now: number;
  },
): void {
  db.prepare(
    'UPDATE run SET status = ?, succeeded = ?, failed = ?, error_code = ?, ended_at = ? WHERE id = ?',
  ).run(input.status, input.succeeded, input.failed, input.errorCode ?? null, input.now, input.id);
}

export function getRun(db: DatabaseSync, id: string): RunRow | null {
  const row = db.prepare('SELECT * FROM run WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? null : toRun(row);
}

export function listRuns(db: DatabaseSync, limit: number): readonly RunRow[] {
  const rows = db.prepare('SELECT * FROM run ORDER BY created_at DESC LIMIT ?').all(limit) as Raw[];
  return rows.map(toRun);
}

export function insertRunItem(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly runId: string;
    readonly requested: string;
    readonly host: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO run_item (id, run_id, requested, host, outcome) VALUES (?, ?, ?, ?, 'queued')",
  ).run(input.id, input.runId, input.requested, input.host);
}

export function updateRunItem(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly outcome: RunItemOutcome;
    readonly code?: string | null;
    readonly itemId?: string | null;
    readonly newNodes?: number;
    readonly waitedMs?: number | null;
    readonly now: number;
  },
): void {
  db.prepare(
    `UPDATE run_item SET outcome = ?, code = ?, item_id = ?, new_nodes = ?, waited_ms = ?, at = ?
     WHERE id = ?`,
  ).run(
    input.outcome,
    input.code ?? null,
    input.itemId ?? null,
    input.newNodes ?? 0,
    input.waitedMs ?? null,
    input.now,
    input.id,
  );
}

export function listRunItems(db: DatabaseSync, runId: string): readonly RunItemRow[] {
  const rows = db
    .prepare('SELECT * FROM run_item WHERE run_id = ? ORDER BY id')
    .all(runId) as Raw[];
  return rows.map(toRunItem);
}

/** 還沒被處理的項目 —— 取消之後要把它們標成 `已取消`，**不是失敗**。 */
export function cancelPendingItems(db: DatabaseSync, runId: string, now: number): number {
  const result = db
    .prepare(
      `UPDATE run_item SET outcome = 'cancelled', at = ?
       WHERE run_id = ? AND outcome IN ('queued','running')`,
    )
    .run(now, runId);
  return Number(result.changes);
}
