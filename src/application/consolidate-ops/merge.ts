import { MERGE_OP_SCHEMA } from '../../domain/research/consolidate.js';
import { conformsTo } from '../../domain/provider/schema-check.js';
import type { ConsolidateOpDefinition, MergeExecution } from './types.js';
import { mergeEntity } from '../entity-service.js';

export function executeMergeOperation(input: MergeExecution) {
  return mergeEntity(
    input.dataRoot,
    input.slug,
    input.keep,
    input.drop,
    `consolidate:${input.runId}`,
  );
}

export const merge: ConsolidateOpDefinition = {
  kind: 'merge',
  schema: MERGE_OP_SCHEMA,
  validate: (payload) => conformsTo(MERGE_OP_SCHEMA, payload).ok,
  execute: executeMergeOperation,
  undoInfo: (mergedId) => ({ mergedId }),
};
