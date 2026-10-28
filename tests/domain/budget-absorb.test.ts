/**
 * 兩段同時跑時的花費累計（2026-10-28，蒐集改成邊搜邊抓）：呼叫完把「這一次」加在最新的累計上，
 * 不是拿呼叫前的快照蓋回去。
 */
import { expect, it } from 'vitest';

import {
  absorbBudget,
  absorbTaskCosts,
  charge,
  chargeTask,
  EMPTY_BUDGET_STATE,
  EMPTY_TASK_COSTS,
} from '../../src/domain/provider/budget.js';

it('兩段各拿同一份快照呼叫一次：兩次都算進去，不是後來的蓋掉先來的', () => {
  const snapshot = EMPTY_BUDGET_STATE;
  const search = charge(snapshot, 0.05, 1000); // 搜尋那一段：回報 0.05
  const digest = charge(snapshot, null, 1200); // 初讀那一段：本機，沒回報

  let acc = snapshot;
  acc = absorbBudget(acc, snapshot, search, 1000);
  acc = absorbBudget(acc, snapshot, digest, 1200);
  expect(acc).toEqual({ requests: 2, costUsd: 0.05, unpriced: 1, elapsedMs: 1200 });
});

it('沒回報金額的那一次不把 null 變成 0', () => {
  const acc = absorbBudget(
    EMPTY_BUDGET_STATE,
    EMPTY_BUDGET_STATE,
    charge(EMPTY_BUDGET_STATE, null, 5),
    5,
  );
  expect(acc.costUsd).toBeNull();
  expect(acc.unpriced).toBe(1);
});

it('逐任務那一份也一樣', () => {
  const snapshot = EMPTY_TASK_COSTS;
  const search = chargeTask(snapshot, 'find-sources', 0.05);
  const digest = chargeTask(snapshot, 'digest', null);
  let acc = absorbTaskCosts(snapshot, snapshot, search);
  acc = absorbTaskCosts(acc, snapshot, digest);
  expect(acc).toEqual({
    'find-sources': { requests: 1, costUsd: 0.05, unpriced: 0 },
    digest: { requests: 1, costUsd: null, unpriced: 1 },
  });
  // 同一個任務兩段各加一次
  const again = absorbTaskCosts(acc, snapshot, search);
  expect(again['find-sources']).toEqual({ requests: 2, costUsd: 0.1, unpriced: 0 });
});
