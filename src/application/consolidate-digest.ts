import type { DatabaseSync } from '../infrastructure/db/database.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as ops from '../infrastructure/db/repositories/consolidate-op-repo.js';
import { readDerived } from '../infrastructure/fs/case-files.js';
import { isUndigested } from '../domain/research/undigested.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as research from '../infrastructure/db/repositories/research-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import type { ErrorCode } from '../domain/errors/codes.js';
import type { Providers } from '../infrastructure/providers/registry.js';
import type { ChatProvider, CallCost } from '../infrastructure/providers/types.js';
import type { ActiveRun } from './run-registry.js';
import { callDigest } from './digest-call.js';
import { DIGEST_SYSTEM } from './research-prompts.js';
import { recordModelCall } from './model-call-log.js';
import { executeDigestOperation } from './consolidate-ops/digest.js';

export async function listUndigestedItems(db: DatabaseSync, folder: string) {
  const out: { id: string; title: string; chars: number }[] = [];
  for (const id of ops.listItemIds(db)) {
    const item = items.getItem(db, id);
    if (item === null || !isUndigested({ ...item, hasBody: true })) continue;
    const derived = await readDerived(folder, id);
    if (derived !== null && derived.text.trim().length > 0)
      out.push({ id, title: item.title, chars: derived.text.length });
  }
  return out;
}

export async function performConsolidateDigest(input: {
  db: DatabaseSync;
  folder: string;
  itemId: string;
  providers: Providers;
  chat: ChatProvider;
  state: ActiveRun;
  abort: AbortController;
}): Promise<{ code: ErrorCode | null; written: boolean; cost: CallCost | null }> {
  const { db, state, itemId } = input;
  const stale = { code: 'CONSOLIDATE_OP_STALE', written: false, cost: null } as const;
  const live = (): boolean => {
    const run = runs.getRun(db, state.runId);
    const owner =
      run?.researchId === null || run?.researchId === undefined
        ? null
        : research.getResearch(db, run.researchId);
    return (
      !state.cancelled &&
      readCase(db)?.status !== 'archived' &&
      owner?.status === 'building' &&
      owner.buildRunId === state.runId
    );
  };
  const before = items.getItem(db, itemId);
  const derived = await readDerived(input.folder, itemId);
  const atCall = items.getItem(db, itemId);
  if (
    !live() ||
    before === null ||
    atCall === null ||
    atCall.updatedAt !== before.updatedAt ||
    derived === null ||
    !isUndigested({ ...atCall, hasBody: derived.text.trim().length > 0 })
  )
    return stale;
  const { call, user, digest } = await callDigest(
    input.chat,
    {
      topic: readCase(db)?.seed ?? readCase(db)?.name ?? '',
      relation: '',
      directions: [],
      title: derived.title.trim().length > 0 ? derived.title : before.title,
      url: before.sourceUrl ?? before.requestedUrl ?? '',
      excerpt: derived.text,
    },
    input.abort,
  );
  const code =
    call.kind === 'error' ? call.code : digest === null ? 'PROVIDER_OUTPUT_SCHEMA_MISMATCH' : null;
  await recordModelCall(input.providers, input.folder, {
    task: 'digest',
    role: 'chat',
    model: input.chat.name,
    runId: state.runId,
    correlationId: state.runId,
    itemId,
    system: DIGEST_SYSTEM,
    user,
    text: call.kind === 'ok' ? JSON.stringify(call.value) : null,
    errorDetail: call.kind === 'error' ? call.detail : null,
    ok: code === null,
    code,
    elapsedMs: call.cost.elapsedMs,
    costUsd: call.cost.costUsd,
  });
  if (!live()) return { ...stale, cost: call.cost };
  if (code !== null || digest === null) return { code, written: false, cost: call.cost };
  const current = await readDerived(input.folder, itemId);
  if (
    !live() ||
    current === null ||
    current.text !== derived.text ||
    current.title !== derived.title
  )
    return { ...stale, cost: call.cost };
  const applied = executeDigestOperation({
    db,
    itemId,
    expectedUpdatedAt: before.updatedAt,
    digest,
    model: input.chat.name,
  });
  return { ...applied, cost: call.cost };
}
