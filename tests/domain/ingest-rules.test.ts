import { describe, expect, it } from 'vitest';
import {
  clampInterval,
  effectiveIntervalMs,
  isBackOffSignal,
  MIN_INTERVAL_MS,
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
  it('**下限 3 秒是規則不是偏好** —— 小於下限的一律夾住，而不是回錯誤', () => {
    expect(clampInterval(0)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(-1)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(500)).toBe(MIN_INTERVAL_MS);
    expect(clampInterval(Number.NaN)).toBe(MIN_INTERVAL_MS);
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

  it('**429 與 503 是唯二的「立即停」**，404 不是', () => {
    expect(isBackOffSignal(429)).toBe(true);
    expect(isBackOffSignal(503)).toBe(true);
    expect(isBackOffSignal(404)).toBe(false);
    expect(isBackOffSignal(500)).toBe(false);
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
