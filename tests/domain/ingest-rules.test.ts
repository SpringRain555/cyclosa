import { describe, expect, it } from 'vitest';
import {
  backOffDelayMs,
  clampInterval,
  DEFAULT_BACKOFF_MS,
  DEFAULT_INTERVAL_MS,
  effectiveIntervalMs,
  isBackOffSignal,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RETRY_AFTER_MS,
  MIN_INTERVAL_MS,
  parseRetryAfter,
  waitMs,
} from '../../src/domain/ingest/throttle.js';
import { displayHost, normalizeUrl } from '../../src/domain/ingest/url.js';
import {
  classifyExtension,
  classifyMime,
  charsetOf,
  DELIBERATELY_UNSUPPORTED,
} from '../../src/domain/ingest/media-type.js';

describe('節流政策', () => {
  /**
   * 數字是設定值，不是規則（CONVENTIONS §17，2026-09-13）—— 但**夾住**這個行為是規則：
   * 設定成 0 不會變成 0。這一條 2026-09-13 之前寫著「下限 3 秒是規則不是偏好」，
   * 而那時下限與預設是同一個數字，所以「不是數字就用預設」與「夾到下限」測不出差別。
   */
  it('小於下限的一律夾住，而不是回錯誤；不是數字就用預設', () => {
    expect(MIN_INTERVAL_MS).toBeLessThan(DEFAULT_INTERVAL_MS);
    expect(clampInterval(0)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(-1)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(MIN_INTERVAL_MS - 1)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(Number.NaN)).toBe(DEFAULT_INTERVAL_MS);
    expect(clampInterval(Number.POSITIVE_INFINITY)).toBe(DEFAULT_INTERVAL_MS);
  });

  it('只能調長', () => {
    expect(clampInterval(10_000)).toBe(10_000);
  });

  it('對方的 crawl-delay 比我們長就聽它的，比我們短則忽略', () => {
    expect(effectiveIntervalMs(3_000, 10)).toBe(10_000);
    expect(effectiveIntervalMs(3_000, 1)).toBe(3_000);
    expect(effectiveIntervalMs(3_000, null)).toBe(3_000);
  });

  it('等待時間', () => {
    expect(waitMs(null, 1_000, 3_000)).toBe(0);
    expect(waitMs(1_000, 2_000, 3_000)).toBe(2_000);
    expect(waitMs(1_000, 9_000, 3_000)).toBe(0);
  });

  it('**429 與 503 是唯二的退避訊號**，404 與 500 不是', () => {
    expect(isBackOffSignal(429)).toBe(true);
    expect(isBackOffSignal(503)).toBe(true);
    expect(isBackOffSignal(404)).toBe(false);
    expect(isBackOffSignal(500)).toBe(false);
  });
});

describe('被限流之後等多久（Retry-After 與預設退避）', () => {
  const NOW = Date.parse('2026-09-13T08:00:00Z');

  it('Retry-After 的兩種形狀都讀得懂：秒數與 HTTP-date', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter(' 0 ', NOW)).toBe(0);
    expect(parseRetryAfter('Sun, 13 Sep 2026 08:00:30 GMT', NOW)).toBe(30_000);
  });

  it('過去的日期是 0（現在就可以），不是負數', () => {
    expect(parseRetryAfter('Sun, 13 Sep 2026 07:59:00 GMT', NOW)).toBe(0);
  });

  it('**讀不出來就當沒有** —— 一個寫壞的標頭不該讓我們比沒有標頭時更急', () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter('', NOW)).toBeNull();
    expect(parseRetryAfter('soon', NOW)).toBeNull();
    expect(parseRetryAfter('-5', NOW)).toBeNull();
  });

  it('沒有 Retry-After → 照預設退避，次數用完就放棄', () => {
    expect(DEFAULT_BACKOFF_MS.length).toBe(MAX_RATE_LIMIT_RETRIES);
    for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt++) {
      expect(backOffDelayMs(null, attempt)).toBe(DEFAULT_BACKOFF_MS[attempt]);
    }
    expect(backOffDelayMs(null, MAX_RATE_LIMIT_RETRIES)).toBe('give-up');
  });

  it('**對方有說就聽對方的，不打折** —— 比預設短也照它的', () => {
    expect(backOffDelayMs(0, 0)).toBe(0);
    expect(backOffDelayMs(2_000, 0)).toBe(2_000);
    expect(backOffDelayMs(MAX_RETRY_AFTER_MS, 1)).toBe(MAX_RETRY_AFTER_MS);
  });

  it('對方要我們等超過上限 → 不等，這一輪放棄', () => {
    expect(backOffDelayMs(MAX_RETRY_AFTER_MS + 1, 0)).toBe('give-up');
  });

  it('次數用完了，對方說 0 秒也不再試', () => {
    expect(backOffDelayMs(0, MAX_RATE_LIMIT_RETRIES)).toBe('give-up');
  });
});

describe('URL 正規化', () => {
  it('只接受 http 與 https', () => {
    expect(normalizeUrl('https://a.example/x').kind).toBe('ok');
    expect(normalizeUrl('http://a.example/x').kind).toBe('ok');
    expect(normalizeUrl('file:///C:/x.txt')).toEqual({
      kind: 'unsupported-scheme',
      scheme: 'file',
    });
    expect(normalizeUrl('javascript:alert(1)').kind).toBe('unsupported-scheme');
    expect(normalizeUrl('data:text/html,x').kind).toBe('unsupported-scheme');
  });

  it('不是網址的東西是 malformed，不是「還沒支援」', () => {
    expect(normalizeUrl('這是一段文字').kind).toBe('malformed');
    expect(normalizeUrl('  ').kind).toBe('malformed');
  });

  it('拿掉 fragment，**但 query 一律保留**', () => {
    const out = normalizeUrl('https://A.Example.com/p?utm_source=x&q=1#frag');
    expect(out.kind === 'ok' && out.url).toBe('https://a.example.com/p?utm_source=x&q=1');
    expect(out.kind === 'ok' && out.host).toBe('a.example.com');
  });

  it('節流的單位是主機名', () => {
    expect(displayHost('https://a.example.com/x')).toBe('a.example.com');
    expect(displayHost('不是網址')).toBe('');
  });
});

describe('媒體型別', () => {
  it('認得五類支援的來源', () => {
    expect(classifyMime('text/html; charset=utf-8')).toMatchObject({
      itemKind: 'web',
      ext: 'html',
    });
    expect(classifyMime('application/pdf')).toMatchObject({ itemKind: 'pdf', ext: 'pdf' });
    expect(classifyMime('image/png')).toMatchObject({ itemKind: 'image', ext: 'png' });
    expect(classifyMime('text/markdown')).toMatchObject({ itemKind: 'text', ext: 'md' });
    expect(classifyExtension('筆記.md')).toMatchObject({ itemKind: 'text' });
  });

  it('**SVG 是刻意不支援的**，不是漏掉', () => {
    expect(classifyMime('image/svg+xml').kind).toBe('unsupported');
    expect(DELIBERATELY_UNSUPPORTED).toContain('image/svg+xml');
  });

  it('不支援的型別要說得出它是什麼', () => {
    const out = classifyMime('application/zip');
    expect(out).toEqual({ kind: 'unsupported', mime: 'application/zip' });
  });

  it('charset 取得出來', () => {
    expect(charsetOf('text/html; charset=Big5')).toBe('big5');
    expect(charsetOf('text/html')).toBeNull();
  });
});
