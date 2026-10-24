<script setup lang="ts">
import { ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type ApiError, type SingleSourceRelations } from '../api';
import { fill, t } from '../i18n/zh-TW';
import ErrorPanel from './ErrorPanel.vue';
const props = defineProps<{ slug: string }>();
const opened = ref(false);
const busy = ref(false);
const data = ref<SingleSourceRelations | null>(null);
const error = ref<ApiError | null>(null);
let revision = 0;
async function load(more = false) {
  const token = ++revision;
  const slug = props.slug;
  busy.value = true;
  error.value = null;
  const result = await api.singleSourceRelations(
    slug,
    more ? (data.value?.nextCursor ?? null) : null,
  );
  if (token !== revision || slug !== props.slug) return;
  busy.value = false;
  if (result.ok) {
    const entries = more
      ? [...(data.value?.entries ?? []), ...result.data.entries]
      : result.data.entries;
    data.value = {
      ...result.data,
      entries: [...new Map(entries.map((row) => [row.id, row])).values()],
    };
  } else {
    data.value = null;
    error.value = result.error;
  }
}
function toggle(event: Event) {
  opened.value = (event.target as HTMLDetailsElement).open;
  if (opened.value) void load();
}
watch(
  () => props.slug,
  () => {
    revision++;
    data.value = null;
    error.value = null;
    busy.value = false;
    if (opened.value) void load();
  },
);
</script>
<template>
  <details class="single-source-relations" @toggle="toggle">
    <summary>{{ t.consolidateShell.singleEvidenceTitle }}</summary>
    <p class="hint">{{ t.singleSource.what }}</p>
    <button type="button" :disabled="busy" @click="load(false)">
      {{ busy ? t.singleSource.loading : t.singleSource.refresh }}
    </button>
    <ErrorPanel v-if="error" :error="error" retryable @retry="load(false)" />
    <template v-else-if="data && !busy">
      <p v-if="data.total === 0" class="muted">{{ t.singleSource.empty }}</p>
      <template v-else>
        <p class="hint">
          {{ fill(t.singleSource.coverage, { shown: data.entries.length, total: data.total }) }}
        </p>
        <ul>
          <li v-for="row in data.entries" :key="row.id">
            <RouterLink
              :to="{
                path: `/case/${encodeURIComponent(slug)}`,
                query: { focus: row.focusId, edge: row.id },
              }"
            >
              {{ row.source }} → {{ row.target }} · {{ row.rel }}
            </RouterLink>
            <p>{{ t.singleSource.source }} {{ row.itemTitle }}</p>
            <blockquote v-if="row.quote">{{ row.quote }}</blockquote>
          </li>
        </ul>
        <button v-if="data.nextCursor" type="button" @click="load(true)">
          {{ t.singleSource.more }}
        </button>
      </template>
    </template>
  </details>
</template>
<style scoped>
.single-source-relations {
  margin-block: 1rem;
}
li {
  margin-block: 1rem;
}
blockquote {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
