import { RETYPE_OP_SCHEMA } from '../../domain/research/consolidate.js';
import { conformsTo } from '../../domain/provider/schema-check.js';
import type { EntityType } from '../../domain/provider/relations.js';
import { withTransaction, type DatabaseSync } from '../../infrastructure/db/database.js';
import { readCase } from '../../infrastructure/db/repositories/case-repo.js';
import * as ops from '../../infrastructure/db/repositories/consolidate-op-repo.js';
import * as entities from '../../infrastructure/db/repositories/entity-repo.js';
import type { ConsolidateOpDefinition } from './types.js';

export interface RetypeUndo {
  readonly entityId: string;
  readonly from: EntityType;
  readonly fromManual: boolean;
  readonly to: EntityType;
  readonly undoneAt?: number;
}
export interface RetypeExecution {
  readonly db: DatabaseSync;
  readonly entityId: string;
  readonly to: EntityType;
  readonly expectedRevision?: string;
  readonly completed: (undo: RetypeUndo) => void;
}
/** 包含已復原的修改，避免型別改回相同值後，舊請求誤以為沒有變過。 */
export function entityTypeRevision(db: DatabaseSync, entityId: string): string {
  const entity = entities.getEntity(db, entityId);
  return JSON.stringify({
    type: entity?.type,
    manual: entity?.typeManual,
    changes: ops.listRetypeOps(db, entityId).map((op) => [op.id, op.undoJson]),
  });
}
/** 舊值、人工標記與執行紀錄在同一交易提交。 */
export function executeRetypeOperation(input: RetypeExecution): boolean {
  return withTransaction(input.db, () => {
    if (readCase(input.db)?.status === 'archived') return false;
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== entityTypeRevision(input.db, input.entityId)
    )
      return false;
    const entity = entities.getEntity(input.db, input.entityId);
    if (entity === null || entity.mergedInto !== null || entity.type === input.to) return false;
    const undo: RetypeUndo = {
      entityId: entity.id,
      from: entity.type,
      fromManual: entity.typeManual === true,
      to: input.to,
    };
    entities.setEntityType(input.db, entity.id, input.to, true, Date.now());
    input.completed(undo);
    return true;
  });
}
export const retype: ConsolidateOpDefinition = {
  kind: 'retype',
  schema: RETYPE_OP_SCHEMA,
  validate: (payload) => conformsTo(RETYPE_OP_SCHEMA, payload).ok,
  execute: executeRetypeOperation,
  undoInfo: (opId) => ({ opId }),
};
