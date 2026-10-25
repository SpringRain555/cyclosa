<script setup lang="ts">
import { t } from '../../i18n/zh-TW.js';

/** 要不要顯示、按鈕做什麼由 store 的 `isolatedFocusAction` 決定，這裡只畫。 */
const props = defineProps<{ action: 'none' | 'change-focus' | 'open-search' }>();

const emit = defineEmits<{
  (event: 'change-focus'): void;
  (event: 'open-search'): void;
}>();

function activate(): void {
  if (props.action === 'open-search') emit('open-search');
  else emit('change-focus');
}
</script>

<template>
  <div v-if="action !== 'none'" class="focus-notice" role="status">
    <p class="message">{{ t.graph.noVisibleNeighbors }}</p>
    <button type="button" @click="activate">
      {{ action === 'open-search' ? t.search.open : t.graph.changeFocus }}
    </button>
  </div>
</template>

<style scoped>
.focus-notice {
  position: absolute;
  z-index: 1;
  top: var(--s4);
  left: 50%;
  display: flex;
  align-items: center;
  gap: var(--s3);
  max-width: calc(100% - var(--s5));
  padding: var(--s3) var(--s4);
  transform: translateX(-50%);
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius-lg);
  background: var(--bg-panel);
  color: var(--text-secondary);
}

.message {
  margin: 0;
}

/* 窄畫面上按鈕文字不准被擠成直排（2026-10-25 在 768 寬看到） */
.focus-notice button {
  flex: none;
  white-space: nowrap;
}

@media (max-width: 720px) {
  .focus-notice {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
