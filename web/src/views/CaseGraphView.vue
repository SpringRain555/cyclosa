<script setup lang="ts">
/**
 * 關聯圖 —— **這一頁是主畫面**（`ui-workflows.md`）。
 *
 * 三件事，順序就是重要性：
 * 看到累積起來的東西長什麼樣 → 找到某個東西附近有什麼 → 把選出來的一塊帶走。
 *
 * 這一版做得到前兩件。**第三件（匯出證據包）不在工具列上** ——
 * 一個點了沒反應的按鈕比少一個按鈕更糟，那是 Stage 11。
 *
 * ## 焦點跳數不是一個下拉選單
 *
 * 每一格直接顯示**會帶進來幾個節點**，數字即時算、超預算的標琥珀色。
 * 「把跳數變成節點預算，那個常數就不再是拍出來的」（`api-contract.md`）。
 */
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { EdgeLayer } from '../api';
import { fill, t } from '../i18n/zh-TW';
import { useGraphStore } from '../stores/graph-store';
import ErrorPanel from '../components/ErrorPanel.vue';
import EdgePanel from '../components/graph/EdgePanel.vue';
import GraphLegend from '../components/graph/GraphLegend.vue';
import GraphView from '../components/graph/GraphView.vue';
import SelectionPanel from '../components/graph/SelectionPanel.vue';

const route = useRoute();
const router = useRouter();
const store = useGraphStore();

const slug = computed(() => String(route.params['slug'] ?? ''));

const hopChoices = [1, 2, 3];

/**
 * **整個專題一條關聯都沒有** —— 說出來，否則一團沒有線的點看起來像壞掉。
 *
 * 判準是**專題**的關聯總數，不是這一屏的。第一次驗收時寫成後者，
 * 結果一個有十條關聯的專題、只因為焦點落在孤立節點上，
 * 就顯示了一句「這個專題還沒有任何關聯」—— **那句話當場是錯的**。
 */
const hasNoEdges = computed(() => store.subgraph !== null && store.subgraph.totalEdgeCount === 0);

function countFor(hop: number): number | null {
  const value = store.hopCounts[String(hop)];
  return typeof value === 'number' ? value : null;
}

function isOverBudget(hop: number): boolean {
  return store.overBudget.includes(String(hop));
}

watch(
  slug,
  (next) => {
    if (next.length > 0) void store.open(next);
  },
  { immediate: true },
);

// 篩選一動就重查 —— **前端手上只有一屏，它沒有資料可以自己重算**
watch(
  () => [store.projection, store.minTier, store.showRejected],
  () => void store.reload(),
);

function openInReader(itemId: string): void {
  void router.push(`/case/${encodeURIComponent(slug.value)}/reader/${encodeURIComponent(itemId)}`);
}

function openExpand(): void {
  void router.push(`/case/${encodeURIComponent(slug.value)}/runs`);
}

function createEdge(payload: { target: string; rel: string; layer: EdgeLayer }): void {
  void store.createEdge(payload.target, payload.rel, payload.layer);
}
</script>

