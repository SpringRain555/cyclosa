/**
 * OpenAI 相容 API 當 `chat`。
 *
 * 線上的（各家 API、訂閱的代理）與別家本機伺服器（vLLM、LM Studio、llama.cpp 的 server）
 * 都說這一種協定：`GET {baseUrl}/models`，然後 `POST {baseUrl}/responses`（Responses API）
 * 或 `POST {baseUrl}/chat/completions`（Chat Completions）。`baseUrl` 照各家文件的寫法**含 `/v1`**。
 *
 * ## 先走 Responses API，沒有那條路才退回 Chat Completions（v0.24.2，ADR-0034）
 *
 * 2026-09-19 使用者說「調用時用 responses format，不要用 chat format」—— 他那一條端點原生說的
 * 是 Responses API，Chat Completions 在那上面是一層翻譯；而**網頁搜尋只有 Responses API 有**，
 * 找來源那一支（`agent-openai.ts`）沒有別條路。所以對話也走這一條，同一個端點只有一種協定、一份量測。
 * `/responses` 回 404（或 405、501）的端點才退回 Chat Completions，**而且走的是哪一種記在量測裡、
 * 畫面上說得出來**（`JsonModeReport.protocol`）。兩條路的 body 由 `ask()` 各自組，其餘邏輯共用。
 *
 * ## 「符合 schema」這件事，這裡是量的，不是宣告的
 *
 * 各家對 `response_format`／`text.format` 的支援不一樣，而且**會變**：
 * 這個專案自己寫過一句「OpenAI 相容那條路只到 `json_object`」，
 * 2026-09-11 重量一次就不成立了（Ollama 0.33.2 的 `/v1` 支援 `json_schema`）。
 * 所以每一個「端點＋模型」各量一次（`checkJson`），結果帶著時間存在
 * `provider-checks.json`，**第一次真的跑任務之前沒量過就先量**。
 *
 * 量出來的三種結果決定怎麼送：
 *
 * | 結果 | 怎麼送 | 誰保證形狀 |
 * |---|---|---|
 * | `schema` | `json_schema`（Responses 是 `text.format`，Chat 是 `response_format`）| 端點 |
 * | `object` | `json_object`，schema 寫進系統提示 | **這一側事後驗證** |
 * | `none` | 不送 | —— 需要結構化輸出的任務停手（`PROVIDER_JSON_UNSUPPORTED`）|
 *
 * **兩種模式都會驗**（`conformsTo`）。`schema` 模式下驗不過代表端點說它支援
 * 卻沒有做到 —— 那也要擋，而且要說出來。
 *
 * ## 降級是看得見的，那是它跟「靜默降級」的差別
 *
 * ADR-0006 第 3 條：配不上就停手，**不靜默降級**。`object` 模式是一種降級 ——
 * 保證從「生不出來」變成「生出來會被擋」—— 而它被允許的理由是
 * **它守住的性質沒有變**（能通過的只有 schema 描述的形狀），而且：
 * 設定頁顯示是哪一種、什麼時候量的；作業紀錄寫下這次用的是哪一種。
 * （ADR-0030）
 *
 * ## 刻意沒有的東西
 *
 * - **沒有 `think`、沒有 `num_ctx`**：OpenAI 協定裡沒有這兩個欄位，
 *   送不認得的欄位有的端點會直接 400。context 由對方伺服器管 ——
 *   而那正是本機 Ollama 要留在原生協定的理由（`config.ts` 的 `ChatTransport`）
 * - **429 照 OpenAI 官方 SDK 的做法退避重試**（`domain/provider/rate-limit.ts`：遵守 `Retry-After`，
 *   沒有就 0.5 秒 × 2ⁿ，最多兩次），還是 429 才回 `PROVIDER_RATE_LIMITED`。
 *   2026-09-13 之前是「立刻停不重試」—— 那是 agent 做調查時的姿態，對 LLM 端點是錯的。
 *   **形狀不對不重問** —— 那會讓結果來自一組跟畫面上顯示的不同的條件
 * - **沒有成本上限**：這個協定不回報金額（`usage` 只有 token 數），
 *   所以 `costUsd` 是 `null` —— 不知道，不是 0
 * - **Responses API 上一律串流**：使用者那一條代理不串流的時候回 `output: []`
 *   （`responses-api.ts` 檔頭）。這裡沒有逐字顯示的需求，讀完整個事件流再組回來。
 */
