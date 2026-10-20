import { DIGEST_OP_SCHEMA } from '../../domain/research/consolidate.js';
import { conformsTo } from '../../domain/provider/schema-check.js';
import type { ConsolidateOpDefinition } from './types.js';

export const digest: ConsolidateOpDefinition = {
  kind: 'digest',
  schema: DIGEST_OP_SCHEMA,
  validate: (payload) => conformsTo(DIGEST_OP_SCHEMA, payload).ok,
  execute: null,
  undoInfo: null,
};
