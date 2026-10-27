import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope, nextTick, type EffectScope } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api } from '../../web/src/api.js';
import { useGraphStore } from '../../web/src/stores/graph-store.js';
import { useGraphFocusRoute } from '../../web/src/graph-focus-route.js';

vi.mock('../../web/src/api.js', () => ({
  api: {
    subgraphFocus: vi.fn(async () => ({ ok: true, data: { focus: 'default', totalNodeCount: 5 } })),
    subgraph: vi.fn(async (_slug: string, query: Record<string, string>) => ({
      ok: true,
      data: {
        focus: query['focus'],
        nodes: [{ id: query['focus'], kind: 'item' }],
        edges: [],
        totalNodeCount: 5,
      },
    })),
    subgraphSize: vi.fn(async () => ({
      ok: true,
      data: { counts: {}, overBudget: [], capped: [] },
    })),
    queue: vi.fn(async () => ({
      ok: true,
      data: { total: 1, entries: [{ id: 'pending-edge', source: 'pending-source' }] },
    })),
    edge: vi.fn(async () => ({ ok: true, data: { id: 'pending-edge' } })),
  },
}));

let scope: EffectScope;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});
afterEach(() => scope?.stop());

async function setup(query = '') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/case/:slug', component: {} },
      { path: '/other', component: {} },
    ],
  });
  await router.push('/other');
  await router.push(`/case/synthetic${query}`);
  const store = useGraphStore();
  scope = effectScope();
  scope.run(() => useGraphFocusRoute(store, router));
  await vi.waitFor(() => expect(api.subgraph).toHaveBeenCalledTimes(1));
  await nextTick();
  return { router, store };
}

it('預設焦點不寫網址；使用者換焦點只replace，不多載、不增加歷史', async () => {
  const { router, store } = await setup('?fps=1');
  expect(store.focusQuery).toBeNull();
  expect(router.currentRoute.value.query).toEqual({ fps: '1' });
  const replace = vi.spyOn(router, 'replace');
  await store.setFocus('node-b');
  await vi.waitFor(() =>
    expect(router.currentRoute.value.query).toEqual({ fps: '1', focus: 'node-b' }),
  );
  expect(replace).toHaveBeenCalledTimes(1);
  expect(api.subgraph).toHaveBeenCalledTimes(2);
  expect(api.subgraphFocus).toHaveBeenCalledTimes(1);
  await store.setFocus('node-b');
  await nextTick();
  expect(replace).toHaveBeenCalledTimes(1);
  expect(api.subgraph).toHaveBeenCalledTimes(2);
  router.back();
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/other'));
});

it('搜尋與下一條待查證都同步焦點，且不重設選取或重開舊edge', async () => {
  const { router, store } = await setup('?focus=from-run&edge=old-edge&fps=1');
  expect(api.edge).toHaveBeenCalledTimes(1);
  await store.focusAndSelect('search-result');
  await vi.waitFor(() =>
    expect(router.currentRoute.value.query).toEqual({ focus: 'search-result', fps: '1' }),
  );
  expect(store.selectedId).toBe('search-result');
  expect(api.subgraph).toHaveBeenCalledTimes(2);
  expect(api.edge).toHaveBeenCalledTimes(1);
  await store.focusNextPending();
  await vi.waitFor(() => expect(router.currentRoute.value.query['focus']).toBe('pending-source'));
  expect(store.selectedEdgeId).toBe('pending-edge');
  expect(api.subgraph).toHaveBeenCalledTimes(3);
  expect(api.edge).toHaveBeenCalledTimes(2);
});

it('外部網址換焦點只載一次，回預設時移除focus且不多載', async () => {
  const { router, store } = await setup('?focus=from-run');
  await router.replace({ query: { focus: 'external' } });
  await vi.waitFor(() => expect(store.subgraph?.focus).toBe('external'));
  expect(api.subgraph).toHaveBeenCalledTimes(2);
  await store.resetFocus();
  await vi.waitFor(() => expect(router.currentRoute.value.query['focus']).toBeUndefined());
  expect(store.focus).toBe('default');
  expect(store.focusQuery).toBeNull();
  expect(api.subgraph).toHaveBeenCalledTimes(3);
});

it('換專題即使focus相同仍重查，不沿用上一專題的畫面', async () => {
  const { router, store } = await setup('?focus=shared');
  await router.push('/case/another?focus=shared');
  await vi.waitFor(() => expect(store.slug).toBe('another'));
  await vi.waitFor(() => expect(api.subgraph).toHaveBeenCalledTimes(2));
  expect(api.subgraph).toHaveBeenLastCalledWith(
    'another',
    expect.objectContaining({ focus: 'shared' }),
  );
});

it('焦點仍在載入時寫回網址，也不會再送一次相同子圖請求', async () => {
  const { router, store } = await setup();
  const read = vi.mocked(api.subgraph);
  const original = read.getMockImplementation()!;
  let finish = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  read.mockImplementationOnce(async (...args) => {
    await gate;
    return original(...args);
  });
  const moving = store.setFocus('slow-focus');
  await vi.waitFor(() => expect(router.currentRoute.value.query['focus']).toBe('slow-focus'));
  expect(api.subgraph).toHaveBeenCalledTimes(2);
  finish();
  await moving;
  await nextTick();
  expect(api.subgraph).toHaveBeenCalledTimes(2);
});

it('離開再進同一頁仍重查，不把同焦點防重載誤當成跨頁快取', async () => {
  const { router, store } = await setup('?focus=kept');
  scope.stop();
  scope = effectScope();
  scope.run(() => useGraphFocusRoute(store, router));
  await vi.waitFor(() => expect(api.subgraph).toHaveBeenCalledTimes(2));
  expect(router.currentRoute.value.query['focus']).toBe('kept');
});