import {
  conformsTo,
  strictify,
  parseRetryAfter,
  providerRetryDelayMs,
  type ProviderCapabilities,
} from '../../domain/provider/index.js';
import type { ErrorCode } from '../../domain/errors/codes.js';
import { CHAT_TIMEOUT_MS, authHeader, withTimeout } from './http.js';
import {
  checkKey,
  readJsonChecks,
  writeJsonCheck,
  type JsonCheck,
  type MeasuredJsonMode,
  type OpenAiProtocol,
} from './json-checks.js';
import {
  codeForStatus,
  contextOf,
  fetchModels,
  parseJson,
  rootOf,
  secretOf,
  sleepUnlessAborted,
  snippet,
} from './openai-common.js';
import { hasNoResponsesRoute, parseResponsesBody, sendResponses } from './responses-api.js';
import type { CallOutcome, ChatProvider, JsonModeReport, ProbeResult } from './types.js';

/**
 * `/models` 列得出來的東西。**`null` ＝ 列不出來**（連不上、被拒、或位址不對），
 * 不是「一個都沒有」。
 */
export async function listOpenAiModels(
  baseUrl: string,
  apiKeyEnv: string | null,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<readonly string[] | null> {
  const found = await fetchModels(rootOf(baseUrl), authHeader(apiKeyEnv, env), signal);
  return found.kind === 'ok' ? found.models.map((m) => String(m.id ?? '')).filter(Boolean) : null;
}

// ── 格式量測 ──────────────────────────────────────────────

/**
 * 量測用的 schema：**模型不可能自己猜到的值。**
 *
 * 只有一個允許值的 `enum`、一個必須剛好是 7 的整數。提示詞往反方向拉
 * （「用一句話介紹你自己，不要用 JSON」）—— 所以輸出長成這樣只有一個原因：
 * schema 真的被套用了。**收了 `response_format` 卻安靜忽略的端點，
 * 在這一題會回一句自我介紹**，而那會被分到下一級，不是被當成支援。
 */
export const PROBE_SCHEMA = {
  type: 'object',
  properties: {
    probe: { type: 'string', enum: ['cyclosa-json-schema-probe'] },
    n: { type: 'integer', minimum: 7, maximum: 7 },
  },
  required: ['probe', 'n'],
  additionalProperties: false,
} as const;

const PULL_AWAY = {
  system: '回答使用者的問題。',
  user: '用一句話介紹你自己。不要用 JSON，用一般的句子。',
};
const ASK_JSON = {
  system: '只回 JSON。',
  user: '回一個 JSON 物件，裡面有一個欄位 ok，值是 true。',
};

/** 要端點保證什麼形狀。兩種協定各自有寫法，但要的是同一件事。 */
type OutputFormat =
  | { readonly kind: 'schema'; readonly schema: Readonly<Record<string, unknown>> }
  | { readonly kind: 'object' };

interface AskRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly format: OutputFormat;
}

/** 一次對話請求的結果，**兩種協定收斂成同一個形狀**，後面的判斷只寫一份。 */
type Asked =
  | {
      readonly kind: 'answer';
      readonly content: string;
      /** 有值 ＝ 輸出在上限用完時停了，值是給人看的一句話 */
      readonly truncated: string | null;
    }
  | { readonly kind: 'http'; readonly status: number; readonly text: string }
  /** 對方回了 200 卻說這一次失敗或沒收尾（只有 Responses API 有這種） */
  | { readonly kind: 'failed'; readonly detail: string }
  | { readonly kind: 'thrown'; readonly detail: string; readonly timedOut: boolean };

/**
 * 嚴格模式有它自己的形狀要求（每個物件都要 `additionalProperties: false`、`required` 要列全），
 * 而那是端點的要求不是我們的規則 —— 所以在這裡補，不改那三份 schema（`strictify` 的檔頭寫了為什麼）。
 */
function strictSchemaOf(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { name: 'cyclosa', strict: true, schema: strictify(schema) };
}

