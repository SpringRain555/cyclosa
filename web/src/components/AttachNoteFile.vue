<script setup lang="ts">
import { ref } from 'vue';
import { api, type ApiError } from '../api';
import { t } from '../i18n/zh-TW';
import ErrorPanel from './ErrorPanel.vue';

const props = defineProps<{ slug: string; itemId: string }>();
const emit = defineEmits<{ attached: [] }>();
const input = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const done = ref(false);
const error = ref<ApiError | null>(null);

async function upload(event: Event): Promise<void> {
  const field = event.target as HTMLInputElement;
  const file = field.files?.[0];
  field.value = '';
  if (!file || busy.value) return;
  busy.value = true;
  error.value = null;
  done.value = false;
  const result = await api.attachNoteFile(props.slug, props.itemId, file);
  busy.value = false;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  done.value = true;
  emit('attached');
}
</script>

<template>
  <div class="attachment">
    <input ref="input" type="file" accept=".md" hidden :disabled="busy" @change="upload" />
    <button type="button" :disabled="busy" @click="input?.click()">
      {{ busy ? t.notes.attaching : t.notes.attach }}
    </button>
    <p class="hint">{{ t.notes.attachHint }}</p>
    <p v-if="done" role="status">{{ t.notes.attached }}</p>
    <ErrorPanel v-if="error" :error="error" />
  </div>
</template>

<style scoped>
.hint {
  color: var(--text-tertiary);
  font-size: var(--fs-label);
  line-height: 1.6;
}
</style>
