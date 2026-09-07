/**
 * 節流政策。**純函式，零 I/O** —— 真的去睡的那一段在 `infrastructure/fetch/`。
 *
 * **下限 3 秒是不可違反的規則之一，不是偏好設定**
 * （`AGENTS.md`／`CLAUDE.md` 的擷取紀律）。所以這裡沒有「設定成 0」這條路：
 * `clampInterval` 對任何小於下限的輸入都回下限，而不是回錯誤 ——
 * **一個會失敗的設定值最後會被人繞過，一個被夾住的不會。**
 */

/** 同網域請求間隔的下限（毫秒）。 */
export const MIN_INTERVAL_MS = 3_000;

/** 預設值。文件寫的是「3–5 秒」，我們取下緣並讓使用者只能往上調。 */
export const DEFAULT_INTERVAL_MS = 3_000;

/** 只能調長不能調短。 */
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

/**
 * 這個 HTTP 狀態要不要**立即停止而且不重試**。
 *
 * **429 與 503 是唯二的「立即停」**，而它們的共通點是「對方在說慢一點」。
 * 404 不是 —— 那是單項失敗，其餘 39 個 URL 照常走（`部分失敗` 是一等公民）。
 */
export function isBackOffSignal(status: number): boolean {
  return status === 429 || status === 503;
}