/** Chat Completions：`POST /chat/completions`，不串流。 */
async function askChat(
  root: string,
  headers: Readonly<Record<string, string>>,
  req: AskRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Asked> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    response_format:
      req.format.kind === 'schema'
        ? { type: 'json_schema', json_schema: strictSchemaOf(req.format.schema) }
        : { type: 'json_object' },
  };
  // **逾時是整次呼叫的預算，含退避的等待** —— 不是每一次重試各自一份。
  const t = withTimeout(timeoutMs, signal);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${root}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ stream: false, temperature: 0, ...body }),
        signal: t.signal,
      });
      const text = await res.text();
      if (res.status === 429) {
        // 端點說排隊。照它說的等（`Retry-After`），沒說就 0.5 秒 × 2ⁿ；最多兩次。
        const delay = providerRetryDelayMs(
          parseRetryAfter(res.headers.get('retry-after'), Date.now()),
          attempt,
        );
        if (delay !== 'give-up') {
          await sleepUnlessAborted(delay, t.signal);
          continue;
        }
      }
      if (!res.ok) return { kind: 'http', status: res.status, text };
      const json = JSON.parse(text) as {
        choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
      };
      const choice = json.choices?.[0];
      return {
        kind: 'answer',
        content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
        // 被截斷的空回應跟「模型壞了」下一步不同 —— 把對方自己說的理由帶出去。
        truncated:
          choice?.finish_reason === 'length'
            ? '回應被截斷（finish_reason=length）—— 輸出在長度上限用完時停了'
            : null,
      };
    }
  } catch (e) {
    return { kind: 'thrown', detail: String((e as Error).message), timedOut: t.timedOut };
  } finally {
    t.done();
  }
}

