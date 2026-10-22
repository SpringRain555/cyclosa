import { missingFor, normalizeDigest, TASK_DIGEST } from '../domain/provider/index.js';
import type { Providers } from '../infrastructure/providers/registry.js';
import type { ChatProvider, CallOutcome } from '../infrastructure/providers/types.js';
import { err, ok, type Result } from '../shared/result.js';
import {
  DIGEST_SCHEMA,
  DIGEST_SYSTEM,
  digestUser,
  type DigestPromptInput,
} from './research-prompts.js';

/** 研究與整理共用初讀任務檢查；開作業前就指出哪個任務配不上。 */
export async function checkDigest(
  providers: Providers,
  cid: string,
): Promise<Result<ChatProvider>> {
  const who = { role: 'chat', task: 'digest' } as const;
  const chat = providers.chatFor('digest');
  if (chat === null) return err('PROVIDER_NOT_CONFIGURED', cid, who);
  const probe = await chat.probe();
  if (probe.kind === 'not-configured') return err('PROVIDER_NOT_CONFIGURED', cid, who);
  if (probe.kind === 'unreachable')
    return err('PROVIDER_UNREACHABLE', cid, { ...who, at: probe.detail });
  const match = missingFor(TASK_DIGEST, probe.capabilities);
  if (match.kind === 'missing')
    return err('PROVIDER_CAPABILITY_MISSING', cid, {
      ...who,
      missing: match.flags,
      ...(match.context === null
        ? {}
        : { needContextTokens: match.context[0], haveContextTokens: match.context[1] }),
    });
  let json = await chat.jsonMode();
  if (json.mode === 'unchecked' && chat.checkJson !== undefined) {
    const measured = await chat.checkJson();
    if (measured.kind === 'error') return err(measured.code, cid, who);
    json = measured.value;
  }
  if (json.mode === 'none' || json.mode === 'unchecked')
    return err('PROVIDER_JSON_UNSUPPORTED', cid, who);
  return ok(chat, cid);
}

/** 同一套提示詞、正文截斷與外部輸入正規化，不寫候選或資料。 */
export async function callDigest(
  chat: ChatProvider,
  input: DigestPromptInput,
  abort: AbortController,
) {
  const user = digestUser(input);
  const startedAt = Date.now();
  let call: CallOutcome<unknown>;
  try {
    call = await chat.json({ system: DIGEST_SYSTEM, user, schema: DIGEST_SCHEMA }, abort.signal);
  } catch {
    call = {
      kind: 'error',
      code: 'PROVIDER_UNEXPECTED',
      detail: 'digest provider failed',
      cost: { costUsd: null, elapsedMs: Date.now() - startedAt },
    };
  }
  return { call, user, digest: call.kind === 'ok' ? normalizeDigest(call.value) : null };
}
