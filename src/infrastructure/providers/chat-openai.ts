/**
 * OpenAI 相容端點當 `chat`（Stage 16）。
 *
 * 線上的（各家 API）與別家本機伺服器（vLLM、LM Studio、llama.cpp 的 server）
 * 都說這一種協定：`GET {baseUrl}/models`、`POST {baseUrl}/chat/completions`。
 * `baseUrl` 照各家文件的寫法**含 `/v1`**。
 *
 * ## 「符合 schema」這件事，這裡是量的，不是宣告的
 *
 * 各家對 `response_format` 的支援不一樣，而且**會變**：
 * 這個專案自己寫過一句「OpenAI 相容那條路只到 `json_object`」，
 * 2026-09-11 重量一次就不成立了（Ollama 0.33.2 的 `/v1` 支援 `json_schema`）。
 * 所以每一個「端點＋模型」各量一次（`checkJson`），結果帶著時間存在
 * `provider-checks.json`，**第一次真的跑任務之前沒量過就先量**。
 *
 * 量出來的三種結果決定怎麼送：
 *
 * | 結果 | 怎麼送 | 誰保證形狀 |
 * |---|---|---|
 * | `schema` | `response_format: { type: 'json_schema', … }` | 端點 |
 * | `object` | `response_format: { type: 'json_object' }`，schema 寫進系統提示 | **這一側事後驗證** |
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
 * - **沒有重試**：429 立刻停（`PROVIDER_RATE_LIMITED`），跟擷取管線同一條規矩；
 *   形狀不對也不重問一次 —— 那會讓結果來自一組跟畫面上顯示的不同的條件
 * - **沒有成本上限**：這個協定不回報金額（`usage` 只有 token 數），
 *   所以 `costUsd` 是 `null` —— 不知道，不是 0
 */
import { conformsTo, type ProviderCapabilities } from '../../domain/provider/index.js';
import type { ErrorCode } from '../../domain/errors/codes.js';
import { CHAT_TIMEOUT_MS, PROBE_TIMEOUT_MS, authHeader, withTimeout } from './http.js';
import {
  checkKey,
  readJsonChecks,
  writeJsonCheck,
  type JsonCheck,
  type MeasuredJsonMode,
} from './json-checks.js';
import type { CallOutcome, ChatProvider, JsonModeReport, ProbeResult } from './types.js';

interface ModelEntry {
  readonly id?: unknown;
  /** OpenRouter 這類聚合服務會帶 */
  readonly context_length?: unknown;
  /** vLLM 會帶 */
  readonly max_model_len?: unknown;
}

function rootOf(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

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

type ModelsResult =
  | { readonly kind: 'ok'; readonly models: readonly ModelEntry[] }
  | { readonly kind: 'auth'; readonly status: number }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'unreachable'; readonly detail: string };

async function fetchModels(
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
function contextOf(entry: ModelEntry): number {
  for (const v of [entry.context_length, entry.max_model_len]) {
    if (typeof v === 'number' && v > 0) return v;
  }
  return 0;
}

// ── 格式量測 ──────────────────────────────────────────────────

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

const PULL_AWAY = [
  { role: 'system', content: '回答使用者的問題。' },
  { role: 'user', content: '用一句話介紹你自己。不要用 JSON，用一般的句子。' },
];
const ASK_JSON = [
  { role: 'system', content: '只回 JSON。' },
  { role: 'user', content: '回一個 JSON 物件，裡面有一個欄位 ok，值是 true。' },
];

interface Completion {
  readonly status: number;
  readonly content: string;
  readonly finish: string | null;
  readonly errorText: string;
}

async function complete(
  root: string,
  headers: Readonly<Record<string, string>>,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Completion | { readonly thrown: string; readonly timedOut: boolean }> {
  const t = withTimeout(timeoutMs, signal);
  try {
    const res = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ stream: false, temperature: 0, ...body }),
      signal: t.signal,
    });
    const text = await res.text();
    if (!res.ok) return { status: res.status, content: '', finish: null, errorText: text };
    const json = JSON.parse(text) as {
      choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
    };
    const choice = json.choices?.[0];
    return {
      status: res.status,
      content: typeof choice?.message?.content === 'string' ? choice.message.content : '',
      finish: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
      errorText: '',
    };
  } catch (e) {
    return { thrown: String((e as Error).message), timedOut: t.timedOut };
  } finally {
    t.done();
  }
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 錯誤訊息只留開頭一小段，**而且把金鑰遮掉**。
 *
 * 對方的錯誤頁可能很長，而且**可能夾著我們送出去的東西** —— 有的伺服器
 * 會把請求標頭回顯在錯誤內文裡。這一段會進 `detail`，而 `detail` 會進日誌、
 * 進 `provider-checks.json`、會在求助時被整份貼出來。金鑰只存名字的那條規矩
 * （Stage 10.5）在這裡如果漏一格，就等於沒有那條規矩。
 *
 * 先遮再截：反過來的話，一把剛好跨在第 160 字上的金鑰會留下前半段。
 */
