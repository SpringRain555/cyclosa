import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { api, type ApiError, type ConfidenceTier, type EdgeLayer, type Subgraph } from '../api';

/**
 * 關聯圖這一頁的狀態。
 *
 * **前端不快取整張圖、不自己算投影、不自己算獨立來源數**（`graph-view.md`）——
 * 那三件都在伺服器端算完傳過來。這裡存的只有「使用者現在在看哪一屏」。
 *
 * 每一次篩選變動都是一次新的查詢。**這不是效能問題而是正確性問題**：
 * 前端手上永遠只有一屏，它沒有資料可以自己重算。
 */
export const useGraphStore = defineStore('graph', () => {
  const slug = ref('');
  const focus = ref<string | null>(null);
  const hops = ref(2);
  const layers = ref<EdgeLayer[]>([]);
  const minTier = ref<ConfidenceTier | null>(null);
  /** 實體提到幾篇才成為節點。**顯示層的門檻，改它不需要 migration** */
  const projection = ref(3);

  const flat = ref(false);
  const showDerived = ref(false);
  const showRejected = ref(false);
  const selectedId = ref<string | null>(null);

  const subgraph = ref<Subgraph | null>(null);
  const hopCounts = ref<Record<string, number>>({});
  const overBudget = ref<string[]>([]);
  const budget = ref(2000);
  const totalNodeCount = ref(0);

  const loading = ref(false);
  const error = ref<ApiError | null>(null);
  /** 專題是空的 —— **這不是錯誤**，是還沒有東西 */
  const empty = ref(false);

  const nodes = computed(() => subgraph.value?.nodes ?? []);
  const edges = computed(() => subgraph.value?.edges ?? []);
  const selected = computed(() => nodes.value.find((n) => n.id === selectedId.value) ?? null);
  const selectedEdges = computed(() =>
    selectedId.value === null
      ? []
      : edges.value.filter((e) => e.source === selectedId.value || e.target === selectedId.value),
  );

  function query(): Record<string, string> {
    const out: Record<string, string> = {
      hops: String(hops.value),
      projection: String(projection.value),
    };
    if (focus.value !== null) out['focus'] = focus.value;
    if (layers.value.length > 0) out['layers'] = layers.value.join(',');
    if (minTier.value !== null) out['minConfidence'] = minTier.value;
    // 已否決預設不查回來 —— 圖例打開它才要
    if (showRejected.value) out['status'] = 'pending,confirmed,rejected';
    return out;
  }

  async function open(next: string): Promise<void> {
    if (slug.value === next && subgraph.value !== null) return;
    slug.value = next;
    subgraph.value = null;
    selectedId.value = null;
    error.value = null;
    empty.value = false;

    const start = await api.subgraphFocus(next);
    if (!start.ok) {
      error.value = start.error;
      return;
    }
    totalNodeCount.value = start.data.totalNodeCount;
    if (start.data.focus === null) {
      empty.value = true;
      return;
    }
    focus.value = start.data.focus;
    await reload();
  }

  async function reload(): Promise<void> {
    if (slug.value.length === 0 || focus.value === null) return;
    loading.value = true;
    error.value = null;
    const [view, sizes] = await Promise.all([
      api.subgraph(slug.value, query()),
      api.subgraphSize(slug.value, query()),
    ]);
    loading.value = false;

    if (!view.ok) {
      error.value = view.error;
      subgraph.value = null;
      return;
    }
    subgraph.value = view.data;
    totalNodeCount.value = view.data.totalNodeCount;
    budget.value = view.data.budget;

    if (sizes.ok) {
      hopCounts.value = sizes.data.counts;
      overBudget.value = sizes.data.overBudget;
    }
  }

  async function setFocus(id: string): Promise<void> {
    if (focus.value === id) return;
    focus.value = id;
    await reload();
  }

  async function setHops(value: number): Promise<void> {
    if (hops.value === value) return;
    hops.value = value;
    await reload();
  }

  function select(id: string | null): void {
    selectedId.value = id;
  }

  return {
    slug,
    focus,
    hops,
    layers,
    minTier,
    projection,
    flat,
    showDerived,
    showRejected,
    selectedId,
    subgraph,
    nodes,
    edges,
    selected,
    selectedEdges,
    hopCounts,
    overBudget,
    budget,
    totalNodeCount,
    loading,
    error,
    empty,
    open,
    reload,
    setFocus,
    setHops,
    select,
  };
});