<template>
  <div class="page">
    <div v-if="store.error !== null" class="centered">
      <ErrorPanel :error="store.error" retryable @retry="store.reload()" />
    </div>

    <p v-else-if="store.empty" class="centered hint">{{ t.graph.empty }}</p>

    <template v-else>
      <div class="toolbar">
        <span class="label">{{ t.graph.toolbar.hops }}</span>
        <div class="hops">
          <button
            v-for="hop in hopChoices"
            :key="hop"
            type="button"
            :class="{ on: store.hops === hop, over: isOverBudget(hop) }"
            :title="
              isOverBudget(hop) ? fill(t.graph.toolbar.overBudget, { budget: store.budget }) : ''
            "
            @click="store.setHops(hop)"
          >
            <span class="n">{{ fill(t.graph.toolbar.hopUnit, { n: hop }) }}</span>
            <span class="count mono">{{ countFor(hop) ?? '—' }}</span>
          </button>
        </div>

        <button type="button" :class="{ on: store.flat }" @click="store.flat = !store.flat">
          {{ store.flat ? t.graph.toolbar.solid : t.graph.toolbar.flat }}
        </button>

        <button type="button" @click="store.reload()">{{ t.graph.toolbar.relayout }}</button>

        <!--
          擴展的入口在這裡（設計稿把它放在關聯圖的工具列上），
          **而它按下去是跳到作業紀錄** —— 擴展產生的是一個 run，
          而 run 的畫面就是那一頁。在這裡再開一個對話框，
          等於同一件事有兩個入口與兩份狀態。
        -->
        <button type="button" @click="openExpand">{{ t.expand.open }}</button>

        <!--
          裁決佇列**沒有自己的畫面** —— 頂列只有三個分頁（ui-workflows），
          而多開一個分頁只為了顯示一個數字並不划算。
          它在這裡：數字 ＋ 一個「跳到下一條」。
        -->
        <span v-if="store.pendingCount > 0" class="queue">
          <span class="pending">{{ fill(t.graph.queue.pending, { n: store.pendingCount }) }}</span>
          <button type="button" @click="store.focusNextPending()">
            {{ t.graph.queue.next }}
          </button>
        </span>

        <span class="spacer"></span>

        <span v-if="store.loading" class="hint">{{ t.graph.loading }}</span>
        <span class="hint mono">
          {{
            fill(t.graph.toolbar.counts, {
              visible: store.subgraph?.visibleNodeCount ?? 0,
              total: store.totalNodeCount,
            })
          }}
        </span>
      </div>

      <p v-if="hasNoEdges" class="notice">{{ t.graph.noEdges }}</p>

      <!--
        裁決或建立關聯失敗。**一條，兩種情況共用。**
        各自放在自己的面板裡的話，建立失敗的訊息會落在一個
        當下沒有掛載的元件裡 —— 於是完全看不見。

        **它不會把整張圖換掉**（那是 `store.error` 的事）——
        按錯一個按鈕不該讓使用者失去正在看的東西。
      -->
      <div v-if="store.actionError !== null" class="action-error">
        <ErrorPanel :error="store.actionError" />
      </div>

      <div class="body">
        <GraphLegend
          v-model:projection="store.projection"
          v-model:min-tier="store.minTier"
          v-model:show-derived="store.showDerived"
          v-model:show-rejected="store.showRejected"
        />

        <div class="stage">
          <GraphView
            v-if="store.subgraph !== null"
            :nodes="store.nodes"
            :edges="store.edges"
            :focus-id="store.subgraph.focus"
            :selected-id="store.selectedId"
            :flat="store.flat"
            :show-derived="store.showDerived"
            :show-rejected="store.showRejected"
            @select="store.select($event)"
            @focus="store.setFocus($event)"
          />
        </div>

        <!--
          右側欄同時只顯示一個東西：**一個節點，或一條關聯。**
          兩個並排的話 296px 會塞不下引文，而引文正是裁決要看的東西。
        -->
        <EdgePanel
          v-if="store.selectedEdgeId !== null"
          :detail="store.edgeDetail"
          :loading="store.edgeLoading"
          @act="store.adjudicate(store.selectedEdgeId, $event)"
          @focus="store.setFocus($event)"
          @close="store.closeEdge()"
        />
        <SelectionPanel
          v-else
          :node="store.selected"
          :edges="store.selectedEdges"
          :nodes="store.nodes"
          :connect-from="store.connectFrom"
          @focus="store.setFocus($event)"
          @open-reader="openInReader"
          @open-edge="store.openEdge($event)"
          @start-connect="store.startConnect($event)"
          @cancel-connect="store.cancelConnect()"
          @create-edge="createEdge"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.centered {
  margin: 48px auto;
  max-width: 560px;
  padding: 0 16px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  padding: 8px 14px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--line-subtle);
  font-size: 12px;
}
.label {
  color: var(--text-tertiary);
}
.spacer {
  flex: 1;
}
.hops {
  display: flex;
  gap: 3px;
}
.hops button {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 3px 12px;
  line-height: 1.2;
}
.hops .n {
  font-size: 11px;
  color: var(--text-tertiary);
}
.hops .count {
  font-size: 13px;
  color: var(--text);
}
.hops button.on {
  border-color: var(--ui-action);
}
.hops button.on .n {
  color: var(--ui-action);
}
/* 超過預算標琥珀 —— **它是警示不是禁止**，仍然按得下去 */
.hops button.over .count {
  color: var(--edge-pending);
}
button.on {
  border-color: var(--ui-action);
  color: var(--ui-action);
}
.notice {
  flex-shrink: 0;
  margin: 0;
  padding: 7px 14px;
  background: var(--bg-raised);
  border-bottom: 1px solid var(--line-subtle);
  color: var(--text-tertiary);
  font-size: 12px;
}
.action-error {
  flex-shrink: 0;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line-subtle);
}
.queue {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 琥珀 ＝ 等你裁決（ADR-0018）。**那個顏色只有這一個意思** */
.pending {
  color: var(--edge-pending);
}
.body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.stage {
  flex: 1;
  min-width: 0;
  position: relative;
}
.hint {
  color: var(--text-muted);
}
</style>
