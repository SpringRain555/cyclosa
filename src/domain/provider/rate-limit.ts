/**
 * LLM 端點回 429 時怎麼辦。**純函式，零 I/O**；真的去睡的在 `infrastructure/providers/`。
 *
 * ## SDK 式退避，而不是「立刻停、不重試」
 *
 * 2026-09-13 之前 `PROVIDER_RATE_LIMITED` 的說明寫著「立刻停，不重試 —— 那是這個專案對
 * 所有外部服務的同一條規矩」。那條規矩來自 agent 做調查時的姿態（CONVENTIONS §17，D2），
 * 而它對 LLM 端點是錯的：OpenAI 的官方 Node SDK 預設就會對 429 重試 2 次（指數退避），
 * `Retry-After` 在 0～60 秒之內就照它的（2026-09-13 對照 `src/client.ts`）——
 * 端點回 429 的意思是「排隊」，不是「別來了」。與 SDK 的差別寫在 `docs/architecture/fetch-policy.md`。
 * 一個任務在最後一次呼叫因為一次流量整形就整個作廢，是把使用者的時間當成免費的。
 *
 * ## 與擷取管線的差別
 *
 * 擷取那邊（`domain/ingest/throttle.ts`）退避的單位是**秒**（5、15），因為對方是別人的網站，
 * 慢一點是禮貌；這邊是**半秒起跳**，因為對方是一個賣 API 的服務，429 是它的流量整形，
 * OpenAI 的 SDK 就是這樣做的（0.5 秒 × 2ⁿ）。兩邊共用 `Retry-After` 的解析與「超過上限就放棄」的形狀。
 */
import { parseRetryAfter } from '../ingest/throttle.js';

/** 同一次呼叫最多再試幾次。與 OpenAI 官方 SDK 的 `maxRetries` 預設相同。 */
export const PROVIDER_MAX_RETRIES = 2;

/** 沒有 `Retry-After` 時第 n 次重試前等多久：0.5 秒 × 2ⁿ。 */
export const PROVIDER_BACKOFF_MS: readonly number[] = [500, 1_000];

/** `Retry-After` 超過這個值就不等了 —— 一次任務不該為了一個端點卡住一分鐘以上。 */
export const PROVIDER_MAX_RETRY_AFTER_MS = 60_000;

export { parseRetryAfter };

/**
 * 被 429 了：這一次要等多久再試，還是放棄。
 *
 * @param retryAfterMs 對方說的（`parseRetryAfter`），沒有就 `null`
 * @param attempt      已經重試過幾次（0 = 第一次被 429）
 */
export function providerRetryDelayMs(
  retryAfterMs: number | null,
  attempt: number,
): number | 'give-up' {
  if (attempt >= PROVIDER_MAX_RETRIES) return 'give-up';
  const fallback =
    PROVIDER_BACKOFF_MS[attempt] ?? PROVIDER_BACKOFF_MS[PROVIDER_BACKOFF_MS.length - 1];
  const delay =
    retryAfterMs === null ? (fallback as number) : Math.max(0, Math.floor(retryAfterMs));
  if (delay > PROVIDER_MAX_RETRY_AFTER_MS) return 'give-up';
  return delay;
}
