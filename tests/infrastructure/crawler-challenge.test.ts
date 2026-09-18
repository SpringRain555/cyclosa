/**
 * 反爬蟲驗證頁走完整條擷取路（2026-09-18，open-questions Q7）—— 對著一個假網站。
 *
 * **單獨測 `classifyChallenge` 證明不了這件事**：判斷要拿到標頭才做得了，
 * 而標頭只有 `fetcher.ts` 那一層看得到。這裡守的是三件事在同一條路上都成立：
 *
 * 1. 探測要的是機器格式，回 HTML 就不是內容（第一層）
 * 2. 200 ＋ 廠商標記也不是內容（第二層）
 * 3. **403 要分得開兩種**：帶廠商標頭的是「對方擋工具」，沒有的才是「要登入」
 *
 * 假網站對 `robots.txt` 回 404（RFC 9309：4xx ＝ 可以抓）。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIN_INTERVAL_MS } from '../../src/domain/ingest/throttle.js';
import { Crawler } from '../../src/infrastructure/fetch/crawler.js';

/** 2026-09-18 從 dblp 實抓的那一張，只留判斷會看的部分。 */
const ANUBIS_PAGE =
  '<!doctype html><html lang="en"><head><title>Making sure you&#39;re not a bot!</title>' +
  '<link rel="stylesheet" href="/.within.website/x/xess/xess.min.css?cachebuster=v1.27.0">' +
  '<meta name="robots" content="noindex,nofollow">' +
  '<script id="anubis_version" type="application/json">"v1.27.0"</script></head><body></body></html>';

let server: Server;
let port: number;

beforeEach(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    if (path.startsWith('/api-returns-html')) {
      // 一支 API 回網頁 —— dblp 那一張就是這個形狀（200 ＋ text/html）。
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(ANUBIS_PAGE);
      return;
    }
    if (path.startsWith('/api-returns-json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"hits":[]}');
      return;
    }
    if (path.startsWith('/cf-challenge')) {
      res.writeHead(200, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
      res.end('<html><body>一張挑戰頁</body></html>');
      return;
    }
    if (path.startsWith('/cf-403')) {
      res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
      res.end('<html><body>擋下</body></html>');
      return;
    }
    if (path.startsWith('/paywall-403')) {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><body>請訂閱</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><article>一篇正常的文章</article></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const crawler = (): Crawler => new Crawler({ intervalMs: MIN_INTERVAL_MS });
const url = (path: string): string => `http://127.0.0.1:${port}${path}`;

describe('擷取路上的反爬蟲驗證頁', () => {
  it('探測要的是機器格式：回 HTML 就是驗證頁，不是「讀得到」', async () => {
    const r = await crawler().fetch(url('/api-returns-html'), { expect: 'data' });
    expect(r.outcome.kind).toBe('error');
    if (r.outcome.kind !== 'error') return;
    expect(r.outcome.code).toBe('FETCH_BOT_CHALLENGE');
    expect(r.outcome.detail['basis']).toBe('expected-type');
    expect(r.outcome.detail['certain']).toBe(true);
  });

  it('探測拿到 JSON 就是正常的', async () => {
    const r = await crawler().fetch(url('/api-returns-json'), { expect: 'data' });
    expect(r.outcome.kind).toBe('ok');
  });

  it('沒說要什麼型別時，廠商標頭照樣認得（200）', async () => {
    const r = await crawler().fetch(url('/cf-challenge'));
    expect(r.outcome.kind).toBe('error');
    if (r.outcome.kind !== 'error') return;
    expect(r.outcome.code).toBe('FETCH_BOT_CHALLENGE');
    expect(r.outcome.detail['vendor']).toBe('cloudflare');
  });

  it('403 分得開：帶廠商標頭的不是「要登入」', async () => {
    const blocked = await crawler().fetch(url('/cf-403'));
    expect(blocked.outcome.kind).toBe('error');
    if (blocked.outcome.kind !== 'error') return;
    expect(blocked.outcome.code).toBe('FETCH_BOT_CHALLENGE');

    const paywall = await crawler().fetch(url('/paywall-403'));
    expect(paywall.outcome.kind).toBe('error');
    if (paywall.outcome.kind !== 'error') return;
    // **沒有依據就不猜** —— 這一種仍然是「要登入或訂閱」。
    expect(paywall.outcome.code).toBe('FETCH_LOGIN_REQUIRED');
  });

  it('一般網頁不受影響', async () => {
    const r = await crawler().fetch(url('/article'));
    expect(r.outcome.kind).toBe('ok');
  });
});
