/**
 * 來源網站的判斷與實體對齊。
 *
 * **這一份測的是兩條「兩種錯的代價不對稱」的規則：**
 *
 * 1. 網站判斷平手時「需要登入」勝出 —— 標錯成可讀，agent 會一直往那裡花錢。
 * 2. 名字不像就回 `null`，不回一個很低的分數 —— 一份塞滿雜訊的
 *    待合併清單等於沒有清單，而一次錯的合併看不出來。
 */
import { describe, expect, it } from 'vitest';

import {
  accessFromCode,
  EMPTY_HISTORY,
  preferenceOf,
  verdictOf,
  type SiteHistory,
} from '../../src/domain/sources/status.js';
import {
  identityKey,
  matchOf,
  resolveMerged,
  splitParenthetical,
  suggestMerges,
  surfaceFormsOf,
} from '../../src/domain/entity/identity.js';
import { CATALOG, normaliseHost } from '../../src/infrastructure/sources/catalog.js';

describe('擷取的碼 → 這個網站讀不讀得到', () => {
  it.each([
    ['沒有碼就是抓到了', null, 'open'],
    ['付費牆', 'FETCH_LOGIN_REQUIRED', 'login'],
    ['對方限流', 'FETCH_RATE_LIMITED', 'throttled'],
    ['robots 不准', 'FETCH_ROBOTS_DISALLOWED', 'disallowed'],
    ['要跑 JS', 'PARSE_JS_ONLY', 'js-only'],
    ['連不到', 'FETCH_DNS', 'unreachable'],
  ])('%s', (_name, code, expected) => {
    expect(accessFromCode(code)).toBe(expected);
  });

  it('抽取信心低不是網站的問題', () => {
    // 這一條分錯的話，一個正文很雜的站會被標成「讀不到」而被降權。
    expect(accessFromCode('PARSE_LOW_CONFIDENCE')).toBe('open');
    expect(accessFromCode('FETCH_DUPLICATE')).toBe('open');
  });
});

describe('判斷：自己的紀錄優先於探測', () => {
  const history = (byAccess: SiteHistory['byAccess'], attempts: number): SiteHistory => ({
    attempts,
    byAccess,
    lastAt: 1000,
    lastCode: null,
  });

  it('抓過就用紀錄，而且說得出依據是哪一個', () => {
    const v = verdictOf(history({ login: 9, open: 3 }, 12), {
      access: 'open',
      code: null,
      at: 2000,
      url: 'https://example.org/probe',
    });
    expect(v).toMatchObject({ access: 'login', basis: 'history', attempts: 12 });
  });

  it('沒抓過才看探測', () => {
    const v = verdictOf(EMPTY_HISTORY, {
      access: 'open',
      code: null,
      at: 2000,
      url: 'https://example.org/probe',
    });
    expect(v).toMatchObject({ access: 'open', basis: 'probe', at: 2000 });
  });

  it('兩個都沒有就說不知道 —— 不猜一個', () => {
    expect(verdictOf(EMPTY_HISTORY, null)).toMatchObject({ access: 'unknown', basis: 'none' });
  });

  it('**平手時「需要登入」勝出**', () => {
    // 兩種錯的代價不對稱：標成要登入頂多多看一眼，
    // 標成讀得到會讓 agent 一直往那裡找，而每一次都要花錢才發現。
    const v = verdictOf(history({ login: 5, open: 5 }, 10), null);
    expect(v.access).toBe('login');
  });

  it('只有 open 就是 open', () => {
    expect(verdictOf(history({ open: 4 }, 4), null).access).toBe('open');
  });
});

describe('排序偏好：不優先不等於封鎖', () => {
  it.each([
    ['讀得到 → 優先', 'open', 'prefer'],
    ['要登入 → 降權', 'login', 'deprioritise'],
    ['不知道 → 中立', 'unknown', 'neutral'],
  ] as const)('%s', (_name, access, expected) => {
    expect(preferenceOf({ access, basis: 'history', at: null, attempts: 1 })).toBe(expected);
  });
});

