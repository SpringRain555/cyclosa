/**
 * 擷取節奏的設定值：從哪裡讀、給畫面看的形狀。
 *
 * 數字本身在 `domain/ingest/throttle.ts`（唯一的宣告處）。這裡只做兩件事：
 * 把環境變數 `CYCLOSA_FETCH_INTERVAL_MS` 讀進來夾好，以及把政策整理成一個
 * 畫面與日誌都能用的物件 —— **「對外抓取的規矩」那一列從這裡拿數字，不寫死在 i18n 裡**
 * （2026-09-13 之前畫面上寫死「同網域間隔 3 秒」，那句話與程式的真值只是碰巧相同）。
 *
 * 為什麼用環境變數而不是設定頁：這是「某個人在這台機器上的決定」（某個站要求別吵、
 * 機器在計量網路上），不是專題的屬性；而且它要在**任何**作業開始之前就定下來。
 * webscouts 的 `WEBSCOUTS_GLOBAL_RATE_LIMIT` 是同一個形狀。
 */
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_INTERVAL_MS,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RETRY_AFTER_MS,
  MIN_INTERVAL_MS,
  clampInterval,
} from '../domain/ingest/throttle.js';

export const FETCH_INTERVAL_ENV = 'CYCLOSA_FETCH_INTERVAL_MS';

export interface FetchPolicy {
  /** 同網域間隔（毫秒），已經夾過下限。 */
  readonly intervalMs: number;
  /** 下限（毫秒）—— 設定再小也不會低於它。 */
  readonly minIntervalMs: number;
  /** `intervalMs` 是預設值還是環境變數給的。 */
  readonly intervalSource: 'default' | 'env';
  /** 同一個 URL 被限流之後最多再試幾次。 */
  readonly maxRetries: number;
  /** 沒有 `Retry-After` 時每一次重試前等多久（毫秒）。 */
  readonly backOffMs: readonly number[];
  /** `Retry-After` 超過這個值就不等了，這一輪放棄那個 host。 */
  readonly maxRetryAfterMs: number;
}

/** 這一次執行要用的同網域間隔。環境變數不是數字或小於下限時，行為與沒設一樣或被夾住。 */
export function configuredIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FETCH_INTERVAL_ENV];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_INTERVAL_MS;
  return clampInterval(Number(raw));
}

export function describeFetchPolicy(env: NodeJS.ProcessEnv = process.env): FetchPolicy {
  const raw = env[FETCH_INTERVAL_ENV];
  const fromEnv = raw !== undefined && raw.trim().length > 0 && Number.isFinite(Number(raw));
  return {
    intervalMs: configuredIntervalMs(env),
    minIntervalMs: MIN_INTERVAL_MS,
    intervalSource: fromEnv ? 'env' : 'default',
    maxRetries: MAX_RATE_LIMIT_RETRIES,
    backOffMs: DEFAULT_BACKOFF_MS,
    maxRetryAfterMs: MAX_RETRY_AFTER_MS,
  };
}
