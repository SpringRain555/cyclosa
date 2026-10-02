/**
 * 「只收這個工具自己的頁面送來的請求」的判斷本身（ADR-0036）。
 *
 * 純函式，所以每一種標頭組合都在這裡列出來；接到 server 上真的會擋，
 * 由 `tests/e2e/request-origin.test.ts` 對著 `buildServer()` 驗。
 */
import { describe, expect, it } from 'vitest';

import {
  hostnameOf,
  requestVerdict,
  type RequestFacts,
} from '../../src/interface/http/request-guard.js';

function facts(overrides: Partial<RequestFacts>): RequestFacts {
  return {
    method: 'POST',
    host: '127.0.0.1:7433',
    origin: undefined,
    fetchSite: undefined,
    ...overrides,
  };
}

describe('hostnameOf', () => {
  it.each([
    ['127.0.0.1:7433', '127.0.0.1'],
    ['localhost:5173', 'localhost'],
    ['LOCALHOST:7433', 'localhost'],
    ['[::1]:7433', '[::1]'],
    ['localhost', 'localhost'],
    ['evil.example:7433', 'evil.example'],
  ])('%s → %s', (host, expected) => {
    expect(hostnameOf(host)).toBe(expected);
  });

  it.each([undefined, '', '   ', 'a b:7433', 'host:port:extra'])('%s 認不出來 → null', (host) => {
    expect(hostnameOf(host)).toBeNull();
  });
});

describe('requestVerdict', () => {
  it('本機的三種寫法都放行', () => {
    for (const host of ['127.0.0.1:7433', 'localhost:7433', '[::1]:7433']) {
      expect(requestVerdict(facts({ method: 'GET', host }))).toBe('ok');
    }
  });

  it('**DNS rebinding**：Host 是別的網域 → 擋（讀的請求也擋 —— 那正是它要讀回應的那一種）', () => {
    expect(requestVerdict(facts({ method: 'GET', host: 'evil.example:7433' }))).toBe(
      'foreign-host',
    );
    expect(requestVerdict(facts({ method: 'GET', host: '127.0.0.1.evil.example:7433' }))).toBe(
      'foreign-host',
    );
    expect(requestVerdict(facts({ method: 'GET', host: 'localhost.evil.example' }))).toBe(
      'foreign-host',
    );
    expect(requestVerdict(facts({ method: 'GET', host: undefined }))).toBe('foreign-host');
  });

  it('自己的頁面送的 POST：Origin 等於 http:// ＋ Host → 放行', () => {
    expect(requestVerdict(facts({ origin: 'http://127.0.0.1:7433' }))).toBe('ok');
    expect(requestVerdict(facts({ host: '[::1]:7433', origin: 'http://[::1]:7433' }))).toBe('ok');
  });

  it('**Vite 代理**：Host 與 Origin 都是 5173 → 放行', () => {
    expect(
      requestVerdict(
        facts({
          host: 'localhost:5173',
          origin: 'http://localhost:5173',
          fetchSite: 'same-origin',
        }),
      ),
    ).toBe('ok');
  });

  it('沒有 Origin 的請求（啟動器、終端機、app.inject）→ 放行', () => {
    expect(requestVerdict(facts({}))).toBe('ok');
    expect(requestVerdict(facts({ fetchSite: 'none' }))).toBe('ok');
  });

  it('跨站的 POST → 擋', () => {
    expect(requestVerdict(facts({ origin: 'http://evil.example' }))).toBe('foreign-origin');
    expect(requestVerdict(facts({ origin: 'https://127.0.0.1:7433' }))).toBe('foreign-origin');
    // sandbox 的 iframe、file:// 的頁面送的是字串 "null"
    expect(requestVerdict(facts({ origin: 'null' }))).toBe('foreign-origin');
  });

  it('**同一台機器別的埠**的網頁 → 擋（只比主機名的話會放行）', () => {
    expect(requestVerdict(facts({ origin: 'http://localhost:8080' }))).toBe('foreign-origin');
    expect(requestVerdict(facts({ origin: 'http://127.0.0.1:7434' }))).toBe('foreign-origin');
  });

  it('Sec-Fetch-Site 不是 same-origin／none → 擋，即使沒有 Origin', () => {
    expect(requestVerdict(facts({ fetchSite: 'cross-site' }))).toBe('foreign-origin');
    expect(requestVerdict(facts({ fetchSite: 'same-site' }))).toBe('foreign-origin');
  });

  it('PUT／PATCH／DELETE 跟 POST 一樣看 Origin', () => {
    for (const method of ['PUT', 'patch', 'DELETE']) {
      expect(requestVerdict(facts({ method, origin: 'http://evil.example' }))).toBe(
        'foreign-origin',
      );
    }
  });

  it('GET 不看 Origin（瀏覽器會擋跨站讀回應；改東西的路由都不是 GET）', () => {
    expect(requestVerdict(facts({ method: 'GET', origin: 'http://evil.example' }))).toBe('ok');
  });
});
