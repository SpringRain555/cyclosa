import { ENTITY_TYPES, type EntityType } from '../domain/provider/relations.js';
import { withTransaction } from '../infrastructure/db/database.js';
import * as entities from '../infrastructure/db/repositories/entity-repo.js';
import * as ops from '../infrastructure/db/repositories/consolidate-op-repo.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import { openResearchCase } from './research-view.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';
import type { RetypeUndo } from './consolidate-ops/retype.js';

function undoOf(raw: string | null): RetypeUndo | null {
  try {
    const v = JSON.parse(raw ?? 'null') as RetypeUndo | null;
    return v !== null &&
      typeof v.entityId === 'string' &&
      typeof v.fromManual === 'boolean' &&
      ENTITY_TYPES.includes(v.from) &&
      ENTITY_TYPES.includes(v.to)
      ? v
      : null;
  } catch {
    return null;
  }
}
export interface EntityTypeHistory {
  readonly type: EntityType;
  readonly manual: boolean;
  readonly changes: readonly {
    readonly opId: string;
    readonly from: EntityType;
    readonly to: EntityType;
    readonly at: number;
    readonly undone: boolean;
    readonly canUndo: boolean;
  }[];
}
export async function entityTypeHistory(
  dataRoot: string,
  slug: string,
  entityId: string,
): Promise<Result<EntityTypeHistory>> {
  const cid = correlationId();
  const db = await openResearchCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid);
  try {
    const entity = entities.getEntity(db, entityId);
    if (entity === null) return err('GRAPH_NODE_NOT_FOUND', cid);
    const archived = readCase(db)?.status === 'archived';
    let latest = true;
    const changes = ops.listRetypeOps(db, entityId).flatMap((op) => {
      const undo = undoOf(op.undoJson);
      if (undo === null) return [];
      const undone = undo.undoneAt !== undefined;
      const canUndo =
        !archived &&
        !undone &&
        latest &&
        entity.mergedInto === null &&
        entity.typeManual === true &&
        entity.type === undo.to;
      if (!undone) latest = false;
      return [
        { opId: op.id, from: undo.from, to: undo.to, at: op.executedAt ?? 0, undone, canUndo },
      ];
    });
    return ok({ type: entity.type, manual: entity.typeManual === true, changes }, cid);
  } finally {
    db.close();
  }
}
/** 只能依序退最後一個仍有效的人工決定，並恢復原本的保護標記。 */
export async function undoEntityType(
  dataRoot: string,
  slug: string,
  entityId: string,
  opId: string,
): Promise<Result<true>> {
  const cid = correlationId();
  const db = await openResearchCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid);
  try {
    if (readCase(db)?.status === 'archived') return err('CASE_ARCHIVED', cid);
    return withTransaction(db, () => {
      const entity = entities.getEntity(db, entityId);
      if (entity === null) return err('GRAPH_NODE_NOT_FOUND', cid);
      const current = ops.listRetypeOps(db, entityId).find((op) => {
        const undo = undoOf(op.undoJson);
        return undo !== null && undo.undoneAt === undefined;
      });
      const undo = undoOf(current?.undoJson ?? null);
      if (
        current?.id !== opId ||
        undo === null ||
        entity.mergedInto !== null ||
        !entity.typeManual ||
        entity.type !== undo.to
      )
        return err('CONSOLIDATE_OP_STALE', cid);
      const now = Date.now();
      entities.setEntityType(db, entityId, undo.from, undo.fromManual, now);
      ops.setState(db, {
        id: opId,
        state: 'done',
        runId: current.runId,
        undoJson: JSON.stringify({ ...undo, undoneAt: now }),
        executedAt: current.executedAt ?? now,
      });
      return ok(true, cid);
    });
  } finally {
    db.close();
  }
}
