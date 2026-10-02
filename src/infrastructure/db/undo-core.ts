import type { DatabaseSync } from 'node:sqlite';
import { planUndo, type UndoPlan } from '../../domain/run/index.js';
import * as runs from './repositories/run-repo.js';
import { dropVectorsFor } from './repositories/vector-repo.js';
import { dropIndexFor, reindexTitleRank } from '../index/writer.js';

export function planUndoRuns(db: DatabaseSync, runIds: readonly string[]): UndoPlan {
  const edges = runIds.flatMap((runId) => runs.runEdgeFacts(db, runId));
  const items = runIds.flatMap((runId) => runs.runItemFacts(db, runId));
  const owned = new Set(edges.map((edge) => edge.id));
  return planUndo(
    edges,
    items,
    runs.runEdgeFacts(db).filter((edge) => !owned.has(edge.id)),
  );
}

export function applyUndoPlan(db: DatabaseSync, plan: UndoPlan): number {
  runs.deleteEdgesById(db, plan.deleteEdges);
  for (const itemId of plan.deleteItems) {
    dropIndexFor(db, 'item', itemId);
    dropVectorsFor(db, 'item', itemId);
  }
  runs.deleteItemsById(db, plan.deleteItems);
  const deletedEntities = runs.deleteOrphanEntities(db);
  reindexTitleRank(db);
  return deletedEntities;
}
