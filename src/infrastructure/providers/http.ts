/**
 * 兩種 `chat` 傳輸共用的三樣東西：逾時、授權標頭、一次呼叫等多久。
 *
 * v0.18.0 之前它們是 `chat-ollama.ts` 的私有函式。多了第二種傳輸之後
 * 抄一份會漂 —— 而漂掉的那一種形狀是「兩支對同一個環境變數的判斷不一樣」，
 * 那在設定頁上看起來是「偵測到金鑰」、送出去卻沒帶。
 */

/**
 * 一次呼叫等多久。**評測記分用的也是這一個** —— 一個模型平均要 200 秒，
 * 它在這個工具裡就是不能用，不管它答得多好。
 * 匯出而不是各抄一份，理由與 `num_ctx` 那一條相同：抄的那份會漂。
 */
export const CHAT_TIMEOUT_MS = 180_000;

/** 探測（列模型、看在不在）等多久。連不上與逾時要分得開，所以逾時自己帶一個訊號。 */
export const PROBE_TIMEOUT_MS = 5000;

export interface Timed {
  readonly signal: AbortSignal;
  /** **我們的計時器燒掉了**，而不是外面取消。兩者的碼不一樣 */
  timedOut: boolean;
  done(): void;
}

export function withTimeout(ms: number, outer?: AbortSignal): Timed {
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

/**
 * 這個端點要不要帶金鑰，以及金鑰從哪來。
 *
 * ## 金鑰只從環境變數讀，不存進任何一個檔
 *
 * 這個工具到 v0.7.0 為止一個機密都不存 —— 兩個 provider 都是本機的。
 * 接雲端端點會改變那件事，而**改變它的代價不只是「多一個欄位」**：
 * 設定檔會被備份、會被同步、會在求助時被整份貼出來。
 *
 * 所以設定裡存的是**環境變數的名字**，不是值。
 * 畫面上顯示「偵測到／沒偵測到」，而值只在送出請求的那一刻讀一次。
 */
export function authHeader(
  apiKeyEnv: string | null,
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  if (apiKeyEnv === null || apiKeyEnv.length === 0) return {};
  const value = env[apiKeyEnv];
  if (typeof value !== 'string' || value.trim().length === 0) return {};
  return { authorization: `Bearer ${value.trim()}` };
}
