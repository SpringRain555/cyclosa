/**
 * 「這一頁是內容，還是反爬蟲的驗證頁？」
 *
 * **這一份存在的理由是一個真的犯過的錯。** 2026-09-16 dblp 的探針回 200、
 * text/html，當時只看了狀態碼就在文件裡寫「內容是 JSON」，而那一頁是 Anubis 的驗證頁。
 *
 * 所以下面第一組用的是**那一張真的頁面**（2026-09-18 實抓，只留判斷會看的那幾行），
 * 而不是一份我照著想像編出來的 HTML —— 憑印象編的樣本會剛好命中我自己寫的規則。
 */
import { describe, expect, it } from 'vitest';

import {
  classifyChallenge,
  vendorChallengeHeader,
  WEAK_MAX_BYTES,
  type HttpFacts,
} from '../../src/domain/ingest/challenge.js';

/**
 * 2026-09-18 對 `https://dblp.org/search/publ/api?q=test&format=json&h=1` 實抓的回應。
 * 標頭一字不改；內文留了前面那幾行（整份 7,489 bytes）。
 */
const DBLP_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-type': 'text/html; charset=utf-8',
  date: 'Fri, 18 Sep 2026 01:21:54 GMT',
  'transfer-encoding': 'chunked',
};

const DBLP_BODY =
  '<!doctype html><html lang="en"><head><title>Making sure you&#39;re not a bot!</title>' +
  '<link rel="stylesheet" href="/.within.website/x/xess/xess.min.css?cachebuster=v1.27.0">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
  '<meta name="robots" content="noindex,nofollow"><style>body{}</style>' +
  '<script id="anubis_version" type="application/json">"v1.27.0"</script>';

function facts(over: Partial<HttpFacts> = {}): HttpFacts {
  return {
    headers: DBLP_HEADERS,
    contentType: 'text/html; charset=utf-8',
    bodySize: 7489,
    bodyHead: DBLP_BODY,
    expect: 'data',
    ...over,
  };
}

describe('反爬蟲驗證頁：那張真的 dblp 頁面', () => {
  it('第一層就夠了：要的是機器格式，回來的是網頁', () => {
    // **這一層不認得 Anubis，也不需要認得。**
    const verdict = classifyChallenge(facts({ bodyHead: '', headers: {} }));
    expect(verdict.verdict).toBe('challenge');
    expect(verdict.basis).toBe('expected-type');
    expect(verdict.vendor).toBeNull();
  });

  it('就算沒人告訴它要的是什麼，第二層也認得出 Anubis', () => {
    const verdict = classifyChallenge(facts({ expect: 'any' }));
    expect(verdict.verdict).toBe('challenge');
    expect(verdict.basis).toBe('vendor');
    expect(verdict.vendor).toBe('anubis');
  });

  it('連產品標記都拿掉，第三層仍然說「不確定」而不是「內容」', () => {
    const verdict = classifyChallenge(
      facts({
        expect: 'any',
        bodyHead: '<html><head><meta name="robots" content="noindex,nofollow"></head><body></body>',
      }),
    );
    expect(verdict.verdict).toBe('suspect');
    expect(verdict.basis).toBe('weak');
  });
});

describe('第二層：廠商自己宣告的標頭', () => {
  it('cf-mitigated: challenge 就是 Cloudflare 的挑戰頁', () => {
    expect(vendorChallengeHeader({ 'cf-mitigated': 'challenge' })).toBe('cloudflare');
  });

  it('403 帶 cf-mitigated 也認得 —— 那條路是「不是要登入」的唯一依據', () => {
    expect(vendorChallengeHeader({ 'cf-mitigated': 'CHALLENGE', server: 'cloudflare' })).toBe(
      'cloudflare',
    );
  });

  it('只是走 Cloudflare 的站不算 —— 沒有那個標頭就不是挑戰頁', () => {
    expect(vendorChallengeHeader({ server: 'cloudflare', 'cf-ray': 'abc-TPE' })).toBeNull();
  });

  it('Cloudflare 的 JS Detection 會注入正常內容頁，所以那個字串不算證據', () => {
    // 這一條是**刻意不收**的標記：`__CF$cv$params` 出現在有真內容的頁面上。
    const verdict = classifyChallenge(
      facts({
        expect: 'any',
        contentType: 'text/html',
        headers: { 'content-type': 'text/html' },
        bodySize: 120_000,
        bodyHead: '<html><body><article>真的正文…</article><script>__CF$cv$params={}</script>',
      }),
    );
    expect(verdict.verdict).toBe('content');
  });
});

describe('不要誤判正常的東西', () => {
  it('API 回 JSON 是正常的', () => {
    const verdict = classifyChallenge(
      facts({
        headers: { 'content-type': 'application/json' },
        contentType: 'application/json; charset=utf-8',
        bodySize: 480,
        bodyHead: '{"result":[{"title":"x"}]}',
      }),
    );
    expect(verdict.verdict).toBe('content');
  });

  it('arXiv 那種回 Atom XML 的 API 也是正常的 —— 第一層擋的是 HTML，不是「不是 JSON」', () => {
    const verdict = classifyChallenge(
      facts({
        headers: { 'content-type': 'application/atom+xml' },
        contentType: 'application/atom+xml; charset=utf-8',
        bodySize: 5_000,
        bodyHead: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry/></feed>',
      }),
    );
    expect(verdict.verdict).toBe('content');
  });

  it('使用者貼進來的一般網頁不受第一層影響', () => {
    const verdict = classifyChallenge(
      facts({
        expect: 'any',
        headers: { 'content-type': 'text/html' },
        bodySize: 90_000,
        bodyHead: '<html><body><article>一篇很長的文章</article></body></html>',
      }),
    );
    expect(verdict.verdict).toBe('content');
  });

  it('第三層要四個條件同時成立 —— 少一個就不是「不確定」', () => {
    const noindexOnly = classifyChallenge(
      facts({
        expect: 'any',
        headers: { 'content-type': 'text/html' }, // 少了 no-store
        bodySize: 3_000,
        bodyHead: '<html><head><meta name="robots" content="noindex"></head><body>短頁</body>',
      }),
    );
    expect(noindexOnly.verdict).toBe('content');

    const bigOne = classifyChallenge(
      facts({
        expect: 'any',
        bodySize: WEAK_MAX_BYTES + 1, // 夠大就不算
        bodyHead: '<html><head><meta name="robots" content="noindex,nofollow"></head><body>',
      }),
    );
    expect(bigOne.verdict).toBe('content');
  });
});
