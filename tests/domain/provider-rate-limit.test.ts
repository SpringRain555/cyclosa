/**
 * LLM 端點的 429（2026-09-13）：照官方 SDK 的形狀退避，而不是「立刻停、不重試」。
 * 與擷取管線共用 `Retry-After` 的解析，差別只在數字（半秒起跳，而不是五秒）。
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_BACKOFF_MS } from '../../src/domain/ingest/throttle.js';
import {
  PROVIDER_BACKOFF_MS,
  PROVIDER_MAX_RETRIES,
  PROVIDER_MAX_RETRY_AFTER_MS,
  providerRetryDelayMs,
} from '../../src/domain/provider/index.js';

describe('LLM 端點被 429 之後', () => {
  it('沒有 Retry-After → 0.5 秒 × 2ⁿ，兩次之後放棄', () => {
    expect(PROVIDER_BACKOFF_MS.length).toBe(PROVIDER_MAX_RETRIES);
    expect(providerRetryDelayMs(null, 0)).toBe(500);
    expect(providerRetryDelayMs(null, 1)).toBe(1_000);
    expect(providerRetryDelayMs(null, PROVIDER_MAX_RETRIES)).toBe('give-up');
  });

  it('Retry-After 照它的；超過上限就放棄', () => {
    expect(providerRetryDelayMs(7_000, 0)).toBe(7_000);
    expect(providerRetryDelayMs(PROVIDER_MAX_RETRY_AFTER_MS + 1, 0)).toBe('give-up');
  });

  it('**比擷取管線急** —— 對方是賣 API 的服務，429 是流量整形；別人的網站才需要禮貌地慢', () => {
    expect(PROVIDER_BACKOFF_MS[0]).toBeLessThan(DEFAULT_BACKOFF_MS[0] as number);
  });
});
