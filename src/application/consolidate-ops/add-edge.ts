import { ADD_EDGE_OP_SCHEMA } from '../../domain/research/consolidate.js';
import { conformsTo } from '../../domain/provider/schema-check.js';
import type { ConsolidateOpDefinition, ExtractExecution } from './types.js';
import type { ErrorCode } from '../../domain/errors/codes.js';
import { locateQuote } from '../../domain/provider/quote.js';
import { scoreFor } from '../../domain/graph/index.js';
import { getEntity } from '../../infrastructure/db/repositories/entity-repo.js';
import { getItem } from '../../infrastructure/db/repositories/item-repo.js';
import { applyProposal, findByTriple } from '../../infrastructure/db/repositories/edge-repo.js';

export const executeAddEdgeOperation = (
  input: ExtractExecution,
): { readonly newEdges: number; readonly code: ErrorCode | null } => {
  const payload = input.addEdge;
  if (payload === undefined || !conformsTo(ADD_EDGE_OP_SCHEMA, payload).ok)
    return { newEdges: 0, code: 'CONSOLIDATE_OP_STALE' };
  const endpoint = (id: string): 'entity' | 'item' | null => {
    const entity = getEntity(input.db, id);
    if (entity !== null) return entity.mergedInto === null ? 'entity' : null;
    const item = getItem(input.db, id);
    return item !== null && (item.status === 'included' || item.status === 'parsed')
      ? 'item'
      : null;
  };
  const sourceKind = endpoint(payload.source);
  const targetKind = endpoint(payload.target);
  const item = getItem(input.db, payload.itemId);
  if (
    sourceKind === null ||
    targetKind === null ||
    payload.source === payload.target ||
    item === null ||
    item.kind === 'note' ||
    item.kind === 'reference' ||
    (item.status !== 'included' && item.status !== 'parsed')
  )
    return { newEdges: 0, code: 'CONSOLIDATE_OP_STALE' };
  const at = locateQuote(input.text, payload.quote);
  if (at.kind !== 'found') return { newEdges: 0, code: 'PROVIDER_QUOTE_NOT_FOUND' };
  const existing = findByTriple(input.db, payload);
  if (existing !== null && existing.layer !== 'named')
    return { newEdges: 0, code: 'CONSOLIDATE_OP_STALE' };
  const result = applyProposal(
    input.db,
    {
      source: payload.source,
      target: payload.target,
      sourceKind,
      targetKind,
      rel: payload.rel,
      layer: 'named',
      confidence: scoreFor({ independentSourceCount: 1, hasDirectQuote: true }),
      evidence: [
        {
          itemId: payload.itemId,
          quote: input.text.slice(at.start, at.end),
          charStart: at.start,
          charEnd: at.end,
        },
      ],
      runId: input.runId,
    },
    Date.now(),
  );
  return {
    newEdges: result.kind === 'created' || result.kind === 'revived' ? 1 : 0,
    code: result.kind === 'blocked-by-tombstone' ? 'GRAPH_TOMBSTONED' : null,
  };
};

export const addEdge: ConsolidateOpDefinition = {
  kind: 'add-edge',
  schema: ADD_EDGE_OP_SCHEMA,
  validate: (payload) => conformsTo(ADD_EDGE_OP_SCHEMA, payload).ok,
  execute: executeAddEdgeOperation,
  undoInfo: (runId) => ({ runId }),
};
