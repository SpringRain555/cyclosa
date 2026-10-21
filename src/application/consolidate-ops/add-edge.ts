import { ADD_EDGE_OP_SCHEMA } from '../../domain/research/consolidate.js';
import { conformsTo } from '../../domain/provider/schema-check.js';
import type { ConsolidateOpDefinition } from './types.js';

export const addEdge: ConsolidateOpDefinition = {
  kind: 'add-edge',
  schema: ADD_EDGE_OP_SCHEMA,
  validate: (payload) => conformsTo(ADD_EDGE_OP_SCHEMA, payload).ok,
  execute: null,
  undoInfo: null,
};
