/**
 * 被限流時的退避與重試（2026-09-13，CONVENTIONS §17）—— 對著一個行為可以設定的假網站。
 *
 * 2026-09-13 之前是「429／503 整批立即停、不重試、`Retry-After` 不看」。
 * 這裡守的是新的形狀：**同一個 URL 照 `Retry-After` 退避再試，最多兩次；還是不行就
 * 這一輪不再碰這個 host，其他 host 照跑。** 每一條都用真的 HTTP 走 `Crawler`，
 * 因為節流、robots、退避三件事只在那一層組在一起 —— 單獨測 `backOffDelayMs` 證明不了
 * 「其他 host 照跑」。
 *
 * 假網站對 `robots.txt` 回 404（RFC 9309：4xx ＝ 可以抓），對其他路徑照 `plan` 演：
 * 每個路徑一串狀態碼，打一次消耗一個。`Retry-After` 一律很短，測的是次數與順序，不是等多久；
 * 同網域間隔用下限（1 秒），所以每一條測試的秒數 ≈ 該 host 收到的請求數。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIN_INTERVAL_MS } from '../../src/domain/ingest/throttle.js';
import { Crawler } from '../../src/infrastructure/fetch/crawler.js';

interface Step {
  readonly status: number;
  readonly retryAfter?: string;
  /** 3xx 的轉址目標 */
  readonly location?: string;
}

let server: Server;
let port: number;
/** 路徑 → 依序要回的狀態。用完了就回 200。 */
let plan: Map<string, Step[]>;
/** 收到的請求（路徑），**含 robots.txt** —— 「沒送請求」要數得出來。 */
let hits: string[];

