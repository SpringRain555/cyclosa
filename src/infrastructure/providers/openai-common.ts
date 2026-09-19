/**
 * OpenAI 相容 API 兩支 provider（對話 `chat-openai.ts`、找來源 `agent-openai.ts`）共用的東西：
 * 位址、`/models`、錯誤內文的遮蔽與截斷、狀態碼對映、退避時的等待。
 *
 * v0.24.2 之前這些是 `chat-openai.ts` 的私有函式。多了第二支之後抄一份會漂 ——
 * 而漂掉的那一種形狀是「一支遮了金鑰、另一支沒遮」。
 */
import type { ErrorCode } from '../../domain/errors/codes.js';
import { PROBE_TIMEOUT_MS, withTimeout } from './http.js';

export interface ModelEntry {
  readonly id?: unknown;
  /** OpenRouter 這類聚合服務會帶 */
  readonly context_length?: unknown;
  /** vLLM 會帶 */
  readonly max_model_len?: unknown;
}

export function rootOf(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export type ModelsResult =
  | { readonly kind: 'ok'; readonly models: readonly ModelEntry[] }
  | { readonly kind: 'auth'; readonly status: number }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'unreachable'; readonly detail: string };

export async function fetchModels(
  root: string,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<ModelsResult> {
  const t = withTimeout(PROBE_TIMEOUT_MS, signal);
  try {
    const res = await fetch(`${root}/models`, { signal: t.signal, headers });
    if (res.status === 401 || res.status === 403) return { kind: 'auth', status: res.status };
    if (!res.ok) return { kind: 'http', status: res.status };
    const body = (await res.json()) as { data?: unknown };
    return { kind: 'ok', models: Array.isArray(body.data) ? (body.data as ModelEntry[]) : [] };
  } catch (e) {
    return { kind: 'unreachable', detail: String((e as Error).message) };
  } finally {
    t.done();
  }
}

/** 對方有報就用；**沒報是 0 ＝ 不知道**，閘門對 0 放行（`missingFor`）。 */
export function contextOf(entry: ModelEntry): number {
  for (const v of [entry.context_length, entry.max_model_len]) {
    if (typeof v === 'number' && v > 0) return v;
  }
  return 0;
}

/** 退避時也要聽得到取消：被 abort 就丟出去，讓外面走「連不上／逾時」那條。 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 錯誤訊息只留開頭一小段，**而且把金鑰遮掉**。
 *
 * 對方的錯誤頁可能很長，而且**可能夾著我們送出去的東西** —— 有的伺服器
 * 會把請求標頭回顯在錯誤內文裡。這一段會進 `detail`，而 `detail` 會進日誌、
 * 進 `provider-checks.json`、會在求助時被整份貼出來。金鑰只存名字的那條規矩
 * 在這裡如果漏一格，就等於沒有那條規矩。
 *
 * 先遮再截：反過來的話，一把剛好跨在第 160 字上的金鑰會留下前半段。
 */
export function snippet(text: string, secret: string | null): string {
  const scrubbed = secret !== null && secret.length > 0 ? text.split(secret).join('***') : text;
  return scrubbed.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * 狀態碼 → 我們的碼。**401／403 與 429 不能歸成「連不上」** ——
 * 前者的下一步是檢查金鑰，後者是等一下，而「連不上」叫人去看它有沒有開。
 */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_REJECTED';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  return 'PROVIDER_UNREACHABLE';
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 這一刻的金鑰值，**只拿來遮蔽**，不存、不回傳。 */
export function secretOf(apiKeyEnv: string | null, env: NodeJS.ProcessEnv): string | null {
  const v = apiKeyEnv === null ? undefined : env[apiKeyEnv];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}
