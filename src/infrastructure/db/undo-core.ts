import type { DatabaseSync } from 'node:sqlite';
import { planUndo, type UndoPlan } from '../../domain/run/index.js';
import * as runs from './repositories/run-repo.js';
import { dropVectorsFor } from './repositories/vector-repo.js';
import { dropIndexFor, reindexTitleRank } from '../index/writer.js';

export function planUndoRuns(
  db: DatabaseSync,
  runIds: readonly string[],
  preservedEdges: ReadonlySet<string> = new Set(),
): UndoPlan {
  const allEdges = runIds.flatMap((runId) => runs.runEdgeFacts(db, runId));
  const edges = allEdges.filter((edge) => !preservedEdges.has(edge.id));
  const items = runIds.flatMap((runId) => runs.runItemFacts(db, runId));
  const owned = new Set(edges.map((edge) => edge.id));
  const plan = planUndo(
    edges,
    items,
    runs.runEdgeFacts(db).filter((edge) => !owned.has(edge.id)),
  );
  return {
    ...plan,
    keepEdges: [
      ...plan.keepEdges,
      ...allEdges.filter((edge) => preservedEdges.has(edge.id)).map((edge) => edge.id),
    ],
  };
}

export function applyUndoPlan(
  db: DatabaseSync,
  plan: UndoPlan,
  preservedEntities: ReadonlySet<string> = new Set(),
): number {
  runs.deleteEdgesById(db, plan.deleteEdges);
  for (const itemId of plan.deleteItems) {
    dropIndexFor(db, 'item', itemId);
    dropVectorsFor(db, 'item', itemId);
  }
  runs.deleteItemsById(db, plan.deleteItems);
  const deletedEntities = runs.deleteOrphanEntities(db, preservedEntities);
  reindexTitleRank(db);
  return deletedEntities;
}
