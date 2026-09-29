/**
 * 蒐集那一段的規則（Stage 20，ADR-0033 D3／D7）與候選的正規化。
 *
 * **這幾條是畫面上每一顆按鈕按不按得下去的依據**：上傳、標拿不到、繼續蒐集、完成蒐集。
 * 規則錯了的症狀是「一顆按了就報錯的按鈕」或更糟 —— 一顆不該在的按鈕按下去成功了。
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_CANDIDATES_PER_DIRECTION,
  normalizeResearchCandidates,
} from '../../src/domain/provider/candidates.js';
import {
  accessPlan,
  collectWork,
  mayActOnCandidate,
  mayFinishCollecting,
  mayMove,
  mayResumeCollecting,
  needsDigest,
  needsFetch,
  statusAfterCollectRun,
  stopsDigesting,
  tallyDirection,
  type Acquisition,
  type CandidateWork,
} from '../../src/domain/research/index.js';
import type { SiteVerdict } from '../../src/domain/sources/status.js';

const recorded = (access: SiteVerdict['access']): SiteVerdict => ({
  access,
  basis: 'history',
  at: 1,
  attempts: 3,
});

function candidate(
  acquisition: Acquisition,
  code: string | null,
  more: Partial<Pick<CandidateWork, 'itemId' | 'relevance' | 'digestCode'>> = {},
): CandidateWork {
  return { acquisition, code, itemId: null, relevance: null, digestCode: null, ...more };
}

describe('抓之前的預期：依你的紀錄（R8）', () => {
  it('紀錄說要登入、會出驗證頁 —— 不去試，直接要你拿', () => {
    expect(accessPlan(recorded('login'), false)).toEqual({ expected: 'login', skip: true });
    expect(accessPlan(recorded('challenged'), false)).toEqual({ expected: 'blocked', skip: true });
  });

  it('robots 不准、要跑 JavaScript：預期抓不到，**但照樣試**（robots 會改、每一頁不一樣）', () => {
    expect(accessPlan(recorded('disallowed'), false)).toEqual({ expected: 'blocked', skip: false });
    expect(accessPlan(recorded('js-only'), false)).toEqual({ expected: 'blocked', skip: false });
  });

  it('連不到、被限流是暫時的 —— 照樣試', () => {
    expect(accessPlan(recorded('unreachable'), false).skip).toBe(false);
    expect(accessPlan(recorded('throttled'), false).skip).toBe(false);
  });

  it('**只有「一般而言要登入」的話照樣試** —— 你可能有機構授權，而那一次會變成紀錄', () => {
    expect(accessPlan(null, true)).toEqual({ expected: 'login', skip: false });
    const none: SiteVerdict = { access: 'unknown', basis: 'none', at: null, attempts: 0 };
    expect(accessPlan(none, false)).toEqual({ expected: 'unknown', skip: false });
  });

  it('探針也算你的紀錄（來源網站那一頁按過「檢查」）', () => {
    const probed: SiteVerdict = { access: 'login', basis: 'probe', at: 1, attempts: 0 };
    expect(accessPlan(probed, false).skip).toBe(true);
  });
});

describe('還有什麼可以做（R13：已抓的不重抓）', () => {
  it('沒搜的、搜失敗的要再搜；搜過而找到 0 份的不算；沒採用的不搜', () => {
    const work = collectWork(
      [
        { adopted: true, searchState: 'pending' },
        { adopted: true, searchState: 'failed' },
        { adopted: true, searchState: 'done' },
        { adopted: false, searchState: 'pending' },
      ],
      [],
    );
    expect(work).toEqual({ searches: 2, fetches: 0, digests: 0 });
  });

  it('還沒抓的、停在半路的、被限流的要再抓；其餘交給人', () => {
    const rows: CandidateWork[] = [
      candidate('found', null),
      candidate('fetching', null),
      candidate('needs-user', 'FETCH_RATE_LIMITED'),
      candidate('needs-user', 'FETCH_LOGIN_REQUIRED'),
      candidate('needs-user', null),
      candidate('fetched', null, { itemId: 'i1', relevance: 'yes' }),
      candidate('uploaded', null, { itemId: 'i2', relevance: 'no' }),
      candidate('unavailable', 'FETCH_HTTP_4XX'),
    ];
    expect(rows.filter(needsFetch)).toHaveLength(3);
    expect(collectWork([], rows)).toEqual({ searches: 0, fetches: 3, digests: 0 });
  });

  it('初讀：拿到的、還沒讀或讀失敗的要讀；讀好的不重讀；沒有正文可讀的不再讀（Stage 21）', () => {
    const rows: CandidateWork[] = [
      candidate('fetched', null, { itemId: 'a' }),
      candidate('uploaded', null, { itemId: 'b' }),
      candidate('fetched', null, { itemId: 'c', digestCode: 'PROVIDER_OUTPUT_SCHEMA_MISMATCH' }),
      candidate('fetched', null, { itemId: 'd', digestCode: 'PROVIDER_BUDGET_EXCEEDED' }),
      // 讀好的 —— 不管判斷是哪一種都不重讀
      candidate('fetched', null, { itemId: 'e', relevance: 'unsure' }),
      // 沒有正文可讀：再讀一次也一樣。不排除的話「繼續蒐集」那顆鈕永遠亮著
      candidate('fetched', null, { itemId: 'f', digestCode: 'PARSE_EMPTY_CONTENT' }),
      // 還沒拿到的沒有東西可讀
      candidate('found', null),
      candidate('needs-user', 'FETCH_LOGIN_REQUIRED'),
      // 拿到了卻沒有那一份資料（被刪掉了）
      candidate('fetched', null, { itemId: null }),
    ];
    expect(rows.filter(needsDigest).map((r) => r.itemId)).toEqual(['a', 'b', 'c', 'd']);
    expect(collectWork([], rows).digests).toBe(4);
  });

  it('被限流、金鑰被拒、連不上：這一筆不再讀下去（其餘的讀失敗照樣往下讀）', () => {
    expect(stopsDigesting('PROVIDER_RATE_LIMITED')).toBe(true);
    expect(stopsDigesting('PROVIDER_AUTH_REJECTED')).toBe(true);
    expect(stopsDigesting('PROVIDER_UNREACHABLE')).toBe(true);
    expect(stopsDigesting('PROVIDER_OUTPUT_SCHEMA_MISMATCH')).toBe(false);
    expect(stopsDigesting(null)).toBe(false);
  });
});

describe('現在可以按哪幾顆', () => {
  it('繼續蒐集：沒有作業在跑、而且還有事可以做', () => {
    const some = { searches: 1, fetches: 0, digests: 0 };
    const none = { searches: 0, fetches: 0, digests: 0 };
    // 只剩初讀也算「還有事可以做」（Stage 21）
    expect(mayResumeCollecting('awaiting-user', false, { ...none, digests: 2 })).toBe(true);
    expect(mayResumeCollecting('collecting', false, some)).toBe(true);
    expect(mayResumeCollecting('awaiting-user', false, some)).toBe(true);
    expect(mayResumeCollecting('collecting', true, some)).toBe(false);
    expect(mayResumeCollecting('awaiting-user', false, none)).toBe(false);
    expect(mayResumeCollecting('reviewing', false, some)).toBe(false);
    expect(mayResumeCollecting('planning', false, some)).toBe(false);
  });

  it('閘門二：沒有作業在跑就按得下去 —— 停在半路的也可以直接完成', () => {
    expect(mayFinishCollecting('awaiting-user', false)).toBe(true);
    expect(mayFinishCollecting('collecting', false)).toBe(true);
    expect(mayFinishCollecting('collecting', true)).toBe(false);
    expect(mayFinishCollecting('reviewing', false)).toBe(false);
  });

  it('上傳：還沒拿到的都可以；**作業活著的時候，還沒抓的那幾列不行**（它隨時會被拿去抓）', () => {
    expect(mayActOnCandidate('upload', 'awaiting-user', 'needs-user', false)).toBe(true);
    expect(mayActOnCandidate('upload', 'collecting', 'needs-user', true)).toBe(true);
    expect(mayActOnCandidate('upload', 'awaiting-user', 'unavailable', false)).toBe(true);
    expect(mayActOnCandidate('upload', 'awaiting-user', 'found', false)).toBe(true);
    expect(mayActOnCandidate('upload', 'collecting', 'found', true)).toBe(false);
    expect(mayActOnCandidate('upload', 'collecting', 'fetching', true)).toBe(false);
    // 已經有一份資料了 —— 換掉它是確認那一步的事。
    expect(mayActOnCandidate('upload', 'awaiting-user', 'fetched', false)).toBe(false);
    expect(mayActOnCandidate('upload', 'awaiting-user', 'uploaded', false)).toBe(false);
  });

  it('閘門二之後、規劃中，一律不行', () => {
    for (const status of ['planning', 'reviewing', 'building', 'done', 'abandoned'] as const) {
      expect(mayActOnCandidate('upload', status, 'needs-user', false)).toBe(false);
      expect(mayActOnCandidate('unavailable', status, 'needs-user', false)).toBe(false);
      expect(mayActOnCandidate('reopen', status, 'unavailable', false)).toBe(false);
    }
  });

  it('標拿不到只給還沒拿到的；改回要你拿只給拿不到的', () => {
    expect(mayActOnCandidate('unavailable', 'awaiting-user', 'needs-user', false)).toBe(true);
    expect(mayActOnCandidate('unavailable', 'awaiting-user', 'unavailable', false)).toBe(false);
    expect(mayActOnCandidate('unavailable', 'awaiting-user', 'fetched', false)).toBe(false);
    expect(mayActOnCandidate('reopen', 'awaiting-user', 'unavailable', false)).toBe(true);
    expect(mayActOnCandidate('reopen', 'awaiting-user', 'needs-user', false)).toBe(false);
  });
});

describe('研究停在哪', () => {
  it('**關掉程式時一起停的留在蒐集中**；其餘（含你按的取消）都是輪到你（D3）', () => {
    expect(statusAfterCollectRun('shutdown')).toBe('collecting');
    expect(statusAfterCollectRun('stale')).toBe('collecting');
    expect(statusAfterCollectRun(null)).toBe('awaiting-user');
  });

  it('主線、兩條岔路、放棄；其餘不行', () => {
    expect(mayMove('collecting', 'awaiting-user')).toBe(true);
    expect(mayMove('awaiting-user', 'reviewing')).toBe(true);
    expect(mayMove('awaiting-user', 'collecting')).toBe(true);
    expect(mayMove('collecting', 'reviewing')).toBe(true);
    expect(mayMove('reviewing', 'abandoned')).toBe(true);
    expect(mayMove('planning', 'reviewing')).toBe(false);
    expect(mayMove('reviewing', 'collecting')).toBe(false);
    expect(mayMove('done', 'abandoned')).toBe(false);
  });
});

describe('每條方向用數的（D10）', () => {
  it('別的方向也找到的算進「找到」；取得狀態各歸各的', () => {
    const rows = [
      { directionIds: ['d1'], acquisition: 'fetched' as const },
      { directionIds: ['d2', 'd1'], acquisition: 'uploaded' as const },
      { directionIds: ['d1'], acquisition: 'needs-user' as const },
      { directionIds: ['d1'], acquisition: 'unavailable' as const },
      { directionIds: ['d1'], acquisition: 'fetching' as const },
      { directionIds: ['d2'], acquisition: 'found' as const },
    ];
    expect(tallyDirection('d1', rows)).toEqual({
      found: 5,
      acquired: 2,
      needsUser: 1,
      unavailable: 1,
      pending: 1,
    });
    expect(tallyDirection('d2', rows)).toEqual({
      found: 2,
      acquired: 1,
      needsUser: 0,
      unavailable: 0,
      pending: 1,
    });
  });
});

describe('候選的正規化：模型輸出是外部輸入', () => {
  it('不是 http(s) 的丟掉、重複的丟掉；書目欄位收成 bib', () => {
    const out = normalizeResearchCandidates([
      {
        url: 'https://a.example/1',
        title: '  一篇 論文 ',
        why: '理由',
        authors: '甲',
        year: '2024',
        venue: '期刊',
      },
      { url: 'javascript:alert(1)', title: '壞的' },
      { url: 'https://a.example/1', title: '重複的' },
      null,
      'not an object',
      { url: 'http://b.example/2' },
    ]);
    expect(out.overflow).toBe(false);
    expect(out.candidates).toEqual([
      {
        url: 'https://a.example/1',
        title: '一篇 論文',
        why: '理由',
        bib: { authors: '甲', year: '2024', venue: '期刊' },
      },
      { url: 'http://b.example/2', title: '', why: '', bib: { authors: '', year: '', venue: '' } },
    ]);
  });

  it('年份只收像年份的四位數 —— 範圍、縮寫、「近年」不替它選一個', () => {
    const years = ['2024', '(2024)', '2024 年', '2024年', '近年', '2024–2025', '24', '3024', 2024];
    const got = years.map(
      (year) =>
        normalizeResearchCandidates([{ url: 'https://x.example/', year }]).candidates[0]?.bib.year,
    );
    expect(got).toEqual(['2024', '2024', '2024', '2024', '', '', '', '', '']);
  });

  it('超過上限要說 —— **只有多出來的是真的網址才算**（同 `normalizePlan`）', () => {
    const many = Array.from({ length: MAX_CANDIDATES_PER_DIRECTION + 2 }, (_, i) => ({
      url: `https://x.example/${String(i)}`,
    }));
    const over = normalizeResearchCandidates(many);
    expect(over.candidates).toHaveLength(MAX_CANDIDATES_PER_DIRECTION);
    expect(over.overflow).toBe(true);

    const padded = normalizeResearchCandidates([
      ...many.slice(0, MAX_CANDIDATES_PER_DIRECTION),
      {},
      { url: 'not a url' },
      { url: many[0]?.url },
    ]);
    expect(padded.overflow).toBe(false);
  });

  it('垃圾進來回空的，不丟例外', () => {
    expect(normalizeResearchCandidates(undefined)).toEqual({ candidates: [], overflow: false });
    expect(normalizeResearchCandidates({ candidates: [] })).toEqual({
      candidates: [],
      overflow: false,
    });
  });
});
