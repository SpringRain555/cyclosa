<script setup lang="ts">
/**
 * 錯誤的唯一顯示方式。
 *
 * **繁中訊息 ＋ 可複製的識別碼**，碼本身不顯示（REQ-0008）。
 * 資料根相關的錯誤還會顯示「設定檔在哪、它指到哪」——
 * 那是 REQ-0001 那條「不要顯示一個空清單」的具體長相。
 */
import { ref } from 'vue';
import type { ApiError } from '../api';
import { t } from '../i18n/zh-TW';

const props = defineProps<{ error: ApiError; retryable?: boolean }>();
const emit = defineEmits<{ retry: [] }>();

const copied = ref(false);

async function copyId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.error.correlationId);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false;
  }
}

function detailString(key: string): string | null {
  const v = props.error.detail?.[key];
  return typeof v === 'string' ? v : null;
}
</script>

<template>
  <div class="panel">
    <div class="head">{{ t.error.title }}</div>
    <p class="msg">{{ error.message }}</p>

    <dl v-if="detailString('pointerPath') || detailString('dataRoot')" class="detail">
      <template v-if="detailString('pointerPath')">
        <dt>{{ t.error.pointerPath }}</dt>
        <dd class="mono">{{ detailString('pointerPath') }}</dd>
      </template>
      <template v-if="detailString('dataRoot')">
        <dt>{{ t.error.dataRoot }}</dt>
        <dd class="mono">{{ detailString('dataRoot') }}</dd>
      </template>
    </dl>

    <div class="actions">
      <button v-if="retryable" @click="emit('retry')">{{ t.error.retry }}</button>
      <button v-if="error.correlationId" @click="copyId">
        {{ copied ? t.error.copied : t.error.copyId }}
      </button>
      <code v-if="error.correlationId" class="cid mono">{{ error.correlationId }}</code>
    </div>
  </div>
</template>

<style scoped>
.panel {
  border: 1px solid var(--line-strong);
  border-left: 3px solid var(--ui-danger);
  background: var(--bg-panel);
  border-radius: var(--radius);
  padding: 16px 18px;
  max-width: 720px;
}
.head {
  font-weight: 600;
  margin-bottom: 6px;
}
.msg {
  margin: 0 0 12px;
  color: var(--text-secondary);
}
.detail {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 14px;
  margin: 0 0 14px;
  font-size: var(--fs-small);
}
.detail dt {
  color: var(--text-muted);
}
.detail dd {
  margin: 0;
  color: var(--text-secondary);
  word-break: break-all;
}
.actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.cid {
  color: var(--text-muted);
  font-size: var(--fs-label);
}
</style>
