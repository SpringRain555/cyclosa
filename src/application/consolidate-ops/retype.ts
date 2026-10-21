import { RETYPE_OP_SCHEMA } from '../../domain/research/consolidate.js';
import { conformsTo } from '../../domain/provider/schema-check.js';
import type { ConsolidateOpDefinition } from './types.js';

export const retype: ConsolidateOpDefinition = {
  kind: 'retype',
  schema: RETYPE_OP_SCHEMA,
  validate: (payload) => conformsTo(RETYPE_OP_SCHEMA, payload).ok,
  execute: null,
  undoInfo: null,
};