describe('內建清單', () => {
  it('網域不重複，而且都已經正規化', () => {
    const hosts = CATALOG.map((e) => e.host);
    expect(hosts).toEqual(hosts.map(normaliseHost));
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('有探針的都是 https 而且指向那個網域自己', () => {
    for (const entry of CATALOG) {
      if (entry.probe === null) continue;
      expect(entry.probe.startsWith('https://'), entry.host).toBe(true);
      expect(normaliseHost(new URL(entry.probe).host)).toBe(entry.host);
    }
  });

  it('出版社那幾列刻意沒有探針 —— 首頁的 200 什麼都不代表', () => {
    const publishers = CATALOG.filter((e) => e.category === 'publisher');
    expect(publishers.length).toBeGreaterThan(0);
    expect(publishers.every((e) => e.probe === null)).toBe(true);
  });
});

describe('比對用的鍵', () => {
  it.each([
    ['大小寫', 'TSMC', 'tsmc'],
    ['全形英數', 'ＴＳＭＣ', 'tsmc'],
    ['空白', '台積 電', '台積電'],
    ['全形空白', '台積　電', '台積電'],
    ['外圍標點', '《關聯圖》', '關聯圖'],
  ])('%s 抹掉', (_name, left, right) => {
    expect(identityKey(left)).toBe(identityKey(right));
  });

  it('**不做簡繁轉換** —— 那會把不同的字合成一個', () => {
    expect(identityKey('臺灣')).not.toBe(identityKey('台灣'));
  });

  it('不去後綴 —— 「台大」與「台大醫院」是兩個東西', () => {
    expect(identityKey('台大')).not.toBe(identityKey('台大醫院'));
  });
});

describe('括號裡的那個本身就是別名', () => {
  it.each([
    ['台灣積體電路製造（TSMC）', '台灣積體電路製造', 'TSMC'],
    ['Cyclosa ginnaga (銀腹蛛)', 'Cyclosa ginnaga', '銀腹蛛'],
  ])('%s', (input, head, inside) => {
    expect(splitParenthetical(input)).toEqual({ head, inside });
  });

  it('沒有括號就原樣回來', () => {
    expect(splitParenthetical('台積電')).toEqual({ head: '台積電', inside: null });
  });

  it('比對用的寫法包含本名、別名與括號拆出來的', () => {
    const forms = surfaceFormsOf('台灣積體電路製造（TSMC）', ['台積電']);
    expect(forms).toContain('台灣積體電路製造（TSMC）');
    expect(forms).toContain('台灣積體電路製造');
    expect(forms).toContain('TSMC');
    expect(forms).toContain('台積電');
  });
});

describe('兩個實體像不像同一個', () => {
  it('正規化之後一樣', () => {
    expect(matchOf({ name: 'TSMC' }, { name: 'ｔｓｍｃ' })).toMatchObject({ reason: 'same-key' });
  });

  it('括號寫法對上簡稱 —— **這就是圖散掉的那個成因**', () => {
    const m = matchOf({ name: '台灣積體電路製造（TSMC）' }, { name: 'TSMC' });
    expect(m).toMatchObject({ reason: 'parenthetical' });
  });

  it('宣告過的別名', () => {
    const m = matchOf({ name: '台灣積體電路製造', aliases: ['台積電'] }, { name: '台積電' });
    expect(m).toMatchObject({ reason: 'alias' });
  });

  it('不像就回 null，不回一個很低的分數', () => {
    expect(matchOf({ name: '台積電' }, { name: '聯發科' })).toBeNull();
    // 編輯距離很近，而它們是兩個東西。
    expect(matchOf({ name: '台大' }, { name: '台大醫院' })).toBeNull();
  });

  it('名字太短就不比', () => {
    expect(matchOf({ name: '甲' }, { name: '甲' })).toBeNull();
  });
});

describe('合併建議', () => {
  const entities = [
    { id: 'e1', name: '台灣積體電路製造（TSMC）', type: 'org' as const, mergedInto: null },
    { id: 'e2', name: 'TSMC', type: 'org' as const, mergedInto: null },
    { id: 'e3', name: 'tsmc', type: 'person' as const, mergedInto: null },
    { id: 'e4', name: '聯發科', type: 'org' as const, mergedInto: null },
  ];

  it('**型別不同不比** —— 名字一樣是巧合', () => {
    const out = suggestMerges(entities, () => 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ reason: 'parenthetical' });
  });

  it('留被提到比較多次的那一個', () => {
    const counts = new Map([
      ['e1', 2],
      ['e2', 7],
    ]);
    const out = suggestMerges(entities, (id) => counts.get(id) ?? 0);
    expect(out[0]).toMatchObject({ keepId: 'e2', mergeId: 'e1' });
  });

  it('已經被併掉的不再參與', () => {
    const merged = entities.map((e) => (e.id === 'e2' ? { ...e, mergedInto: 'e1' } : e));
    expect(suggestMerges(merged, () => 1)).toEqual([]);
  });
});

describe('順著合併指標走', () => {
  it('走到最後那一個', () => {
    const map = new Map([
      ['c', 'b'],
      ['b', 'a'],
    ]);
    expect(resolveMerged('c', map)).toBe('a');
  });

  it('**成環也會停** —— 讀取路徑上的無窮迴圈會讓整個畫面掛掉', () => {
    const map = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(['a', 'b']).toContain(resolveMerged('a', map));
  });
});
