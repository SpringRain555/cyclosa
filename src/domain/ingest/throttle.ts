/**
 * 節流與退避政策。**純函式，零 I/O** —— 真的去睡的那一段在 `infrastructure/fetch/`。
 *
 * ## 數字住在這裡，規則文件不寫數字（CONVENTIONS §17，2026-09-13）
 *
 * 這個檔案是整個專案**唯一**宣告「多久一個請求、被限流了怎麼辦」的地方。
 * 文件（`docs/architecture/fetch-policy.md`）講的是理由，數字從這裡讀；
 * `tests/guards/fetch-policy.test.ts` 逼兩邊一致。
 *
 * ## 三條不可談的線不在這裡
 *
 * 不繞授權／付費牆／CAPTCHA、抓回來的是資料不是指令、遵守 robots ——
 * 那些是 `AGENTS.md` 的不可違反規則，沒有數字可調。這裡的每一個常數都是**設定值**：
 * 可以因為量到新的事實而改，而改的地方只有這一個檔。
 *
 * ## 下限為什麼從 3 秒改成 1 秒
 *
 * 2026-09-13 之前這裡寫「下限 3 秒是不可違反的規則」。那句話把 agent 做調查時的姿態
 * （`~\.claude\CLAUDE.md` 那條「3–5 秒」）當成了產品的正確性條件 —— 比 Scrapy 的預設
 * （`DOWNLOAD_DELAY=0` ＋ AutoThrottle）、比 robots 的 `Crawl-delay` 慣例都嚴，
 * 而且嚴的理由不是量出來的。預設值維持 3 秒（與 webscouts 相同，它 2026-08-27 從 1 秒調到 3 秒），
 * 下限 1 秒讓「這個站說可以快一點」有一條路，但**不會有人因為設定成 0 而變成 0**：
 * `clampInterval` 對任何小於下限的輸入都回下限，而不是回錯誤 ——
 * **一個會失敗的設定值最後會被人繞過，一個被夾住的不會。**
 */

/** 同網域請求間隔的下限（毫秒）。 */
export const MIN_INTERVAL_MS = 1_000;

/** 預設值。與 webscouts 的 `DEFAULT_REQUEST_DELAY_SECONDS` 相同。 */
export const DEFAULT_INTERVAL_MS = 3_000;

/** 小於下限一律夾到下限；不是數字就用預設。 */
export function clampInterval(requestedMs: number): number {
  if (!Number.isFinite(requestedMs)) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.floor(requestedMs));
}

/**
 * 實際要用的間隔：**我們自己的設定與對方 `crawl-delay` 取大的那個**。
 *
 * `crawl-delay` 不在 RFC 9309 裡，但它表達的是對方的意願。
 * 比我們長就聽它的；比我們短則忽略 —— 我們不會因為對方說「可以快一點」就加速。
 */
export function effectiveIntervalMs(
  configuredMs: number,
  crawlDelaySeconds: number | null,
): number {
  const base = clampInterval(configuredMs);
  if (crawlDelaySeconds === null || !Number.isFinite(crawlDelaySeconds)) return base;
  return Math.max(base, Math.ceil(crawlDelaySeconds * 1000));
}

/** 距離上一次對同一個 host 的請求還要等多久。 */
export function waitMs(lastRequestAt: number | null, now: number, intervalMs: number): number {
  if (lastRequestAt === null) return 0;
  const earliest = lastRequestAt + intervalMs;
  return earliest > now ? earliest - now : 0;
}

// ── 被限流了怎麼辦 ────────────────────────────────────────────

/**
 * 這個 HTTP 狀態是不是「對方在說慢一點」。
 *
 * **429 與 503 是唯二的退避訊號**（RFC 6585 §4、RFC 9110 §15.6.4，兩者都定義了
 * `Retry-After`）。404 不是 —— 那是單項失敗，其餘 39 個 URL 照常走（`部分失敗` 是一等公民）。
 *
 * 2026-09-13 之前這個訊號的意思是「整批立即停、不重試、`Retry-After` 不看」。
 * 那條規則保護的是**那一台伺服器**，而一批 URL 常常跨很多台 —— 一台限流把整批停掉，
 * 規則就從「不要打擾對方」變成了「懲罰自己」（`source-service.ts` 2026-09-08 實際踩到）。
 * 現在的意思是：**這個 host 退避重試，其他 host 照跑**。
 */
export function isBackOffSignal(status: number): boolean {
  return status === 429 || status === 503;
}

/** 同一個 URL 被限流之後最多再試幾次。與 Scrapy 的 `RETRY_TIMES` 預設相同。 */
export const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * 沒有 `Retry-After` 時，第 n 次重試前等多久。
 *
 * 第一次 5 秒、第二次 15 秒：比間隔本身長一個量級，因為「對方剛說慢一點」
 * 這件事比我們自己的節奏更該聽。
 */
export const DEFAULT_BACKOFF_MS: readonly number[] = [5_000, 15_000];

/**
 * `Retry-After` 叫我們等超過這麼久就不等了 —— 這一輪先不碰這個 host，項目記成可重排。
 *
 * 一個 run 裡對著一個 host 乾等兩分鐘，使用者看到的是「卡住」；
 * 而對方要我們等那麼久，通常不是「稍後」而是「今天別來了」。
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * 把 `Retry-After` 標頭讀成「還要等幾毫秒」。
 *
 * 兩種形狀（RFC 9110 §10.2.3）：秒數，或 HTTP-date。讀不出來就當沒有 —— 這時用預設退避，
 * 不是報錯：一個寫壞的標頭不該讓我們比沒有標頭時更急。
 */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (text.length === 0) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // HTTP-date 的三種寫法都以星期幾開頭（`Sun, 06 Nov 1994 …`）。不先檢查的話，
  // `Date.parse` 會很寬容地把 `-5`、`2` 這種東西讀成某一年。
  if (!/^[A-Za-z]{3}/.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * 被限流了：這一次要等多久再試，還是放棄這個 host。
 *
 * @param retryAfterMs 對方說的（`parseRetryAfter` 的結果），沒有就 `null`
 * @param attempt      已經重試過幾次（0 = 這是第一次被限流）
 * @returns 要等的毫秒數；`'give-up'` = 這一輪不再碰這個 host
 *
 * 對方有說就聽對方的（**不打折**：`Retry-After` 比我們的預設短也照它的，那是它的意願），
 * 沒說就用 `DEFAULT_BACKOFF_MS`。超過 `MAX_RETRY_AFTER_MS` 或重試次數用完就放棄。
 */
export function backOffDelayMs(retryAfterMs: number | null, attempt: number): number | 'give-up' {
  if (attempt >= MAX_RATE_LIMIT_RETRIES) return 'give-up';
  const fallback = DEFAULT_BACKOFF_MS[attempt] ?? DEFAULT_BACKOFF_MS[DEFAULT_BACKOFF_MS.length - 1];
  const delay =
    retryAfterMs === null ? (fallback as number) : Math.max(0, Math.floor(retryAfterMs));
  if (delay > MAX_RETRY_AFTER_MS) return 'give-up';
  return delay;
}