function snippet(text: string, secret: string | null): string {
  const scrubbed = secret !== null && secret.length > 0 ? text.split(secret).join('***') : text;
  return scrubbed.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * 狀態碼 → 我們的碼。**401／403 與 429 不能歸成「連不上」** ——
 * 前者的下一步是檢查金鑰，後者是等一下，而「連不上」叫人去看它有沒有開。
 */
function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'PROVIDER_AUTH_REJECTED';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  return 'PROVIDER_UNREACHABLE';
}

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
  /** 這一刻的金鑰值，**只拿來遮蔽**，不存、不回傳。 */
  const secret = (): string | null => {
    const v = apiKeyEnv === null ? undefined : env[apiKeyEnv];
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  };

  async function known(): Promise<JsonCheck | null> {
    return (await readJsonChecks(env)).get(key) ?? null;
  }

  /**
   * 量一次。**會送出一到兩次真的請求。**
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

    const a = await complete(
      root,
      headers(),
      {
        model,
        messages: PULL_AWAY,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'cyclosa_probe', strict: true, schema: PROBE_SCHEMA },
        },
      },
      CHAT_TIMEOUT_MS,
      signal,
    );
    if ('thrown' in a)
      return fail(a.timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE', a.thrown);
    if (a.status === 401 || a.status === 403 || a.status === 429) {
      return fail(codeForStatus(a.status), `HTTP ${a.status}`);
    }

    let mode: MeasuredJsonMode;
    let detail: string;
    if (a.status >= 200 && a.status < 300 && conformsTo(PROBE_SCHEMA, parseJson(a.content)).ok) {
      mode = 'schema';
      detail = 'json_schema';
    } else {
      // 被拒（4xx）或「收了但沒照做」—— 兩者都往下一級量。
      const why =
        a.status >= 400
          ? `json_schema 被拒：HTTP ${a.status} ${snippet(a.errorText, secret())}`
          : `json_schema 收了但沒有套用（回了：${snippet(a.content, secret())}）`;
      const b = await complete(
        root,
        headers(),
        { model, messages: ASK_JSON, response_format: { type: 'json_object' } },
        CHAT_TIMEOUT_MS,
        signal,
      );
      if ('thrown' in b) {
        return fail(b.timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE', b.thrown);
      }
      if (b.status === 401 || b.status === 403 || b.status === 429) {
        return fail(codeForStatus(b.status), `HTTP ${b.status}`);
      }
      const parsed = parseJson(b.content);
      const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
      if (b.status >= 200 && b.status < 300 && isObject) {
        mode = 'object';
        detail = why;
      } else {
        mode = 'none';
        detail = `${why}；json_object ${b.status >= 400 ? `被拒：HTTP ${b.status}` : '回的不是物件'}`;
      }
    }

    const check: JsonCheck = { mode, checkedAt: Date.now(), detail };
    await writeJsonCheck(root, model, check, env);
    return { kind: 'ok', value: check, cost: cost() };
  }

  return {
    name: `openai:${model}`,

    async jsonMode(): Promise<JsonModeReport> {
      const k = await known();
      return k === null
        ? { mode: 'unchecked', checkedAt: null, detail: '' }
        : { mode: k.mode, checkedAt: k.checkedAt, detail: k.detail };
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
        if (measured.kind === 'error')
          return fail(measured.code, `量格式支援時：${measured.detail}`);
        check = measured.value as JsonCheck;
      }
      if (check.mode === 'none') return fail('PROVIDER_JSON_UNSUPPORTED', check.detail);

      const schemaText = JSON.stringify(input.schema);
      const request =
        check.mode === 'schema'
          ? {
              model,
              messages: [
                { role: 'system', content: input.system },
                { role: 'user', content: input.user },
              ],
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'cyclosa', strict: true, schema: input.schema },
              },
            }
          : {
              model,
              messages: [
                {
                  role: 'system',
                  // 端點不保證形狀的時候，schema 只能靠提示詞告訴模型 ——
                  // **而形狀由下面的 `conformsTo` 把關**，不是靠模型聽話。
                  content: `${input.system}\n\n回應必須是一份符合下面這份 JSON Schema 的 JSON 物件，不要有任何其他文字：\n${schemaText}`,
                },
                { role: 'user', content: input.user },
              ],
              response_format: { type: 'json_object' },
            };

      const res = await complete(root, headers(), request, CHAT_TIMEOUT_MS, signal);
      if ('thrown' in res) {
        // 逾時與取消不是同一件事，連不上又是第三件（見 `chat-ollama.ts` 同一段）。
        return fail(res.timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE', res.thrown);
      }
      if (res.status < 200 || res.status >= 300) {
        // `schema` 模式下被拒，最可能是端點改了而量測舊了 —— **說出來，不自己改模式重送**。
        const stale =
          check.mode === 'schema' &&
          res.status === 400 &&
          /response_format|json_schema/i.test(res.errorText)
            ? `（${new Date(check.checkedAt).toISOString().slice(0, 10)} 量的是支援 json_schema；到設定頁重新檢查）`
            : '';
        if (stale.length > 0) return fail('PROVIDER_JSON_UNSUPPORTED', `HTTP 400${stale}`);
        return fail(
          codeForStatus(res.status),
          `HTTP ${res.status} ${snippet(res.errorText, secret())}`,
        );
      }

      const value = parseJson(res.content);
      if (value === undefined) {
        // 被截斷的空回應跟「模型壞了」下一步不同 —— 把對方自己說的理由帶出去。
        const why =
          res.finish === 'length'
            ? '回應被截斷（finish_reason=length）—— 輸出在長度上限用完時停了'
            : `${res.content.length} 個字元，不是 JSON`;
        return fail('PROVIDER_OUTPUT_UNPARSEABLE', why);
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
