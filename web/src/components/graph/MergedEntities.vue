<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, type ApiError } from '../../api';
import { t } from '../../i18n/zh-TW';
import ErrorPanel from '../ErrorPanel.vue';

const props = defineProps<{ slug: string; entityId: string }>();
const emit = defineEmits<{ changed: [] }>();
const rows = ref<{ id: string; name: string; canUnmerge: boolean; mergeId: string | null }[]>([]);
const error = ref<ApiError | null>(null);
const busy = ref(false);
let generation = 0;
async function load(): Promise<void> {
  const current = ++generation;
  const result = await api.mergedEntities(props.slug, props.entityId);
  if (current !== generation) return;
  if (result.ok) {
    rows.value = result.data;
    error.value = null;
  } else error.value = result.error;
}
watch(
  [() => props.slug, () => props.entityId],
  () => {
    rows.value = [];
    void load();
  },
  { immediate: true },
);
async function unmerge(id: string, mergeId: string | null): Promise<void> {
  if (mergeId === null) return;
  const current = generation;
  busy.value = true;
  const result = await api.unmergeEntity(props.slug, id, mergeId);
  busy.value = false;
  if (current !== generation) return;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  await load();
  emit('changed');
}
</script>

<template>
  <section v-if="rows.length > 0 || error">
    <ErrorPanel v-if="error" :error="error" />
    <h3>{{ t.entities.absorbed }}</h3>
    <p>{{ t.entities.unmergeOrder }}</p>
    <ul>
      <li v-for="row in rows" :key="row.id">
        {{ row.name }}
        <button
          type="button"
          :disabled="busy || !row.canUnmerge"
          @click="unmerge(row.id, row.mergeId)"
        >
          {{ t.entities.unmerge }}
        </button>
      </li>
    </ul>
  </section>
</template>
