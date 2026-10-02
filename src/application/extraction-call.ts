import type { ErrorCode } from '../domain/errors/codes.js';
import { normalizeExtraction, type Extraction } from '../domain/provider/index.js';
import type { ChatProvider } from '../infrastructure/providers/types.js';
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