/** Responses API：`POST /responses`，串流（`responses-api.ts`）。 */
async function askResponses(
  root: string,
  headers: Readonly<Record<string, string>>,
  req: AskRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Asked> {
  const sent = await sendResponses(
    root,
    headers,
    {
      model: req.model,
      instructions: req.system,
      input: req.user,
      temperature: 0,
      text: {
        format:
          req.format.kind === 'schema'
            ? { type: 'json_schema', ...strictSchemaOf(req.format.schema) }
            : { type: 'json_object' },
      },
    },
    timeoutMs,
    signal,
  );
  if (sent.kind !== 'body') return sent;
  const answer = parseResponsesBody(sent.raw);
  if (answer.status === 'failed') {
    return { kind: 'failed', detail: `對方回報失敗：${answer.reason}` };
  }
  if (answer.status === 'unfinished') return { kind: 'failed', detail: '串流沒有收尾就斷了' };
  return {
    kind: 'answer',
    content: answer.text,
    truncated:
      answer.status === 'incomplete'
        ? `回應沒有完成（${answer.reason || 'incomplete'}）—— 輸出在上限用完時停了`
        : null,
  };
}

function ask(
  protocol: OpenAiProtocol,
  root: string,
  headers: Readonly<Record<string, string>>,
  req: AskRequest,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Asked> {
  return protocol === 'responses'
    ? askResponses(root, headers, req, timeoutMs, signal)
    : askChat(root, headers, req, timeoutMs, signal);
}

export const PROTOCOL_NAME: Readonly<Record<OpenAiProtocol, string>> = {
  responses: 'Responses API',
  chat: 'Chat Completions',
};

// ── provider ─────────────────────────────────────────────────

export function createOpenAiChat(
  baseUrl: string,
  model: string,
  apiKeyEnv: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): ChatProvider {
  const root = rootOf(baseUrl);
  const key = checkKey(root, model);
  const headers = (): Readonly<Record<string, string>> => authHeader(apiKeyEnv, env);
  const secret = (): string | null => secretOf(apiKeyEnv, env);

  async function known(): Promise<JsonCheck | null> {
    return (await readJsonChecks(env)).get(key) ?? null;
  }

  function reportOf(check: JsonCheck | null): JsonModeReport {
    return check === null
      ? { mode: 'unchecked', checkedAt: null, detail: '', protocol: null }
      : {
          mode: check.mode,
          checkedAt: check.checkedAt,
          detail: check.detail,
          protocol: check.protocol,
        };
  }

  /**
   * 量一次。**會送出一到三次真的請求。**
   *
   * 第一個請求先走 Responses API；回 404 的端點就改走 Chat Completions 再問一次
   * （那一次 404 不計費）。之後 `json_schema` 被拒或沒照做，再往 `json_object` 量一級。
   *
   * 被拒、限流、連不上的時候**不記下任何結果** —— 那些情況量不出支援度，
   * 記成 `none` 會讓一次暫時的網路問題變成一個永久的「這個端點不支援」。
   */
  async function measure(signal?: AbortSignal): Promise<CallOutcome<JsonModeReport>> {
    const started = Date.now();
    const cost = (): { costUsd: null; elapsedMs: number } => ({
      costUsd: null,
      elapsedMs: Date.now() - started,
    });
    const fail = (code: ErrorCode, detail: string): CallOutcome<JsonModeReport> => ({
      kind: 'error',
      code,
      detail,
      cost: cost(),
    });
    /** 量不出來的那幾種：回 `null` 表示可以繼續判斷。 */
    const blocked = (a: Asked): CallOutcome<JsonModeReport> | null => {
      if (a.kind === 'thrown') {
        return fail(a.timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE', a.detail);
      }
      if (a.kind === 'failed') return fail('PROVIDER_UNEXPECTED', a.detail);
      if (a.kind === 'http' && (a.status === 401 || a.status === 403 || a.status === 429)) {
        return fail(codeForStatus(a.status), `HTTP ${a.status}`);
      }
      return null;
    };

    let protocol: OpenAiProtocol = 'responses';
    const probe: AskRequest = {
      model,
      ...PULL_AWAY,
      format: { kind: 'schema', schema: PROBE_SCHEMA },
    };
    let a = await ask(protocol, root, headers(), probe, CHAT_TIMEOUT_MS, signal);
    if (a.kind === 'http' && hasNoResponsesRoute(a.status)) {
      protocol = 'chat';
      a = await ask(protocol, root, headers(), probe, CHAT_TIMEOUT_MS, signal);
    }
    const stop = blocked(a);
    if (stop !== null) return stop;
    const via = `（${PROTOCOL_NAME[protocol]}）`;

    let mode: MeasuredJsonMode;
    let detail: string;
    if (a.kind === 'answer' && conformsTo(PROBE_SCHEMA, parseJson(a.content)).ok) {
      mode = 'schema';
      detail = `json_schema${via}`;
    } else {
      // 被拒（4xx）或「收了但沒照做」—— 兩者都往下一級量。
      const why =
        a.kind === 'http'
          ? `json_schema 被拒：HTTP ${a.status} ${snippet(a.text, secret())}`
          : `json_schema 收了但沒有套用（回了：${snippet(a.kind === 'answer' ? a.content : '', secret())}）`;
      const b = await ask(
        protocol,
        root,
        headers(),
        { model, ...ASK_JSON, format: { kind: 'object' } },
        CHAT_TIMEOUT_MS,
        signal,
      );
      const stopB = blocked(b);
      if (stopB !== null) return stopB;
      const parsed = b.kind === 'answer' ? parseJson(b.content) : undefined;
      const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
      if (b.kind === 'answer' && isObject) {
        mode = 'object';
        detail = `${why}${via}`;
      } else {
        mode = 'none';
        const second = b.kind === 'http' ? `被拒：HTTP ${b.status}` : '回的不是物件';
        detail = `${why}；json_object ${second}${via}`;
      }
    }

    const check: JsonCheck = { mode, checkedAt: Date.now(), detail, protocol };
    await writeJsonCheck(root, model, check, env);
    return { kind: 'ok', value: reportOf(check), cost: cost() };
  }

  return {
    name: `openai:${model}`,

    async jsonMode(): Promise<JsonModeReport> {
      return reportOf(await known());
    },

    checkJson: measure,

    async probe(signal?: AbortSignal): Promise<ProbeResult> {
      if (model.length === 0) return { kind: 'not-configured' };
      const found = await fetchModels(root, headers(), signal);
      if (found.kind === 'auth') {
        return { kind: 'unreachable', detail: `金鑰被拒（HTTP ${found.status}）` };
      }
      if (found.kind === 'http') {
        // 最常見的原因是位址少了 `/v1` —— 說出來，免得人去懷疑金鑰。
        return {
          kind: 'unreachable',
          detail: `${root}/models 回 HTTP ${found.status}（位址通常以 /v1 結尾）`,
        };
      }
      if (found.kind === 'unreachable') return { kind: 'unreachable', detail: root };
      const entry = found.models.find((m) => String(m.id ?? '') === model);
      // 跟 Ollama 那邊一樣：**設定了一個清單上沒有的模型 ＝ 沒設定。**
      if (entry === undefined) return { kind: 'not-configured' };

      const check = await known();
      const capabilities: ProviderCapabilities = {
        browse: false,
        // **不宣告我們沒量過的東西。** `tools`／`vision` 這個工具的任務都不需要。
        tools: false,
        // 還沒量的時候放行（第一次跑任務時會量）；量出 `none` 才擋。
        // 見 `domain/provider` 的 `JsonMode`。
        json_schema: check === null || check.mode !== 'none',
        vision: false,
        context_tokens: contextOf(entry),
      };
      // 線上模型沒有「參數量與量化格式」可以問 —— **不編一個版本號。**
      return { kind: 'ready', model, version: null, capabilities };
    },

    async json(input, signal): Promise<CallOutcome<unknown>> {
      const started = Date.now();
      const cost = (): { costUsd: null; elapsedMs: number } => ({
        costUsd: null,
        elapsedMs: Date.now() - started,
      });
      const fail = (code: ErrorCode, detail: string): CallOutcome<unknown> => ({
        kind: 'error',
        code,
        detail,
        cost: cost(),
      });

      // **沒量過就先量。** 這一次任務本來就要付錢，而量一次是一到兩個很小的請求 ——
      // 比「猜一個模式送出去，然後解析失敗」好。結果寫進 `provider-checks.json`，
      // 呼叫端（作業紀錄）用 `jsonMode()` 讀得到這次用的是哪一種。
      let check = await known();
      if (check === null) {
        const measured = await measure(signal);
        if (measured.kind === 'error') {
          return fail(measured.code, `量格式支援時：${measured.detail}`);
        }
        check = (await known()) as JsonCheck;
      }
      if (check.mode === 'none') return fail('PROVIDER_JSON_UNSUPPORTED', check.detail);

      const schemaText = JSON.stringify(input.schema);
      const req: AskRequest =
        check.mode === 'schema'
          ? {
              model,
              system: input.system,
              user: input.user,
              format: { kind: 'schema', schema: input.schema },
            }
          : {
              model,
              // 端點不保證形狀的時候，schema 只能靠提示詞告訴模型 ——
              // **而形狀由下面的 `conformsTo` 把關**，不是靠模型聽話。
              system: `${input.system}\n\n回應必須是一份符合下面這份 JSON Schema 的 JSON 物件，不要有任何其他文字：\n${schemaText}`,
              user: input.user,
              format: { kind: 'object' },
            };

      const res = await ask(check.protocol, root, headers(), req, CHAT_TIMEOUT_MS, signal);
      if (res.kind === 'thrown') {
        // 逾時與取消不是同一件事，連不上又是第三件（見 `chat-ollama.ts` 同一段）。
        return fail(res.timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE', res.detail);
      }
      if (res.kind === 'failed') return fail('PROVIDER_UNEXPECTED', res.detail);
      if (res.kind === 'http') {
        // `schema` 模式下被拒，最可能是端點改了而量測舊了 —— **說出來，不自己改模式重送**。
        // 量的時候有 `/responses`、現在卻沒有了，也是同一種「量測舊了」。
        const stale =
          (check.mode === 'schema' &&
            res.status === 400 &&
            /response_format|json_schema|format/i.test(res.text)) ||
          (check.protocol === 'responses' && hasNoResponsesRoute(res.status))
            ? `（${new Date(check.checkedAt).toISOString().slice(0, 10)} 量的是 ${PROTOCOL_NAME[check.protocol]} 支援 ${check.mode === 'schema' ? 'json_schema' : 'json_object'}；到設定頁重新檢查）`
            : '';
        if (stale.length > 0) {
          return fail('PROVIDER_JSON_UNSUPPORTED', `HTTP ${res.status}${stale}`);
        }
        return fail(codeForStatus(res.status), `HTTP ${res.status} ${snippet(res.text, secret())}`);
      }

      const value = parseJson(res.content);
      if (value === undefined) {
        return fail(
          'PROVIDER_OUTPUT_UNPARSEABLE',
          res.truncated ?? `${res.content.length} 個字元，不是 JSON`,
        );
      }

      // **兩種模式都驗。** `schema` 模式下驗不過，代表端點說它支援卻沒有做到。
      const verdict = conformsTo(input.schema, value);
      if (!verdict.ok) {
        return fail('PROVIDER_OUTPUT_SCHEMA_MISMATCH', `${verdict.path}：${verdict.reason}`);
      }
      return { kind: 'ok', value, cost: cost() };
    },
  };
}
