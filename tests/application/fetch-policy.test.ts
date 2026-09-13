/**
 * 同網域間隔的設定值從哪來（2026-09-13）：預設，或 `CYCLOSA_FETCH_INTERVAL_MS`。
 * **環境變數設成 0 不會變成 0** —— 夾住是規則，數字才是設定值。
 */
import { describe, expect, it } from 'vitest';

import {
  FETCH_INTERVAL_ENV,
  configuredIntervalMs,
  describeFetchPolicy,
} from '../../src/application/fetch-policy.js';
import { DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS } from '../../src/domain/ingest/throttle.js';

const env = (value: string | undefined): NodeJS.ProcessEnv =>
  value === undefined ? {} : { [FETCH_INTERVAL_ENV]: value };

describe('同網域間隔的設定值', () => {
  it('沒設 → 預設', () => {
    expect(configuredIntervalMs(env(undefined))).toBe(DEFAULT_INTERVAL_MS);
    expect(describeFetchPolicy(env(undefined)).intervalSource).toBe('default');
  });

  it('設了一個數字 → 用它，而且畫面說得出來源是環境變數', () => {
    expect(configuredIntervalMs(env('5000'))).toBe(5_000);
    expect(describeFetchPolicy(env('5000'))).toMatchObject({
      intervalMs: 5_000,
      intervalSource: 'env',
    });
  });

  it('**設成比下限小 → 夾到下限，不是照做**', () => {
    expect(configuredIntervalMs(env('0'))).toBe(MIN_INTERVAL_MS);
    expect(configuredIntervalMs(env('200'))).toBe(MIN_INTERVAL_MS);
    expect(describeFetchPolicy(env('0')).intervalMs).toBe(MIN_INTERVAL_MS);
  });

  it('不是數字或空字串 → 當成沒設（不是報錯，也不是變成 0）', () => {
    expect(configuredIntervalMs(env('fast'))).toBe(DEFAULT_INTERVAL_MS);
    expect(configuredIntervalMs(env('  '))).toBe(DEFAULT_INTERVAL_MS);
    expect(describeFetchPolicy(env('fast')).intervalSource).toBe('default');
  });
});
