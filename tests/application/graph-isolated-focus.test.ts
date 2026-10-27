/**
 * 圖上只剩焦點時的說明（`isolatedFocusAction`，2026-10-25）。
 *
 * 實跑看到的：研究建完 266 個節點，打開關聯圖只畫出焦點一個點，而畫面沒有任何一句話說為什麼。
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGraphStore } from '../../web/src/stores/graph-store.js';

let defaultFocus = 'itm-a';
let visibleNodeCount = 1;
let totalEdgeCount = 3;

vi.mock('../../web/src/api.js', () => ({
  api: {
    subgraphFocus: vi.fn(async () => ({
      ok: true,
      data: { focus: defaultFocus, totalNodeCount: 5 },
    })),
    subgraph: vi.fn(async (_slug: string, query: Record<string, string>) => ({
      ok: true,
      data: {
        focus: query['focus'],
        hops: 2,
        nodes: [{ id: query['focus'], kind: 'item', title: '合成資料' }],
        edges: [],
        visibleNodeCount,
        totalNodeCount: 5,
        totalEdgeCount,
        budget: 2000,
        overBudget: false,
        thresholds: { minToDraw: 2, minToExpand: 3 },
      },
    })),
    subgraphSize: vi.fn(async () => ({
      ok: true,
      data: { counts: {}, budget: 2000, overBudget: [], capped: [] },
    })),
    queue: vi.fn(async () => ({ ok: true, data: { total: 0, items: [] } })),
  },
}));

beforeEach(() => {
  setActivePinia(createPinia());
  defaultFocus = 'itm-a';
  visibleNodeCount = 1;
  totalEdgeCount = 3;
});

it('預設焦點畫不出鄰居 → 沒有別的預設可回，按鈕打開搜尋', async () => {
  const store = useGraphStore();
  await store.open('synthetic');
  expect(store.focusQuery).toBeNull();
  expect(store.isolatedFocusAction).toBe('open-search');
});

it('使用者自己選的焦點畫不出鄰居 → 按鈕回到伺服器挑的預設焦點', async () => {
  const store = useGraphStore();
  await store.open('synthetic', 'itm-b');
  expect(store.focusQuery).toBe('itm-b');
  expect(store.isolatedFocusAction).toBe('change-focus');
  await store.resetFocus();
  expect(store.focusQuery).toBeNull();
  expect(store.focus).toBe('itm-a');
});

it('有鄰居 → 不說', async () => {
  visibleNodeCount = 4;
  const store = useGraphStore();
  await store.open('synthetic');
  expect(store.isolatedFocusAction).toBe('none');
});

it('整個專題一條關聯都沒有 → 不說（那一句另外有，兩句會疊在一起）', async () => {
  totalEdgeCount = 0;
  const store = useGraphStore();
  await store.open('synthetic');
  expect(store.isolatedFocusAction).toBe('none');
});