beforeEach(async () => {
  plan = new Map();
  hits = [];
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    hits.push(path);
    if (path === '/robots.txt') {
      res.writeHead(404);
      res.end();
      return;
    }
    const steps = plan.get(path) ?? [];
    const step = steps.shift() ?? { status: 200 };
    const headers: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
    if (step.retryAfter !== undefined) headers['retry-after'] = step.retryAfter;
    if (step.location !== undefined) headers['location'] = step.location;
    res.writeHead(step.status, headers);
    res.end(step.status === 200 ? `ok ${path}` : 'slow down');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const url = (path: string, host = '127.0.0.1'): string => `http://${host}:${port}${path}`;
const pageHits = (path: string): number => hits.filter((h) => h === path).length;

describe('被限流之後', () => {
  it('429 帶 Retry-After → 等過再試，第二次 200 就成功，而且等的時間量得到', async () => {
    plan.set('/a', [{ status: 429, retryAfter: '1' }]);
    const crawler = new Crawler({ intervalMs: MIN_INTERVAL_MS });

    const r = await crawler.fetch(url('/a'));

    expect(r.outcome.kind).toBe('ok');
    expect(r.rateLimited).toBe(false);
    expect(pageHits('/a')).toBe(2);
    // 退避的 1 秒要算進 waitedMs —— REQ-0003 的「可量測」
    expect(r.waitedMs).toBeGreaterThanOrEqual(1_000);
    expect(crawler.limitedHosts.size).toBe(0);
  });

  it('一直 429 → 重試兩次就放棄：3 個請求，FETCH_RATE_LIMITED，host 進放棄名單', async () => {
    plan.set('/b', [
      { status: 429, retryAfter: '0' },
      { status: 503, retryAfter: '0' },
      { status: 429, retryAfter: '0' },
      { status: 429, retryAfter: '0' },
    ]);
    const crawler = new Crawler({ intervalMs: MIN_INTERVAL_MS });

    const r = await crawler.fetch(url('/b'));

    expect(r.outcome.kind === 'error' && r.outcome.code).toBe('FETCH_RATE_LIMITED');
    expect(r.rateLimited).toBe(true);
    expect(pageHits('/b')).toBe(3);
    expect([...crawler.limitedHosts.keys()]).toEqual(['127.0.0.1']);
    // **不是使用者取消** —— 之前這裡會把整台停掉
    expect(crawler.isStopped).toBe(false);
  });

  it('放棄之後，同一個 host 的下一個 URL 不送請求就記成限流；別的 host 照跑', async () => {
    plan.set('/c', [
      { status: 429, retryAfter: '0' },
      { status: 429, retryAfter: '0' },
      { status: 429, retryAfter: '0' },
    ]);
    const crawler = new Crawler({ intervalMs: MIN_INTERVAL_MS });
    await crawler.fetch(url('/c'));
    expect(crawler.limitedHosts.has('127.0.0.1')).toBe(true);

    const before = hits.length;
    const same = await crawler.fetch(url('/c2'));
    expect(same.outcome.kind === 'error' && same.outcome.code).toBe('FETCH_RATE_LIMITED');
    expect(same.outcome.kind === 'error' && same.outcome.detail['why']).toBe('host-limited');
    expect(same.rateLimited).toBe(true);
    expect(hits.length).toBe(before); // 一個請求都沒送

    // 同一台假網站、另一個 hostname —— 對節流與放棄名單來說是另一個 host
    const other = await crawler.fetch(url('/d', 'localhost'));
    expect(other.outcome.kind).toBe('ok');
    expect(other.rateLimited).toBe(false);
  });

  it('轉址到已經放棄的 host → 那一跳不送請求，記成限流（短網址繞不過去）', async () => {
    plan.set('/h', [
      { status: 429, retryAfter: '0' },
      { status: 429, retryAfter: '0' },
      { status: 429, retryAfter: '0' },
    ]);
    const crawler = new Crawler({ intervalMs: MIN_INTERVAL_MS });
    await crawler.fetch(url('/h', 'localhost'));
    expect(crawler.limitedHosts.has('localhost')).toBe(true);

    // 127.0.0.1 的 /r 轉址到 localhost 的 /y —— 起點的 host 沒被放棄，中途那一跳有
    plan.set('/r', [{ status: 302, location: url('/y', 'localhost') }]);
    const r = await crawler.fetch(url('/r'));

    expect(r.rateLimited).toBe(true);
    expect(r.outcome.kind === 'error' && r.outcome.detail['why']).toBe('host-limited');
    expect(pageHits('/r')).toBe(1);
    expect(pageHits('/y')).toBe(0);
  });

  it('Retry-After 超過上限 → 不等，直接放棄這個 host', async () => {
    plan.set('/e', [{ status: 429, retryAfter: '3600' }]);
    const crawler = new Crawler({ intervalMs: MIN_INTERVAL_MS });
    const started = Date.now();

    const r = await crawler.fetch(url('/e'));

    expect(r.rateLimited).toBe(true);
    expect(pageHits('/e')).toBe(1);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('退避中按了取消 → 馬上回來，不等到底', async () => {
    plan.set('/f', [{ status: 429, retryAfter: '30' }]);
    const crawler = new Crawler({ intervalMs: MIN_INTERVAL_MS });
    const started = Date.now();
    setTimeout(() => crawler.stop(), 300);

    const r = await crawler.fetch(url('/f'));

    expect(r.rateLimited).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(crawler.isStopped).toBe(true);
  });

  it('robots.txt 本身被限流 → 走同一條退避路，而且結果不進快取', async () => {
    // 第一次問 robots 回 429，退避後再問就 404（可以抓）
    let robotsCalls = 0;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      const path = req.url ?? '/';
      hits.push(path);
      if (path === '/robots.txt') {
        robotsCalls += 1;
        if (robotsCalls === 1) {
          res.writeHead(429, { 'retry-after': '0' });
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const crawler = new Crawler({ intervalMs: MIN_INTERVAL_MS });

    const r = await crawler.fetch(url('/g'));

    expect(r.outcome.kind).toBe('ok');
    expect(robotsCalls).toBe(2);
    expect(pageHits('/g')).toBe(1);
  });
});
