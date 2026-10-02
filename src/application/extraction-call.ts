import type { ErrorCode } from '../domain/errors/codes.js';
import {
  missingFor,
  normalizeExtraction,
  TASK_EXTRACT,
  type Extraction,
} from '../domain/provider/index.js';
import type { Providers } from '../infrastructure/providers/registry.js';
import type { ChatProvider } from '../infrastructure/providers/types.js';
import { err, ok, type Result } from '../shared/result.js';
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM, extractUser } from './extraction-prompts.js';

type CallExtractOutcome =
  | {
      readonly kind: 'ok';
      readonly extraction: Extraction;
      readonly costUsd: number | null;
      readonly elapsedMs: number;
    }
  | {
      readonly kind: 'error';
      readonly code: ErrorCode;
      readonly costUsd: number | null;
      readonly elapsedMs: number;
    };

/**
 * 抽取那一支配不配得上：設定了、連得上、能力夠、JSON 有保證。
 *
 * 研究建圖（閘門三）與「抽進圖」（整理的第一片）**開作業之前**都先問這一次 ——
 * 反過來的話，一次「服務沒設定」會留下一筆開了卻什麼都沒做的作業。
 */
export async function checkExtract(
  providers: Providers,
  cid: string,
): Promise<Result<{ chat: ChatProvider; mode: string }>> {
  const who = { role: 'chat', task: 'extract' };
  const chat = providers.chatFor('extract');
  if (chat === null) return err('PROVIDER_NOT_CONFIGURED', cid, who);
  const probe = await chat.probe();
  if (probe.kind === 'not-configured') return err('PROVIDER_NOT_CONFIGURED', cid, who);
  if (probe.kind === 'unreachable')
    return err('PROVIDER_UNREACHABLE', cid, { ...who, at: probe.detail });
  const match = missingFor(TASK_EXTRACT, probe.capabilities);
  if (match.kind === 'missing')
    return err('PROVIDER_CAPABILITY_MISSING', cid, {
      ...who,
      missing: match.flags,
      ...(match.context === null
        ? {}
        : { needContextTokens: match.context[0], haveContextTokens: match.context[1] }),
    });
  let format = await chat.jsonMode();
  if (format.mode === 'unchecked' && chat.checkJson !== undefined) {
    const checked = await chat.checkJson();
    if (checked.kind === 'error') return err(checked.code, cid, who);
    format = checked.value;
  }
  if (format.mode === 'none' || format.mode === 'unchecked')
    return err('PROVIDER_JSON_UNSUPPORTED', cid, who);
  return ok({ chat, mode: format.mode }, cid);
}

export async function callExtract(
  chat: ChatProvider,
  derived: { readonly title: string; readonly text: string },
  abort: AbortController,
): Promise<CallExtractOutcome> {
  const call = await chat.json(
    {
      system: EXTRACT_SYSTEM,
      user: extractUser(derived.title, derived.text),
      schema: EXTRACT_SCHEMA,
    },
    abort.signal,
  );
  if (call.kind === 'error')
    return {
      kind: 'error',
      code: call.code,
      costUsd: call.cost.costUsd,
      elapsedMs: call.cost.elapsedMs,
    };
  return {
    kind: 'ok',
    extraction: normalizeExtraction(call.value),
    costUsd: call.cost.costUsd,
    elapsedMs: call.cost.elapsedMs,
  };
}
