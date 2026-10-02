/**
 * OpenAI 相容 API 當 `agent`（找候選來源）：Responses API ＋ 對方的網頁搜尋工具（v0.24.2，ADR-0034）。
 *
 * ## 為什麼有這一支
 *
 * v0.24.1 之前「找候選來源」只能走 Claude Code —— 那是唯一一條會上網的路（`--tools WebSearch`）；
 * OpenAI 相容 API 這條路我們只送一般的對話請求，模型碰不到網路，只能憑記憶給網址。
 * 2026-09-19 使用者問「它不能上網嗎？我原本就是要它做這件事（模型新、一次燒得了的額度大）」。
 * 量過使用者那一條（一個 Codex 訂閱的代理）：`POST /responses` 帶 `tools: [{type: 'web_search'}]`
 * 真的會搜尋（回應裡有 `web_search_call`，查詢字串看得到），而且同時照 `text.format` 的
 * json_schema 交出候選清單。用找來源真的會送的提示詞打一次：搜了 2 次、6 條候選全是官方頁。
 *
 * ## 規則跟 Claude Code 那一支一樣：只給搜尋
 *
 * - `tools` 只有 `web_search` 一個。沒有程式執行、沒有檔案、沒有函式 —— 它能做的只有搜尋。
 * - **搜尋在對方的伺服器上跑**，模型可能在那邊讀到頁面內容。Claude 的 WebSearch 也是在
 *   Anthropic 那邊跑、模型也讀得到結果的內容。兩者都**不從這台機器抓任何東西**，
 *   而進專題的東西只走擷取管線（ADR-0006 第 5 條不變）。
 * - 一次 HTTP 呼叫寫不了檔，所以沙箱對它永遠是空的 —— 呼叫端照樣掃，不為它開例外。
 * - `tool_choice: 'required'`：**一定要搜尋。** 一次沒搜尋就交回來的網址只可能是模型憑記憶給的，
 *   而那正是這一支存在要取代的東西 —— 所以真的發生了（端點沒照做）就不採用那一次。
 *
 * ## 「會搜尋」是量的，不是宣告的
 *
 * 跟 JSON 格式同一個做法（ADR-0030）：每個端點＋模型量一次（一個帶搜尋的小請求），
 * 帶著時間記在 `provider-checks.json`。**真的搜尋了、交回的形狀也對**才算；
 * 還沒量的時候放行，開始擴展之前先量（`expand-service`），設定頁按「儲存並測試」也會量。
 *
 * ## 刻意沒有的東西
 *
 * - **金額上限**：這個協定不回報金額，`costUsd` 是 `null`（不知道，不是 0）。
 *   上限只剩時間（`timeoutMs`）與網址數（schema 的 `maxItems`）。
 * - **自己搜尋、自己組結果**：搜尋用的是對方的工具。自己接一個搜尋服務要另一把金鑰、另一份條款，
 *   而使用者手上這一條已經做得到（ADR-0034「考慮過、沒有選的」）。
 * - **Chat Completions**：那條路沒有搜尋工具，所以 `/responses` 回 404 的端點在這裡就是「不會上網」。
 */
import { conformsTo, strictify, type ProviderCapabilities } from '../../domain/provider/index.js';
import type { ErrorCode } from '../../domain/errors/codes.js';
import { authHeader } from './http.js';
import { checkKey, readBrowseChecks, writeBrowseCheck, type BrowseCheck } from './json-checks.js';
import {
  codeForStatus,
  contextOf,
  fetchModels,
  parseJson,
  rootOf,
  secretOf,
  snippet,
} from './openai-common.js';
import {
  hasNoResponsesRoute,
  parseResponsesBody,
  sendResponses,
  type ResponsesSent,
} from './responses-api.js';
import type { AgentProvider, BrowseReport, CallOutcome, ProbeResult } from './types.js';

/** 給模型的工具。**只有這一個**（檔頭「只給搜尋」）。 */
const WEB_SEARCH_ONLY = [{ type: 'web_search' }] as const;

/** 量測一次等多久。一次搜尋實測 5–10 秒；多給是因為對方排隊時也算在裡面。 */
export const BROWSE_CHECK_TIMEOUT_MS = 120_000;

