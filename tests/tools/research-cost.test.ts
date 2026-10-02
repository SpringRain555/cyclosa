import { expect, it } from 'vitest';
import { costBreakdown } from '../../web/src/research-cost.js';

it('逐任務列出規劃與缺口評估、找來源、初讀、抽取，不把沒回報寫成零', () => {
  expect(
    costBreakdown({
      extract: { requests: 1, costUsd: null, unpriced: 1 },
      digest: { requests: 1, costUsd: 0, unpriced: 0 },
      plan: { requests: 2, costUsd: 0.03, unpriced: 0 },
      'find-sources': { requests: 1, costUsd: 0.1, unpriced: 0 },
    }),
  ).toBe('（規劃與缺口評估 0.03、找來源 0.10、初讀 0.00、抽取 不知道）');
});

it('只有一個任務也要列，不隱藏「不知道」', () => {
  expect(costBreakdown({ digest: { requests: 1, costUsd: null, unpriced: 1 } })).toBe(
    '（初讀 不知道）',
  );
});

it('部分回報則列已知金額與這個任務的未知次數', () => {
  expect(
    costBreakdown({
      plan: { requests: 3, costUsd: 0.02, unpriced: 2 },
      digest: { requests: 2, costUsd: 0, unpriced: 1 },
    }),
  ).toBe(
    '（規劃與缺口評估 0.02、規劃與缺口評估 有 2 次花費不知道、初讀 0.00、初讀 有 1 次花費不知道）',
  );
});

it('沒跑過的不列，實際回報零元仍列零元', () => {
  expect(costBreakdown({})).toBe('');
  expect(costBreakdown({ plan: { requests: 0, costUsd: null, unpriced: 0 } })).toBe('');
  expect(costBreakdown({ extract: { requests: 1, costUsd: 0, unpriced: 0 } })).toBe(
    '（抽取 0.00）',
  );
});
