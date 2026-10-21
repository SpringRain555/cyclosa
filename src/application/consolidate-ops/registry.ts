import type { ConsolidateOpKind } from '../../domain/research/consolidate.js';
import { addEdge } from './add-edge.js';
import { digest } from './digest.js';
import { extract } from './extract.js';
import { merge } from './merge.js';
import { retype } from './retype.js';
import type { ConsolidateOpDefinition } from './types.js';

export const CONSOLIDATE_OP_REGISTRY: Readonly<Record<ConsolidateOpKind, ConsolidateOpDefinition>> =
  {
    merge,
    extract,
    'add-edge': addEdge,
    retype,
    digest,
  };

export function operationOf(kind: ConsolidateOpKind): ConsolidateOpDefinition {
  return CONSOLIDATE_OP_REGISTRY[kind];
}