/**
 * 量測用的題目：**不搜尋答不準、答案一看就知道對不對**的東西。
 * 要的只是一個網址，所以輸出很小。
 */
export const BROWSE_PROBE_SCHEMA = {
  type: 'object',
  properties: { url: { type: 'string', maxLength: 300 } },
  required: ['url'],
} as const;
const BROWSE_PROBE_SYSTEM = '用網頁搜尋找答案。只回 JSON。';
const BROWSE_PROBE_USER = '用網頁搜尋找出 Node.js 官方網站的下載頁網址，放在 url 欄位。';

/**
 * 搜尋是**一定要**還是**有就用**。
 *
 * | | 誰用 | 沒搜尋的時候 |
 * |---|---|---|
 * | `required` | 找候選來源 | **不採用那一次** —— 沒搜尋就交回的網址只可能來自記憶 |
 * | `optional` | 規劃對話（ADR-0033 D5）| 照常用 —— 談方向本來就不一定要查 |
 *
 * `optional` 是 v0.25.0 加的。談方向的素材是這個專題裡已經有的東西，
 * **查得到更好、查不到照樣談得出來**；強迫它每一輪都搜尋，等於每一輪都多付一次錢
 * 去查一件使用者可能只是在改字的事。
 */
export type SearchMode = 'required' | 'optional' | 'none';

export interface OpenAiAgentOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKeyEnv: string | null;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly systemPrompt: string;
  /** 預設 `required`（找候選來源那一支的行為，v0.24.2 起就是這樣）。 */
  readonly search?: SearchMode;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * 一次請求：系統提示、題目、要的形狀。量測與正式呼叫都是這個形狀。
 *
 * `tools` 是空陣列的時候連 `tool_choice` 都不送 —— 那是「量過這個端點收不了搜尋工具」
 * 的情況（見 `run`）：仍然要談得下去，只是不會上網查。
 */
function searchBody(
  model: string,
  system: string,
  user: string,
  name: string,
  schema: Readonly<Record<string, unknown>>,
  mode: SearchMode = 'required',
  tools: readonly Record<string, unknown>[] = WEB_SEARCH_ONLY,
): Record<string, unknown> {
  return {
    model,
    instructions: system,
    input: user,
    ...(tools.length === 0
      ? {}
      : { tools, tool_choice: mode === 'required' ? 'required' : 'auto' }),
    text: {
      format: {
        type: 'json_schema',
        name,
        strict: true,
        // 嚴格模式的形狀要求在邊界上補，不改那份 schema（`strictify` 的檔頭）。
        schema: strictify(schema),
      },
    },
  };
}

