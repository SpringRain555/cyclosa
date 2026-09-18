import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
  api,
  type ApiError,
  type ConfidenceTier,
  type EdgeAction,
  type EdgeDetail,
  type EdgeLayer,
  type QueuePayload,
  type Subgraph,
} from '../api';

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
  /**
   * 焦點是誰定的。**回到這一頁的時候，只有使用者自己選的焦點值得保留。**
   *
   * 2026-09-18 真的踩到：使用者先開圖（只有一份 PDF，焦點就是它），去跑了一次擴展，
   * 回來 —— 圖還是那一個點。兩層原因疊在一起：這裡因為「同一個專題」就用快取不重查，
   * 而焦點還停在那份 0 條邊的 PDF。所以現在 `open()` 一律重查；
   * 預設算出來的焦點也重算，使用者選過的才留著。
   */
  const focusSource = ref<'default' | 'user'>('default');
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
  /** 數字是下界的那幾格（走訪在硬上限停了）*/
  const capped = ref<string[]>([]);
  const budget = ref(2000);
  const totalNodeCount = ref(0);

  const loading = ref(false);
  const error = ref<ApiError | null>(null);
  /** 專題是空的 —— **這不是錯誤**，是還沒有東西 */
  const empty = ref(false);

  // ── 裁決────────────────────────────────────────

  /** 選取的那一條關聯。**節點與關聯不會同時被選取** —— 右側欄只有一個 */
  const selectedEdgeId = ref<string | null>(null);
  const edgeDetail = ref<EdgeDetail | null>(null);
  const edgeLoading = ref(false);

  /**
   * 裁決失敗要顯示在**面板裡**，不是把整頁換成錯誤畫面。
   *
   * 用 `error` 的話，按錯一個按鈕就會讓整張圖消失，
   * 而使用者其實只是想知道「為什麼這個按鈕沒用」。
   */
  const actionError = ref<ApiError | null>(null);

  const queue = ref<QueuePayload | null>(null);
  const pendingCount = computed(() => queue.value?.total ?? 0);

  /**
   * 正在拉一條線：起點是哪個節點。
   * **不是 null 就代表下一次點節點是在選終點**，而畫面要說出這件事。
   */
  const connectFrom = ref<string | null>(null);

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

  /**
   * 開（或回到）一個專題的圖。
   *
   * `wanted` 是網址帶來的焦點（作業紀錄那頁「在關聯圖上看這一次抓到的」）；
   * 它算使用者選的。指到一個已經不存在的節點時退回預設焦點，不讓整頁卡在錯誤上。
   */
  async function open(next: string, wanted: string | null = null): Promise<void> {
    const sameCase = slug.value === next;
    slug.value = next;
    error.value = null;
    empty.value = false;
    if (!sameCase) {
      subgraph.value = null;
      selectedId.value = null;
      focus.value = null;
      focusSource.value = 'default';
    }

    if (wanted !== null) {
      focus.value = wanted;
      focusSource.value = 'user';
    } else if (!(sameCase && focusSource.value === 'user' && focus.value !== null)) {
      const start = await api.subgraphFocus(next);
      if (!start.ok) {
        error.value = start.error;
        return;
      }
      totalNodeCount.value = start.data.totalNodeCount;
      if (start.data.focus === null) {
        empty.value = true;
        subgraph.value = null;
        return;
      }
      focus.value = start.data.focus;
      focusSource.value = 'default';
    }
    await Promise.all([reload(), loadQueue()]);

    if (wanted !== null && lastErrorCode() === 'GRAPH_NODE_NOT_FOUND') {
      focusSource.value = 'default';
      await open(next, null);
    }
  }

  /** `reload()` 會改 `error`，而 `open()` 裡那句 `error.value = null` 讓 TS 以為它還是 null —— 繞過去。 */
  function lastErrorCode(): string | null {
    return error.value?.code ?? null;
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
      capped.value = sizes.data.capped;
    }
  }

  async function setFocus(id: string): Promise<void> {
    if (focus.value === id) return;
    focus.value = id;
    focusSource.value = 'user';
    await reload();
  }

  async function setHops(value: number): Promise<void> {
    if (hops.value === value) return;
    hops.value = value;
    await reload();
  }

  function select(id: string | null): void {
    selectedId.value = id;
    // 選了節點就不再是在看某一條關聯 —— 右側欄同時只顯示一個東西
    selectedEdgeId.value = null;
    edgeDetail.value = null;
    actionError.value = null;
  }

  // ── 裁決 ──────────────────────────────────────────────────

  async function loadQueue(): Promise<void> {
    if (slug.value.length === 0) return;
    const r = await api.queue(slug.value);
    if (r.ok) queue.value = r.data;
  }

  /**
   * 打開一條關聯的細節。
   *
   * **投影出來的線（`proj:` 開頭）沒有東西可以打開** —— 它不是資料庫裡的一列。
   * 在這裡先擋掉，而不是送出去等 404：那條請求注定失敗，
   * 而使用者要的答案（「這條線是投影出來的」）畫面上已經寫著了。
   */
  async function openEdge(edgeId: string): Promise<void> {
    if (edgeId.startsWith('proj:')) return;
    selectedEdgeId.value = edgeId;
    actionError.value = null;
    edgeLoading.value = true;
    const r = await api.edge(slug.value, edgeId);
    edgeLoading.value = false;
    if (r.ok) edgeDetail.value = r.data;
    else {
      edgeDetail.value = null;
      actionError.value = r.error;
    }
  }

  function closeEdge(): void {
    selectedEdgeId.value = null;
    edgeDetail.value = null;
    actionError.value = null;
  }

  /**
   * 一次裁決。成功之後**要重畫圖** —— 狀態變了，線的顏色與虛實就變了。
   *
   * 重畫的是整一屏而不是那一條線：前端手上沒有資料可以自己重算
   * （獨立來源數、可信度等級、校準比例全部在伺服器端算）。
   */
  async function adjudicate(edgeId: string, action: EdgeAction): Promise<void> {
    actionError.value = null;
    const r = await api.transitionEdge(slug.value, edgeId, action);
    if (!r.ok) {
      actionError.value = r.error;
      return;
    }
    edgeDetail.value = r.data;
    await Promise.all([reload(), loadQueue()]);
  }

  function startConnect(from: string): void {
    connectFrom.value = from;
    actionError.value = null;
  }

  function cancelConnect(): void {
    connectFrom.value = null;
  }

  /** 手動建立一條關聯。**一建立就是「已確認」＋ `origin=human`。** */
  async function createEdge(target: string, rel: string, layer: EdgeLayer): Promise<boolean> {
    const from = connectFrom.value;
    if (from === null) return false;
    actionError.value = null;

    const r = await api.createEdge(slug.value, { source: from, target, rel, layer });
    if (!r.ok) {
      actionError.value = r.error;
      return false;
    }
    connectFrom.value = null;
    edgeDetail.value = r.data;
    selectedEdgeId.value = r.data.id;
    await Promise.all([reload(), loadQueue()]);
    return true;
  }

  /** 跳到佇列裡的下一條：把焦點移到它的來源，並打開它。 */
  async function focusNextPending(): Promise<void> {
    const next = queue.value?.entries[0];
    if (next === undefined) return;
    selectedId.value = next.source;
    await setFocus(next.source);
    await openEdge(next.id);
  }

  return {
    slug,
    focus,
    focusSource,
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
    capped,
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
    // 匯出要送出跟這一次查詢**一模一樣**的參數——
    // 換一組就等於換了一塊，而那時匯出的東西跟畫面上的對不起來。
    query,

    // 裁決
    selectedEdgeId,
    edgeDetail,
    edgeLoading,
    actionError,
    queue,
    pendingCount,
    connectFrom,
    loadQueue,
    openEdge,
    closeEdge,
    adjudicate,
    startConnect,
    cancelConnect,
    createEdge,
    focusNextPending,
  };
});
