/**
 * OpenAI 的 Responses API（`POST {baseUrl}/responses`）：送一次、把回應讀成一個固定的形狀。
 * 對話（`chat-openai.ts`）與找來源（`agent-openai.ts`）都走這一支（v0.24.2，ADR-0034）。
 *
 * ## 為什麼是 Responses API，不是 Chat Completions
 *
 * 2026-09-19 使用者說「調用時用 responses format，不要用 chat format」。他那一條端點是
 * Codex 訂閱的代理，原生說的就是 Responses API；Chat Completions 在那上面是一層翻譯。
 * 而**網頁搜尋只有 Responses API 有**（`tools: [{type: 'web_search'}]`）—— 找來源那一支
 * 沒有別條路。同一條端點兩種協定，等於同一件事兩份量測；所以對話也改走這一條，
 * **沒有這條路的端點（`/responses` 回 404）才退回 Chat Completions**，而且畫面上說得出走的是哪一種。
 *
 * ## 一定要串流
 *
 * 使用者那一條代理**不串流的時候回 `output: []`**（`status: completed`、`usage` 都在，
 * 就是沒有內容；帶不帶工具都一樣，2026-09-19 實測）。內容只在串流的
 * `response.output_item.done` 事件裡。所以一律 `stream: true`，讀完整個事件流再組回來；
 * 對方若不理會 `stream` 而回一整份 JSON，也照樣讀得懂（`parseResponsesBody` 兩種都認）。
 *
 * ## 這一層不知道任務是什麼
 *
 * 它只送一個 body、回一個 `ResponsesAnswer`。工具清單、輸出格式、系統提示由呼叫端決定；
 * 429 的退避跟 Chat Completions 那一條同一套（`domain/provider/rate-limit.ts`）。
 */
import { parseRetryAfter, providerRetryDelayMs } from '../../domain/provider/index.js';
import { withTimeout } from './http.js';
import { sleepUnlessAborted } from './openai-common.js';

/** 一次 Responses API 呼叫讀出來的東西（串流或不串流都收斂成這個）。 */
export interface ResponsesAnswer {
  /** `unfinished` ＝ 串流沒有收尾就斷了（沒有 `response.completed` 之類的事件） */
  readonly status: 'completed' | 'incomplete' | 'failed' | 'unfinished';
  /** 沒完成或失敗時，對方自己說的理由（`incomplete_details.reason`、`error.message`） */
  readonly reason: string;
  /** 模型最後交出來的文字 */
  readonly text: string;
  /** 完成的搜尋（`web_search_call`）次數 */
  readonly searches: number;
  /** 搜尋用的查詢字串 */
  readonly queries: readonly string[];
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 一群輸出項目 → 文字、搜尋次數、查詢字串。串流與不串流共用。 */
function fromItems(items: readonly unknown[]): {
  readonly searches: number;
  readonly queries: readonly string[];
  readonly message: string | null;
} {
  let searches = 0;
  const queries: string[] = [];
  let message: string | null = null;
  for (const raw of items) {
    const item = obj(raw);
    if (item === null) continue;
    if (item['type'] === 'web_search_call' && item['status'] === 'completed') {
      searches++;
      const action = obj(item['action']);
      const list = Array.isArray(action?.['queries']) ? (action['queries'] as unknown[]) : [];
      for (const q of list.length > 0 ? list : [action?.['query']]) {
        if (typeof q === 'string' && q.length > 0 && !queries.includes(q)) queries.push(q);
      }
    } else if (item['type'] === 'message') {
      const parts = Array.isArray(item['content']) ? (item['content'] as unknown[]) : [];
      const texts = parts
        .map(obj)
        .filter((p) => p?.['type'] === 'output_text' && typeof p['text'] === 'string')
        .map((p) => (p as Record<string, unknown>)['text'] as string);
      if (texts.length > 0) message = texts.join('');
    }
  }
  return { searches, queries, message };
}

/**
 * 讀一次回應。**串流（`text/event-stream`）與一整份 JSON 都認**：
 * 前者是我們要的（檔頭「一定要串流」），後者是不理會 `stream` 的端點會回的。
 *
 * 串流時項目以 `response.output_item.done` 為準 —— 使用者那一條代理在
 * `response.completed` 裡的 `output` 是空的。
 */
export function parseResponsesBody(raw: string): ResponsesAnswer {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    let body: Record<string, unknown> | null;
    try {
      body = obj(JSON.parse(trimmed));
    } catch {
      body = null;
    }
    if (body === null) {
      return { status: 'unfinished', reason: '', text: '', searches: 0, queries: [] };
    }
    const found = fromItems(Array.isArray(body['output']) ? (body['output'] as unknown[]) : []);
    const s = body['status'];
    return {
      status: s === 'completed' ? 'completed' : s === 'incomplete' ? 'incomplete' : 'failed',
      reason: String(
        obj(body['incomplete_details'])?.['reason'] ?? obj(body['error'])?.['message'] ?? '',
      ),
      text: found.message ?? '',
      searches: found.searches,
      queries: found.queries,
    };
  }

  let status: ResponsesAnswer['status'] = 'unfinished';
  let reason = '';
  let deltas = '';
  const items: unknown[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data.length === 0 || data === '[DONE]') continue;
    let event: Record<string, unknown> | null;
    try {
      event = obj(JSON.parse(data));
    } catch {
      // 一個事件壞掉不代表整份壞掉 —— 我們在乎的是項目與收尾那幾個。
      continue;
    }
    if (event === null) continue;
    const type = event['type'];
    if (type === 'response.output_text.delta' && typeof event['delta'] === 'string') {
      deltas += event['delta'];
    } else if (type === 'response.output_item.done') {
      items.push(event['item']);
    } else if (type === 'response.completed') {
      status = 'completed';
    } else if (type === 'response.incomplete') {
      status = 'incomplete';
      reason = String(obj(obj(event['response'])?.['incomplete_details'])?.['reason'] ?? '');
    } else if (type === 'response.failed') {
      status = 'failed';
      reason = String(obj(obj(event['response'])?.['error'])?.['message'] ?? '');
    } else if (type === 'error') {
      status = 'failed';
      reason = String(event['message'] ?? obj(event['error'])?.['message'] ?? '');
    }
  }
  const found = fromItems(items);
  return {
    status,
    reason,
    text: found.message ?? deltas,
    searches: found.searches,
    queries: found.queries,
  };
}

export type ResponsesSent =
  | { readonly kind: 'body'; readonly raw: string }
  | { readonly kind: 'http'; readonly status: number; readonly text: string }
  | { readonly kind: 'thrown'; readonly detail: string; readonly timedOut: boolean };

/** `/responses` 回這幾個狀態碼 ＝ 這個端點沒有這條路（`chat-openai.ts` 退回 Chat Completions）。 */
export function hasNoResponsesRoute(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/**
 * 送一次 `POST /responses`（串流）。429 照 Chat Completions 那一條同一套退避（最多兩次）；
 * **逾時是整次呼叫的預算，含退避的等待。**
 */
export async function sendResponses(
  root: string,
  headers: Readonly<Record<string, string>>,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ResponsesSent> {
  const t = withTimeout(timeoutMs, signal);
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${root}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
        body: JSON.stringify({ ...body, stream: true }),
        signal: t.signal,
      });
      const text = await res.text();
      if (res.status === 429) {
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
      return { kind: 'body', raw: text };
    }
  } catch (e) {
    return { kind: 'thrown', detail: String((e as Error).message), timedOut: t.timedOut };
  } finally {
    t.done();
  }
}
