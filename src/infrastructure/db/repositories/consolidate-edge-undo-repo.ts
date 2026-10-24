import type { DatabaseSync } from '../database.js';

type Raw = Record<string, unknown>;

/** 快照關聯、出處與稽核；新關聯也需識別後續變更，再交給共用作業復原。 */
export function edgeSnapshot(db: DatabaseSync, id: string): string {
  return JSON.stringify({
    edge: db.prepare('SELECT * FROM edge WHERE id=?').get(id) ?? null,
    evidence: db.prepare('SELECT * FROM edge_evidence WHERE edge_id=? ORDER BY id').all(id),
    audit: db.prepare('SELECT * FROM edge_audit WHERE edge_id=? ORDER BY id').all(id),
  });
}

/** 後來有人或其他作業動過就保留；逆序處理讓同一次作業的連續補出處能逐筆退。 */
export function undoAddedEvidence(db: DatabaseSync, runId: string): ReadonlySet<string> {
  const rows = db
    .prepare(
      `SELECT id, undo_json FROM consolidate_op
    WHERE run_id=? AND kind='add-edge' AND state='done' ORDER BY ord DESC`,
    )
    .all(runId) as Raw[];
  const kept = new Set<string>();
  for (const row of rows) {
    let info: { edgeId?: string; before?: string | null; after?: string; reverted?: boolean };
    try {
      info = JSON.parse(String(row['undo_json'])) as typeof info;
    } catch {
      continue;
    }
    if (
      info === null ||
      info.reverted ||
      typeof info.edgeId !== 'string' ||
      (info.before !== null && typeof info.before !== 'string') ||
      typeof info.after !== 'string'
    )
      continue;
    if (db.prepare('SELECT id FROM edge WHERE id=?').get(info.edgeId) === undefined) continue;
    if (edgeSnapshot(db, info.edgeId) !== info.after) {
      kept.add(info.edgeId);
      continue;
    }
    if (info.before === null) continue;
    const before = JSON.parse(info.before) as { edge: Raw; evidence: Raw[]; audit: Raw[] };
    const retainedEvidence = new Set(before.evidence.map((entry) => String(entry['id'])));
    const retainedAudit = new Set(before.audit.map((entry) => String(entry['id'])));
    for (const entry of db
      .prepare('SELECT id FROM edge_evidence WHERE edge_id=?')
      .all(info.edgeId)) {
      if (!retainedEvidence.has(String(entry['id'])))
        db.prepare('DELETE FROM edge_evidence WHERE id=?').run(String(entry['id']));
    }
    for (const entry of db.prepare('SELECT id FROM edge_audit WHERE edge_id=?').all(info.edgeId)) {
      if (!retainedAudit.has(String(entry['id'])))
        db.prepare("DELETE FROM edge_audit WHERE id=? AND actor='machine' AND run_id=?").run(
          String(entry['id']),
          runId,
        );
    }
    db.prepare(
      `UPDATE edge SET status=?, confidence=?, previously_rejected=?, updated_at=? WHERE id=?`,
    ).run(
      String(before.edge['status']),
      Number(before.edge['confidence']),
      Number(before.edge['previously_rejected']),
      Number(before.edge['updated_at']),
      info.edgeId,
    );
    db.prepare('UPDATE consolidate_op SET undo_json=? WHERE id=?').run(
      JSON.stringify({ ...info, reverted: true }),
      String(row['id']),
    );
  }
  return kept;
}