export function createOpenAiAgent(options: OpenAiAgentOptions): AgentProvider {
  const env = options.env ?? process.env;
  const mode: SearchMode = options.search ?? 'required';
  const model = options.model.trim();
  const root = rootOf(options.baseUrl);
  const key = checkKey(root, model);
  const headers = (): Readonly<Record<string, string>> => authHeader(options.apiKeyEnv, env);
  const secret = (): string | null => secretOf(options.apiKeyEnv, env);

  async function known(): Promise<BrowseCheck | null> {
    return (await readBrowseChecks(env)).get(key) ?? null;
  }

  function reportOf(check: BrowseCheck | null): BrowseReport {
    return check === null
      ? { state: 'unchecked', checkedAt: null, detail: '' }
      : { state: check.ok ? 'yes' : 'no', checkedAt: check.checkedAt, detail: check.detail };
  }

  /**
   * 送出去之後、看內容之前，兩支共用的那幾種結果。**回 `null` 表示可以繼續看內容。**
   * 連不上、逾時、被拒、限流：那不是這個端點「不會搜尋」，是這一次量不出來。
   */
  function transportFailure(sent: ResponsesSent): { code: ErrorCode; detail: string } | null {
    if (sent.kind === 'thrown') {
      return {
        code: sent.timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE',
        detail: sent.detail,
      };
    }
    if (
      sent.kind === 'http' &&
      (sent.status === 401 || sent.status === 403 || sent.status === 429)
    ) {
      return { code: codeForStatus(sent.status), detail: `HTTP ${sent.status}` };
    }
    return null;
  }

  /**
   * 量一次。**會送出一個真的、帶搜尋的請求。**
   *
   * 被拒、限流、連不上、對方回報失敗的時候**不記下任何結果** —— 那些情況量不出它會不會搜尋，
   * 記成「不行」會讓一次暫時的問題變成一個永久的結論（跟 JSON 格式那一支同一條）。
   */
  async function measure(signal?: AbortSignal): Promise<CallOutcome<BrowseReport>> {
    const started = Date.now();
    const cost = (): { costUsd: null; elapsedMs: number } => ({
      costUsd: null,
      elapsedMs: Date.now() - started,
    });
    const fail = (code: ErrorCode, detail: string): CallOutcome<BrowseReport> => ({
      kind: 'error',
      code,
      detail,
      cost: cost(),
    });
    const record = async (ok: boolean, detail: string): Promise<CallOutcome<BrowseReport>> => {
      const check: BrowseCheck = { ok, checkedAt: Date.now(), detail };
      await writeBrowseCheck(root, model, check, env);
      return { kind: 'ok', value: reportOf(check), cost: cost() };
    };

    const sent = await sendResponses(
      root,
      headers(),
      searchBody(
        model,
        BROWSE_PROBE_SYSTEM,
        BROWSE_PROBE_USER,
        'cyclosa_browse_probe',
        BROWSE_PROBE_SCHEMA,
      ),
      BROWSE_CHECK_TIMEOUT_MS,
      signal,
    );
    const blocked = transportFailure(sent);
    if (blocked !== null) return fail(blocked.code, blocked.detail);
    if (sent.kind === 'http') {
      // 沒有這條路、或不收搜尋工具 —— **兩者都是這個端點的事實**，記下來。
      if (hasNoResponsesRoute(sent.status)) {
        return record(false, `這個端點沒有 /responses（Responses API），HTTP ${sent.status}`);
      }
      if (sent.status >= 400 && sent.status < 500) {
        return record(
          false,
          `帶搜尋工具的請求被拒：HTTP ${sent.status} ${snippet(sent.text, secret())}`,
        );
      }
      return fail('PROVIDER_UNREACHABLE', `HTTP ${sent.status} ${snippet(sent.text, secret())}`);
    }
    if (sent.kind !== 'body') return fail('PROVIDER_UNEXPECTED', '');

    const answer = parseResponsesBody(sent.raw);
    if (answer.status === 'failed') {
      return fail('PROVIDER_UNEXPECTED', `對方回報失敗：${snippet(answer.reason, secret())}`);
    }
    if (answer.status !== 'completed') {
      return fail(
        'PROVIDER_OUTPUT_UNPARSEABLE',
        answer.status === 'incomplete' ? `回應沒有完成（${answer.reason}）` : '串流沒有收尾就斷了',
      );
    }
    if (answer.searches === 0) {
      return record(false, '收了搜尋工具，但沒有真的搜尋（要求它一定要搜也一樣）');
    }
    const value = parseJson(answer.text);
    const verdict = value === undefined ? null : conformsTo(BROWSE_PROBE_SCHEMA, value);
    if (verdict === null || !verdict.ok) {
      return record(false, `搜尋了 ${answer.searches} 次，但交回的不是指定的格式`);
    }
    return record(true, `搜尋了 ${answer.searches} 次，交回的形狀對`);
  }

  return {
    name: `openai:${model}`,

    async browseReport(): Promise<BrowseReport> {
      return reportOf(await known());
    },

    checkBrowse: measure,

    async probe(signal?: AbortSignal): Promise<ProbeResult> {
      if (model.length === 0) return { kind: 'not-configured' };
      const found = await fetchModels(root, headers(), signal);
      if (found.kind === 'auth') {
        return { kind: 'unreachable', detail: `金鑰被拒（HTTP ${found.status}）` };
      }
      if (found.kind === 'http') {
        return {
          kind: 'unreachable',
          detail: `${root}/models 回 HTTP ${found.status}（位址通常以 /v1 結尾）`,
        };
      }
      if (found.kind === 'unreachable') return { kind: 'unreachable', detail: root };
      const entry = found.models.find((m) => String(m.id ?? '') === model);
      // 跟對話那一支一樣：**設定了一個清單上沒有的模型 ＝ 沒設定。**
      if (entry === undefined) return { kind: 'not-configured' };

      const check = await known();
      const capabilities: ProviderCapabilities = {
        // 還沒量的時候放行（開始擴展之前會先量）；量出不行才擋 —— 跟 JSON 格式同一套（ADR-0030）。
        browse: mode !== 'none' && (check === null || check.ok),
        tools: false,
        // Responses API 的 `text.format`；而每一次交回來的東西都再由 `conformsTo` 驗。
        json_schema: true,
        vision: false,
        context_tokens: contextOf(entry),
      };
      return { kind: 'ready', model, version: null, capabilities };
    },

    async run(input, signal): Promise<CallOutcome<string>> {
      const started = Date.now();
      const cost = (): { costUsd: null; elapsedMs: number } => ({
        costUsd: null,
        elapsedMs: Date.now() - started,
      });
      const fail = (code: ErrorCode, detail: string): CallOutcome<string> => ({
        kind: 'error',
        code,
        detail,
        cost: cost(),
      });

      const check = await known();
      /**
       * 量過不會搜尋的端點：**找來源在這裡停手，規劃對話照談。**
       *
       * 兩者的差別是那一次交出來的東西能不能用：沒搜尋的網址只可能來自記憶（不採用），
       * 而沒查資料的方向仍然是一份可以改、可以刪的方向（照用，畫面說它不會上網查）。
       * 這種端點連搜尋工具都可能收不了（量測時 400 過），所以那一次**不送 `tools`**。
       */
      const blind = check !== null && !check.ok;
      if (blind && mode === 'required') {
        return fail('PROVIDER_CAPABILITY_MISSING', `量過：${check.detail}`);
      }

      const sent = await sendResponses(
        root,
        headers(),
        searchBody(
          model,
          options.systemPrompt,
          input.prompt,
          'cyclosa_sources',
          options.schema,
          mode,
          blind || mode === 'none' ? [] : WEB_SEARCH_ONLY,
        ),
        input.timeoutMs,
        signal,
      );
      const blocked = transportFailure(sent);
      if (blocked !== null) return fail(blocked.code, blocked.detail);
      if (sent.kind === 'http') {
        if (hasNoResponsesRoute(sent.status)) {
          return fail(
            'PROVIDER_CAPABILITY_MISSING',
            `${root}/responses 回 HTTP ${sent.status} —— 這個端點沒有 Responses API，搜尋不了`,
          );
        }
        return fail(
          codeForStatus(sent.status),
          `HTTP ${sent.status} ${snippet(sent.text, secret())}`,
        );
      }
      if (sent.kind !== 'body') return fail('PROVIDER_UNEXPECTED', '');

      const answer = parseResponsesBody(sent.raw);
      if (answer.status === 'failed') {
        return fail('PROVIDER_UNEXPECTED', `對方回報失敗：${snippet(answer.reason, secret())}`);
      }
      if (answer.status !== 'completed') {
        return fail(
          'PROVIDER_OUTPUT_UNPARSEABLE',
          answer.status === 'incomplete'
            ? `回應沒有完成（${answer.reason}）`
            : '串流沒有收尾就斷了',
        );
      }
      // 見檔頭：沒搜尋就交回的網址只可能來自記憶。**規劃對話不適用**（`SearchMode`）。
      if (mode === 'required' && answer.searches === 0) {
        return fail('PROVIDER_CAPABILITY_MISSING', '這一次沒有搜尋就交回了網址 —— 不採用');
      }
      const value = parseJson(answer.text);
      if (value === undefined) {
        return fail('PROVIDER_OUTPUT_UNPARSEABLE', `${answer.text.length} 個字元，不是 JSON`);
      }
      const verdict = conformsTo(options.schema, value);
      if (!verdict.ok) {
        return fail('PROVIDER_OUTPUT_SCHEMA_MISMATCH', `${verdict.path}：${verdict.reason}`);
      }
      return { kind: 'ok', value: JSON.stringify(value), cost: cost() };
    },
  };
}
