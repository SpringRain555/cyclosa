<script setup lang="ts">
/**
 * 抽取信心低的標記。
 *
 * **不是只寫在日誌裡**（REQ-0003 的驗收條件）—— 清單與閱讀器都看得到，
 * 而且**說得出理由**。理由的文字對得上 2026-09-07 那次量測。
 *
 * 顏色用 `--edge-pending` 的琥珀，而且**一定配一個記號**（ADR-0018 的第二重編碼）。
 */
import { t } from '../i18n/zh-TW';

defineProps<{ reasons: readonly string[]; compact?: boolean }>();

const reasonText = (key: string): string =>
  (t.lowConfidenceReason as Record<string, string>)[key] ?? key;
</script>

<template>
  <span v-if="compact" class="chip" :title="reasons.map(reasonText).join('\n')">
    <span class="mark" aria-hidden="true">!</span>
  </span>
  <div v-else class="panel">
    <div class="head">
      <span class="mark" aria-hidden="true">!</span>
      {{ t.reader.lowConfidenceTitle }}
    </div>
    <ul>
      <li v-for="r in reasons" :key="r">{{ reasonText(r) }}</li>
    </ul>
  </div>
</template>

<style scoped>
.mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  border: 1px solid var(--edge-pending);
  color: var(--edge-pending);
  font-size: var(--fs-label);
  font-weight: 700;
  line-height: 1;
  flex-shrink: 0;
}
.chip {
  display: inline-flex;
  vertical-align: middle;
}
.panel {
  border: 1px dashed var(--edge-pending);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin: 0 0 14px;
  background: var(--bg-panel);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--edge-pending);
}
ul {
  margin: 6px 0 0;
  padding-left: 30px;
  color: var(--text-secondary);
  font-size: var(--fs-small);
}
</style>
