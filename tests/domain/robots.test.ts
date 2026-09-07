import { describe, expect, it } from 'vitest';
import {
  ALLOW_ALL,
  DISALLOW_ALL,
  isAllowed,
  matchesPattern,
  parseRobots,
  robotsPathOf,
} from '../../src/domain/ingest/robots.js';

describe('robots.txt 的解析（RFC 9309）', () => {
  it('挑得到專屬群組，而且 * 群組整組作廢', () => {
    const policy = parseRobots(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: cyclosa', 'Disallow: /private'].join('\n'),
    );
    // 專屬群組只擋 /private —— **不是跟 * 群組合併**（合併的話這裡會被擋）
    expect(isAllowed(policy, '/anything').allowed).toBe(true);
    expect(isAllowed(policy, '/private/x').allowed).toBe(false);
  });

  it('沒有專屬群組時退回 *', () => {
    const policy = parseRobots('User-agent: *\nDisallow: /admin');
    expect(isAllowed(policy, '/admin/x').allowed).toBe(false);
    expect(isAllowed(policy, '/public').allowed).toBe(true);
  });

  it('**空的 Disallow 是「什麼都不擋」**，不是「擋掉空路徑」', () => {
    const policy = parseRobots('User-agent: *\nDisallow:');
    expect(policy.rules).toHaveLength(0);
    expect(isAllowed(policy, '/anything').allowed).toBe(true);
  });

  it('最長的樣式贏，長度一樣時 Allow 贏', () => {
    const policy = parseRobots(
      ['User-agent: *', 'Disallow: /a', 'Allow: /a/b', 'Disallow: /x', 'Allow: /x'].join('\n'),
    );
    expect(isAllowed(policy, '/a/c').allowed).toBe(false);
    expect(isAllowed(policy, '/a/b/c').allowed).toBe(true);
    // 同長度 → Allow 贏
    expect(isAllowed(policy, '/x').allowed).toBe(true);
  });

  it('命中的規則要回報得出來 —— **不是靜默跳過**', () => {
    const policy = parseRobots('User-agent: *\nDisallow: /secret');
    expect(isAllowed(policy, '/secret/a').rule).toBe('Disallow: /secret');
    expect(isAllowed(policy, '/open').rule).toBeNull();
  });

  it('井字號之後是註解', () => {
    const policy = parseRobots('User-agent: *  # 大家\nDisallow: /a # 這一條');
    expect(isAllowed(policy, '/a').allowed).toBe(false);
  });

  it('crawl-delay 讀得出來（RFC 沒有它，但它普遍存在）', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: 10').crawlDelaySeconds).toBe(10);
    expect(parseRobots('User-agent: *\nDisallow:').crawlDelaySeconds).toBeNull();
  });

  it('完全空的檔案 = 什麼都不擋', () => {
    expect(isAllowed(parseRobots(''), '/x').allowed).toBe(true);
  });
});

describe('樣式比對', () => {
  it('* 是任意長度', () => {
    expect(matchesPattern('/a*b', '/axxxb')).toBe(true);
    expect(matchesPattern('/a*b', '/ab')).toBe(true);
    expect(matchesPattern('/a*b', '/axxx')).toBe(false);
  });

  it('$ 錨定結尾', () => {
    expect(matchesPattern('/a.pdf$', '/a.pdf')).toBe(true);
    expect(matchesPattern('/a.pdf$', '/a.pdf?x=1')).toBe(false);
    expect(matchesPattern('/a.pdf', '/a.pdf?x=1')).toBe(true);
  });

  it('比對的是路徑加查詢字串', () => {
    expect(robotsPathOf('https://example.com/a/b?c=1#d')).toBe('/a/b?c=1');
  });

  it('**不用 RegExp**，所以樣式裡的特殊字元只是字元', () => {
    expect(matchesPattern('/a(b)+c', '/a(b)+c')).toBe(true);
    expect(matchesPattern('/a(b)+c', '/abbc')).toBe(false);
  });
});

describe('兩個方向相反的預設值', () => {
  it('**4xx（沒有 robots.txt）＝ 可以抓**', () => {
    expect(isAllowed(ALLOW_ALL, '/anything').allowed).toBe(true);
  });

  it('**5xx／連不上（拿不到 robots.txt）＝ 全部不准**', () => {
    expect(isAllowed(DISALLOW_ALL, '/anything').allowed).toBe(false);
    expect(isAllowed(DISALLOW_ALL, '/').allowed).toBe(false);
  });
});
