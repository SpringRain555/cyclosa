import { DIGEST_OP_SCHEMA } from '../../domain/research/consolidate.js';
import { conformsTo } from '../../domain/provider/schema-check.js';
import type { ConsolidateOpDefinition } from './types.js';
import type { DigestExecution, AppliedDigest } from './types.js';
import { isUndigested } from '../../domain/research/undigested.js';
import { getItem, setItemDigest } from '../../infrastructure/db/repositories/item-repo.js';

export function executeDigestOperation(input: DigestExecution): AppliedDigest {
  const item = getItem(input.db, input.itemId);
  if (
    item === null ||
    item.updatedAt !== input.expectedUpdatedAt ||
    !isUndigested({ ...item, hasBody: true })
  )
    return { written: false, code: 'CONSOLIDATE_OP_STALE' };
  setItemDigest(input.db, {
    id: item.id,
    titleZh: input.digest.titleZh,
    summaryZh: input.digest.summaryZh,
    digestedBy: input.model,
    now: Date.now(),
  });
  return { written: true, code: null };
}

export const digest: ConsolidateOpDefinition = {
  kind: 'digest',
  schema: DIGEST_OP_SCHEMA,
  validate: (payload) => conformsTo(DIGEST_OP_SCHEMA, payload).ok,
  execute: executeDigestOperation,
  undoInfo: null,
};
