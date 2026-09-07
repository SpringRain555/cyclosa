<script setup lang="ts">
/**
 * 左側欄：圖例與篩選。
 *
 * **圖例不是裝飾。** ADR-0018 的第二條規則是「每個狀態都有第二重編碼」，
 * 而這一欄就是那個編碼的說明書 —— 沒有它，虛線與打叉只是兩種奇怪的線。
 *
 * 排版順序照 `ui-workflows.md`：節點 → 實體 → 關聯 → 轉動中心。
 */
import { computed } from 'vue';

import type { ConfidenceTier } from '../../api';
import { t } from '../../i18n/zh-TW';

const props = defineProps<{
  projection: number;
  minTier: ConfidenceTier | null;
  showDerived: boolean;
  showRejected: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:projection', value: number): void;
  (event: 'update:minTier', value: ConfidenceTier | null): void;
  (event: 'update:showDerived', value: boolean): void;
  (event: 'update:showRejected', value: boolean): void;
}>();

const tiers: readonly (ConfidenceTier | null)[] = [null, 'weak', 'medium', 'strong'];

function tierLabel(tier: ConfidenceTier | null): string {
  return tier === null ? t.graph.legend.tierAny : t.graph.tier[tier];
}

const projectionValue = computed({
  get: () => props.projection,
  set: (value: number) => emit('update:projection', value),
});
</script>

<template>
  <aside class="legend">
    <h2>{{ t.graph.legend.title }}</h2>

    <section>
      <h3>{{ t.graph.legend.nodes }}</h3>
      <p class="row"><span class="swatch item"></span>{{ t.graph.legend.nodeItem }}</p>
      <p class="row"><span class="swatch note"></span>{{ t.graph.legend.nodeNote }}</p>
      <p class="row"><span class="swatch entity"></span>{{ t.graph.legend.nodeEntity }}</p>
    </section>

    <section>
      <h3>{{ t.graph.legend.edges }}</h3>
      <p class="row"><span class="line tapered"></span>{{ t.graph.legend.layerNamed }}</p>
      <p class="row"><span class="line boxed"></span>{{ t.graph.legend.layerComention }}</p>
      <p class="row"><span class="line dotted"></span>{{ t.graph.legend.layerSimilarity }}</p>
      <p class="row"><span class="line folded"></span>{{ t.graph.legend.layerDerived }}</p>
      <hr />
      <p class="row"><span class="line pending"></span>{{ t.graph.legend.statusPending }}</p>
      <p class="row"><span class="line confirmed"></span>{{ t.graph.legend.statusConfirmed }}</p>
      <p class="row"><span class="line rejected">✕</span>{{ t.graph.legend.statusRejected }}</p>
    </section>

    <section>
      <label class="toggle">
        <input
          type="checkbox"
          :checked="showDerived"
          @change="emit('update:showDerived', ($event.target as HTMLInputElement).checked)"
        />
        {{ t.graph.legend.showDerived }}
      </label>
      <label class="toggle">
        <input
          type="checkbox"
          :checked="showRejected"
          @change="emit('update:showRejected', ($event.target as HTMLInputElement).checked)"
        />
        {{ t.graph.legend.showRejected }}
      </label>
    </section>

    <section>
      <h3>{{ t.graph.legend.projection }}</h3>
      <input v-model.number="projectionValue" type="range" min="2" max="8" step="1" />
      <p class="value mono">{{ projectionValue }}</p>
      <p class="hint">{{ t.graph.legend.projectionHint }}</p>
    </section>

    <section>
      <h3>{{ t.graph.legend.minConfidence }}</h3>
      <div class="tiers">
        <button
          v-for="tier in tiers"
          :key="tier ?? 'any'"
          type="button"
          :class="{ on: minTier === tier }"
          @click="emit('update:minTier', tier)"
        >
          {{ tierLabel(tier) }}
        </button>
      </div>
    </section>

    <p class="hint footer">{{ t.graph.legend.hint }}</p>
  </aside>
</template>

<style scoped>
.legend {
  width: 232px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 12px 14px 20px;
  background: var(--bg-panel);
  border-right: 1px solid var(--line-subtle);
  font-size: 12px;
}
h2 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-tertiary);
  margin: 0 0 10px;
}
h3 {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin: 0 0 6px;
}
section {
  margin-bottom: 16px;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 5px;
  color: var(--text-secondary);
  line-height: 1.4;
}
.swatch {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
  border-radius: 2px;
}
.swatch.item {
  background: var(--node-item);
}
.swatch.note {
  background: var(--node-note);
}
/* 實體靠**空心**分，不靠顏色 —— 圖例也要照著畫，否則說明跟畫面不一致 */
.swatch.entity {
  border: 1.5px solid var(--node-entity);
}
.line {
  width: 26px;
  flex-shrink: 0;
  text-align: center;
  color: var(--edge-rejected);
}
.line::before {
  content: '';
  display: block;
  height: 0;
}
.line.tapered {
  height: 0;
  border-top: 3px solid var(--edge-confirmed);
  border-right: 0;
  clip-path: polygon(0 0, 100% 40%, 100% 60%, 0 100%);
}
.line.boxed {
  height: 0;
  border-top: 1.5px solid var(--edge-confirmed);
  position: relative;
}
.line.boxed::after {
  content: '';
  position: absolute;
  left: 9px;
  top: -4px;
  width: 7px;
  height: 7px;
  border: 1.5px solid var(--node-entity);
}
.line.dotted {
  height: 0;
  border-top: 1.5px dotted var(--edge-confirmed);
}
.line.folded {
  height: 0;
  border-top: 1.5px solid var(--line);
  opacity: 0.5;
}
.line.pending {
  height: 0;
  border-top: 2px dashed var(--edge-pending);
}
.line.confirmed {
  height: 0;
  border-top: 2px solid var(--edge-confirmed);
}
hr {
  border: 0;
  border-top: 1px solid var(--line-subtle);
  margin: 10px 0;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
  color: var(--text-secondary);
  cursor: pointer;
}
input[type='range'] {
  width: 100%;
}
.value {
  margin: 2px 0 4px;
  color: var(--text);
}
.hint {
  margin: 0;
  color: var(--text-muted);
  line-height: 1.5;
}
.footer {
  padding-top: 10px;
  border-top: 1px solid var(--line-subtle);
}
.tiers {
  display: flex;
  gap: 4px;
}
.tiers button {
  flex: 1;
  padding: 4px 0;
  font-size: 11px;
}
.tiers button.on {
  border-color: var(--ui-action);
  color: var(--ui-action);
}
</style>
