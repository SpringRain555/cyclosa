import { beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useGraphStore } from '../../web/src/stores/graph-store.js';
import { api } from '../../web/src/api.js';

vi.mock('../../web/src/api.js', () => ({
  api: {
    subgraph: vi.fn(async (_slug: string, query: Record<string, string>) => ({
      ok: true,
      data: {
        focus: query['focus'],
        nodes: [{ id: query['focus'], kind: 'entity', title: '合成實體甲' }],
        edges: [],
        totalNodeCount: 1,
        budget: 2000,
      },
    })),
    subgraphSize: vi.fn(async () => ({
      ok: true,
      data: { counts: {}, overBudget: [], capped: [] },
    })),
  },
}));
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});
it('搜尋孤立實體時載入焦點子圖並打開所選實體面板，不修改投影門檻', async () => {
  const store = useGraphStore();
  store.slug = 'synthetic';
  await store.focusAndSelect('isolated');
  expect(api.subgraph).toHaveBeenCalledWith(
    'synthetic',
    expect.objectContaining({ focus: 'isolated', projection: '3' }),
  );
  expect(store.selected).toMatchObject({ id: 'isolated', kind: 'entity' });
  store.select(null);
  await store.focusAndSelect('isolated');
  expect(store.selectedId).toBe('isolated');
  expect(api.subgraph).toHaveBeenCalledTimes(1);
});
