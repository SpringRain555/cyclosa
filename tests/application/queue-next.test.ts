/**
 * 「跳到下一條待查證」（2026-10-28 試用回饋 10）：原本永遠回到第一條，沒裁決之前沒辦法先跳過。
 */
import { expect, it } from 'vitest';

import { nextPendingIndex } from '../../web/src/stores/queue-next.js';

const ids = ['e1', 'e2', 'e3'];

it('第一次按：第一條', () => {
  expect(nextPendingIndex(ids, null, -1)).toBe(0);
});

it('開著的那一條還在佇列裡：跳到它的下一條', () => {
  expect(nextPendingIndex(ids, 'e1', 0)).toBe(1);
  expect(nextPendingIndex(ids, 'e2', 1)).toBe(2);
});

it('到尾巴繞回第一條', () => {
  expect(nextPendingIndex(ids, 'e3', 2)).toBe(0);
});

it('剛裁決掉（佇列裡沒有它了）：原本那個位置上的那一條，也就是排在它後面的', () => {
  // e2 裁決之前排第 1；重讀之後佇列是 [e1, e3]，該跳的是 e3
  expect(nextPendingIndex(['e1', 'e3'], 'e2', 1)).toBe(1);
  // 裁決掉的是最後一條：退到現在的最後一條
  expect(nextPendingIndex(['e1', 'e2'], 'e3', 2)).toBe(1);
});

it('佇列空了：沒有下一條', () => {
  expect(nextPendingIndex([], 'e1', 0)).toBeNull();
});

it('只剩一條而且就是它：還是它', () => {
  expect(nextPendingIndex(['e1'], 'e1', 0)).toBe(0);
});
