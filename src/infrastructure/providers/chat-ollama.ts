/**
 * 本機 Ollama 當 `chat`。
 *
 * ## 能力宣告盡量去問它自己
 *
 * `GET /api/tags` 每個模型帶一個 `capabilities` 陣列
 * （`["completion","tools","thinking"]`、`["completion","vision"]`…）
 * 與 `details.context_length`。**那是 provider 自己說的，比我們填的準。**
 *
 * ADR-0006 的代價那一節寫著「能力宣告要人工維護，而**不準的宣告比沒有宣告更糟**」——
 * 這一支就是把「人工維護」的份量壓到最小的做法。
 *
 * 只有一欄是我們填的：`json_schema`。
 * 它是**伺服器的功能不是模型的功能** —— Ollama 的 `format` 參數收一份 JSON schema
 * 並用受限解碼保證輸出符合它，所以只要連得上就是 `true`。
 * 而 `browse` 一律 `false`：一個對話端點沒有那種東西。
 *
 * ## 為什麼用 `/api/chat` 而不是 `/v1/chat/completions`
 *
 * OpenAI 相容那條路的 `response_format` 只到 `json_object`
 * （「回一份 JSON」），而我們要的是**符合這份 schema 的 JSON**。
 * `/api/chat` 的 `format` 收整份 schema。差別就是 `TASK_ANGLES`
 * 需要 `json_schema` 而不是「會不會輸出 JSON」的那個差別。
 */
import type { ProviderCapabilities } from '../../domain/provider/index.js';
import type { CallOutcome, ChatProvider, ProbeResult } from './types.js';

interface TagsModel {
  readonly name?: unknown;
  readonly capabilities?: unknown;
  readonly details?: { readonly context_length?: unknown };
}

/** 連不上與逾時要分得開，所以逾時自己帶一個訊號。 */
const PROBE_TIMEOUT_MS = 5000;
const CHAT_TIMEOUT_MS = 180_000;

interface Timed {
  readonly signal: AbortSignal;
  /** **我們的計時器燒掉了**，而不是外面取消。兩者的碼不一樣 */
  timedOut: boolean;
  done(): void;
}

function withTimeout(ms: number, outer?: AbortSignal): Timed {
  const controller = new AbortController();
  const state: Timed = {
    signal: controller.signal,
    timedOut: false,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new Error('timeout'));
  }, ms);
  const onAbort = (): void => controller.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return state;
}

export function capabilitiesOf(model: TagsModel): ProviderCapabilities {
  const caps = Array.isArray(model.capabilities) ? (model.capabilities as unknown[]) : [];
  const has = (name: string): boolean => caps.includes(name);
  const ctx = model.details?.context_length;
  return {
    // 對話端點自己上不了網。**這一欄永遠是 false，而那不是缺陷** ——
    // 上網那一步是 agent 的工作，而 agent 找到 URL 之後也不自己抓。
    browse: false,
    tools: has('tools'),
    // 伺服器功能：`format` 收整份 schema 並用受限解碼保證它。
    json_schema: true,
    vision: has('vision'),
    // **0 代表不知道，不代表 0。** `/api/tags` 對某些模型不帶這一欄，
    // 而 `missingFor` 對 0 是放行的（理由寫在那一支）。
    context_tokens: typeof ctx === 'number' && ctx > 0 ? ctx : 0,
  };
}

/** 偵測到的模型清單。**設定頁要用它** —— 不然使用者只能猜模型名怎麼拼。 */
export async function listOllamaModels(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<readonly string[] | null> {
  const t = withTimeout(PROBE_TIMEOUT_MS, signal);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { signal: t.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: unknown };
    const models = Array.isArray(body.models) ? (body.models as TagsModel[]) : [];
    return models.map((m) => String(m.name ?? '')).filter((n) => n.length > 0);
  } catch {
    return null;
  } finally {
    t.done();
  }
}

export function createOllamaChat(baseUrl: string, model: string): ChatProvider {
  const root = baseUrl.replace(/\/$/, '');

  async function findModel(signal?: AbortSignal): Promise<TagsModel | null | 'unreachable'> {
    const t = withTimeout(PROBE_TIMEOUT_MS, signal);
    try {
      const res = await fetch(`${root}/api/tags`, { signal: t.signal });
      if (!res.ok) return 'unreachable';
      const body = (await res.json()) as { models?: unknown };
      const models = Array.isArray(body.models) ? (body.models as TagsModel[]) : [];
      return models.find((m) => String(m.name ?? '') === model) ?? null;
    } catch {
      return 'unreachable';
    } finally {
      t.done();
    }
  }

  return {
    name: `ollama:${model}`,

    async probe(signal?: AbortSignal): Promise<ProbeResult> {
      if (model.length === 0) return { kind: 'not-configured' };
      const found = await findModel(signal);
      if (found === 'unreachable') return { kind: 'unreachable', detail: root };
      // **設定了一個沒有拉下來的模型 ＝ 沒設定。**
      // 設定頁會把偵測到的清單列出來，所以「為什麼」看得見。
      if (found === null) return { kind: 'not-configured' };
      return { kind: 'ready', model, capabilities: capabilitiesOf(found) };
    },

    async json(input, signal): Promise<CallOutcome<unknown>> {
      const started = Date.now();
      // **本機模型沒有金額成本，而那是事實不是「不知道」** —— 所以是 0 不是 null。
      const cost = { costUsd: 0, elapsedMs: 0 };
      const t = withTimeout(CHAT_TIMEOUT_MS, signal);
      try {
        const res = await fetch(`${root}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            format: input.schema,
            // 溫度壓到 0：這不是創作，是**從既有內容歸納**。
            options: { temperature: 0 },
            messages: [
              { role: 'system', content: input.system },
              { role: 'user', content: input.user },
            ],
          }),
          signal: t.signal,
        });
        const elapsedMs = Date.now() - started;
        if (!res.ok) {
          return {
            kind: 'error',
            code: 'PROVIDER_UNREACHABLE',
            detail: `HTTP ${res.status}`,
            cost: { ...cost, elapsedMs },
          };
        }
        const body = (await res.json()) as { message?: { content?: unknown } };
        const content = typeof body.message?.content === 'string' ? body.message.content : '';
        try {
          return { kind: 'ok', value: JSON.parse(content), cost: { ...cost, elapsedMs } };
        } catch {
          // 宣告了 `json_schema` 卻回了不是 JSON 的東西 —— **那是 provider 沒守約定**，
          // 不是我們解析錯了。把它報成 `PROVIDER_OUTPUT_UNPARSEABLE` 而不是靜默略過。
          return {
            kind: 'error',
            code: 'PROVIDER_OUTPUT_UNPARSEABLE',
            detail: `${content.length} 個字元`,
            cost: { ...cost, elapsedMs },
          };
        }
      } catch (e) {
        const elapsedMs = Date.now() - started;
        // **逾時與取消不是同一件事，連不上又是第三件。**
        // 取消時這個碼不會被顯示（呼叫端先看到 run 已取消就停了），
        // 但把它寫成 `PROVIDER_TIMEOUT` 會在診斷檔裡留下一句假話。
        return {
          kind: 'error',
          code: t.timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE',
          detail: String((e as Error).message),
          cost: { ...cost, elapsedMs },
        };
      } finally {
        t.done();
      }
    },
  };
}
