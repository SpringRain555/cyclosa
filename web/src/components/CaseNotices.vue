<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, type ApiError, type CaseNotice } from '../api';
import { fill, t } from '../i18n/zh-TW';

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{ error: [error: ApiError] }>();
const notices = ref<CaseNotice[]>([]);

watch(
  () => props.slug,
  async (slug) => {
    notices.value = [];
    const result = await api.notices(slug);
    if (slug !== props.slug) return;
    if (result.ok) notices.value = result.data;
    else emit('error', result.error);
  },
  { immediate: true },
);

function describe(notice: CaseNotice): string {
  if (notice.kind !== 'expansion-cleanup') return t.runs.noticeUnknown;
  try {
    const body = JSON.parse(notice.bodyJson) as Record<string, unknown>;
    const reasons = body['reasons'] as Record<string, unknown> | undefined;
    const values: Record<string, number> = {};
    for (const key of ['deletedRuns', 'deletedItems', 'deletedEdges', 'keptItems', 'keptEdges']) {
      if (typeof body[key] !== 'number') return t.runs.noticeUnknown;
      values[key] = body[key];
    }
    for (const key of ['read', 'annotated', 'excluded', 'referenced', 'otherRuns']) {
      if (typeof reasons?.[key] !== 'number') return t.runs.noticeUnknown;
      values[key] = reasons[key];
    }
    return fill(t.runs.noticeCleanup, values);
  } catch {
    return t.runs.noticeUnknown;
  }
}

async function dismiss(id: string): Promise<void> {
  const slug = props.slug;
  const result = await api.dismissNotice(slug, id);
  if (slug !== props.slug) return;
  if (result.ok) notices.value = notices.value.filter((notice) => notice.id !== id);
  else emit('error', result.error);
}
</script>

<template>
  <section v-for="notice in notices" :key="notice.id" class="card" role="status">
    <h2>{{ t.runs.noticeTitle }}</h2>
    <p>{{ describe(notice) }}</p>
    <button type="button" @click="dismiss(notice.id)">{{ t.runs.noticeDismiss }}</button>
  </section>
</template>
