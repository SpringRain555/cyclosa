import { MERGE_OP_SCHEMA } from '../../domain/research/consolidate.js';
import { conformsTo } from '../../domain/provider/schema-check.js';
import type { ConsolidateOpDefinition } from './types.js';

export const merge: ConsolidateOpDefinition = {
  kind: 'merge',
  schema: MERGE_OP_SCHEMA,
  validate: (payload) => conformsTo(MERGE_OP_SCHEMA, payload).ok,
  execute: null,
  undoInfo: null,
};
