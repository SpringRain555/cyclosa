import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { applyUndoPlan, planUndoRuns } from './undo-core.js';
import { insertNotice } from './repositories/notice-repo.js';
import { runItemFacts, runEdgeFacts } from './repositories/run-repo.js';

function isManual(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  try {
    const value = JSON.parse(raw) as { chat?: unknown; json?: { extract?: unknown } } | null;
    return (
      (typeof value?.chat === 'string' && value.chat.startsWith('manual:')) ||
      value?.json?.extract === 'manual'
    );
  } catch {
    return false;
  }
}

export function cleanupExpansion(db: DatabaseSync): readonly string[] {
  db.exec('BEGIN IMMEDIATE');
  try {
    const runIds = db
      .prepare("SELECT id, providers_json FROM run WHERE kind = 'expand'")
      .all()
      .filter((row) => !isManual(row['providers_json']))
      .map((row) => String(row['id']));
    if (runIds.length === 0) {
      db.exec('COMMIT');
      return [];
    }
    const plan = planUndoRuns(db, runIds);
    const facts = runIds.flatMap((runId) => runItemFacts(db, runId));
    const owned = new Set(
      runIds.flatMap((runId) => runEdgeFacts(db, runId)).map((edge) => edge.id),
    );
    const usedElsewhere = new Set(
      runEdgeFacts(db)
        .filter((edge) => !owned.has(edge.id))
        .flatMap((edge) => [...edge.evidenceItemIds, ...(edge.endpointItemIds ?? [])]),
    );
    applyUndoPlan(db, plan);
    for (const runId of runIds) {
      db.prepare('UPDATE item SET run_id = NULL WHERE run_id = ?').run(runId);
      db.prepare('UPDATE edge SET run_id = NULL WHERE run_id = ?').run(runId);
      db.prepare('UPDATE research SET collect_run_id = NULL WHERE collect_run_id = ?').run(runId);
      db.prepare('UPDATE research SET build_run_id = NULL WHERE build_run_id = ?').run(runId);
      db.prepare('DELETE FROM run WHERE id = ?').run(runId);
    }
    insertNotice(db, {
      id: randomUUID(),
      kind: 'expansion-cleanup',
      createdAt: Date.now(),
      bodyJson: JSON.stringify({
        deletedRuns: runIds.length,
        deletedItems: plan.deleteItems.length,
        deletedEdges: plan.deleteEdges.length,
        keptItems: plan.keepItems.length,
        keptEdges: plan.keepEdges.length,
        reasons: {
          read: facts.filter((item) => item.read).length,
          annotated: facts.filter((item) => item.annotated).length,
          excluded: facts.filter((item) => item.excluded).length,
          referenced: plan.keptAsEvidence.length,
          otherRuns: plan.keepItems.filter((id) => usedElsewhere.has(id)).length,
        },
      }),
    });
    db.exec('COMMIT');
    return plan.deleteItems;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
