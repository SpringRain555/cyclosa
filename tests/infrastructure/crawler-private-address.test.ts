/**
 * 擷取管線不連本機與區網（ADR-0038）—— 對著一個真的假網站。
 *
 * 守三件事：
 *
 * 1. **預設就擋**，而且擋在 robots 之前 —— 假網站連 `robots.txt` 都收不到請求
 * 2. **轉址的中途也擋**：第一跳放行的網站把人轉到區網，下一跳不送
 * 3. 主機名解析出來的**任何一筆**不是公開位址就擋，不是只看第一筆
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MIN_INTERVAL_MS } from '../../src/domain/ingest/throttle.js';
import { Crawler } from '../../src/infrastructure/fetch/crawler.js';

let server: Server;
let port: number;
let hits: string[];

beforeEach(async () => {
  hits = [];
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    hits.push(path);
    if (path === '/robots.txt') {
      res.writeHead(404).end();
      return;
    }
    if (path === '/to-intranet') {
      res.writeHead(302, { location: 'http://10.0.0.1/admin' }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><article>本機服務的內容</article></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('擷取管線不連非公開位址', () => {
  it('預設擋本機，一個請求都不送（連 robots.txt 都不問）', async () => {
    const crawler = new Crawler({ intervalMs: MIN_INTERVAL_MS });
    const { outcome } = await crawler.fetch(`http://127.0.0.1:${port}/api/cases`);
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.code).toBe('FETCH_PRIVATE_ADDRESS');
    expect(outcome.detail['scope']).toBe('loopback');
    expect(hits).toEqual([]);
  });

  it('IPv4 包在 IPv6 裡也擋', async () => {
    const crawler = new Crawler({ intervalMs: MIN_INTERVAL_MS });
    const { outcome } = await crawler.fetch(`http://[::ffff:127.0.0.1]:${port}/`);
    expect(outcome.kind === 'error' && outcome.code).toBe('FETCH_PRIVATE_ADDRESS');
    expect(hits).toEqual([]);
  });

  it('轉址到區網的那一跳不送', async () => {
    // 只放行假網站自己，模擬「第一跳是公開網站」
    const crawler = new Crawler({
      intervalMs: MIN_INTERVAL_MS,
      privateAddressAllowed: (ip) => ip === '127.0.0.1',
    });
    const { outcome } = await crawler.fetch(`http://127.0.0.1:${port}/to-intranet`);
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(outcome.code).toBe('FETCH_PRIVATE_ADDRESS');
    expect(outcome.detail).toMatchObject({ host: '10.0.0.1', scope: 'private' });
    expect(hits).toContain('/to-intranet');
  });

  it('解析出好幾筆時，只要有一筆不是公開位址就擋', async () => {
    const crawler = new Crawler({
      intervalMs: MIN_INTERVAL_MS,
      resolveHost: async () => ['93.184.215.14', '192.168.1.1'],
    });
    const { outcome } = await crawler.fetch('http://rebind.example/');
    expect(outcome.kind === 'error' && outcome.code).toBe('FETCH_PRIVATE_ADDRESS');
    expect(outcome.kind === 'error' && outcome.detail['address']).toBe('192.168.1.1');
  });

  it('放行的時候照常抓', async () => {
    const crawler = new Crawler({ intervalMs: MIN_INTERVAL_MS, privateAddressAllowed: () => true });
    const { outcome } = await crawler.fetch(`http://127.0.0.1:${port}/page`);
    expect(outcome.kind).toBe('ok');
  });
});
