import { expect, it } from 'vitest';

import {
  CONSOLIDATE_OP_KINDS,
  type ConsolidateOpKind,
} from '../../src/domain/research/consolidate.js';
import { operationOf } from '../../src/application/consolidate-ops/registry.js';

const examples: Readonly<Record<ConsolidateOpKind, unknown>> = {
  merge: { keep: 'kept', drop: 'merged' },
  extract: { itemIds: ['item'] },
  'add-edge': {
    source: 'entity',
    target: 'item',
    rel: 'supports',
    itemId: 'item',
    quote: '這是一段足夠長的引文',
  },
  retype: { entityId: 'entity', to: 'person' },
  digest: { itemIds: ['item'] },
};

it('每種整理操作都登記 schema 與 payload validate', () => {
  for (const kind of CONSOLIDATE_OP_KINDS) {
    const operation = operationOf(kind);
    expect(operation.kind).toBe(kind);
    expect(operation.schema).toBeDefined();
    expect(typeof operation.validate).toBe('function');
    expect(operation.validate(examples[kind]), kind).toBe(true);
    expect(operation.validate(null), kind).toBe(false);
    expect(operation.execute !== null, kind).toBe(true);
    expect(operation.undoInfo !== null, kind).toBe(kind !== 'digest');
  }
});
