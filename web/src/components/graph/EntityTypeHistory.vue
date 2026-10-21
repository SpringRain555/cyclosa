<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, type ApiError, type EntityTypeHistory } from '../../api';
import { fill, t } from '../../i18n/zh-TW';
import ErrorPanel from '../ErrorPanel.vue';
const props = defineProps<{ slug: string; entityId: string }>();
const emit = defineEmits<{ changed: [] }>();
const history = ref<EntityTypeHistory | null>(null);
const error = ref<ApiError | null>(null);
const busy = ref(false);
let revision = 0;
async function load(): Promise<void> {
  const current = ++revision;
  history.value = null;
  error.value = null;
  const result = await api.entityTypeHistory(props.slug, props.entityId);
  if (current !== revision) return;
  if (result.ok) history.value = result.data;
  else error.value = result.error;
}
watch(
  () => [props.slug, props.entityId],
  () => void load(),
  { immediate: true },
);
function label(type: string): string {
  return t.graph.entityType[type as keyof typeof t.graph.entityType] ?? type;
}
async function undo(opId: string): Promise<void> {
  busy.value = true;
  const entityId = props.entityId;
  const result = await api.undoEntityType(props.slug, entityId, opId);
  busy.value = false;
  if (entityId !== props.entityId) return;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  await load();
  emit('changed');
}
</script>
<template>
  <section v-if="history?.manual || history?.changes.length || error">
    <h4>{{ t.entityTypeHistory.title }}</h4>
    <ErrorPanel v-if="error" :error="error" />
    <p v-if="history?.manual">{{ t.entityTypeHistory.manual }}</p>
    <ul>
      <li v-for="change in history?.changes" :key="change.opId">
        {{ fill(t.entityTypeHistory.fromTo, { from: label(change.from), to: label(change.to) }) }}
        <span v-if="change.undone">{{ t.entityTypeHistory.undone }}</span>
        <button
          v-else-if="change.canUndo"
          type="button"
          :disabled="busy"
          @click="undo(change.opId)"
        >
          {{ t.entityTypeHistory.undo }}
        </button>
      </li>
    </ul>
  </section>
</template>
