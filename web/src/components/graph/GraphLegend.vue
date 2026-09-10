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
import { guideItem, guideSection, t } from '../../i18n/zh-TW';
import { compactSections } from './legend-items';

/**
 * **這一欄顯示的是那份清單的子集，不是自己的一份。**
 *
 * 完整版在設定頁的「狀態說明」分頁 —— 兩邊讀同一份宣告
 * （`legend-items.ts`），所以不可能一邊有、一邊沒有。
 */
const sections = compactSections();

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

    <section v-for="s in sections" :key="s.key">
      <h3>{{ guideSection(s.key) }}</h3>
      <p v-for="item in s.items" :key="item.key" class="row">
        <span :class="['mark', item.mark]">{{ item.glyph ?? '' }}</span>
        {{ guideItem(item.key).short }}
      </p>
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
/* **樣本的畫法搬到 `styles/legend-marks.css`** —— 設定頁的「狀態說明」
   分頁用同一份。各留一份的話，兩邊的虛線會慢慢變成兩種虛線。 */
.row .mark {
  flex-shrink: 0;
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
