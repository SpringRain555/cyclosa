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

/** 數字讀不出來就是 `null` —— 那一則整則改說「無法顯示」，不拿 0 去填。 */
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 正文升級（ADR-0039 第五節，`application/case-upgrade.ts` 寫的那一份）。是 0 的那幾句不說。 */
function describeUpgrade(body: Record<string, unknown>): string {
  const evidence = (body['evidence'] ?? {}) as Record<string, unknown>;
  const notes = (body['notes'] ?? {}) as Record<string, unknown>;
  const changed = count(body['changed']);
  const failed = count(body['failed']);
  const attachments = count(body['attachments']);
  const vectors = count(body['vectorsDropped']);
  const evidenceRewritten = count(evidence['rewritten']);
  const evidenceLost = count(evidence['unresolved']);
  const notesRewritten = count(notes['rewritten']);
  const notesLost = count(notes['unresolved']);
  if (
    changed === null ||
    failed === null ||
    attachments === null ||
    vectors === null ||
    evidenceRewritten === null ||
    evidenceLost === null ||
    notesRewritten === null ||
    notesLost === null
  ) {
    return t.runs.noticeUnknown;
  }
  const parts: string[] = [t.runs.noticeUpgrade];
  if (changed > 0) parts.push(fill(t.runs.noticeUpgradeChanged, { changed }));
  if (vectors > 0) parts.push(fill(t.runs.noticeUpgradeVectors, { n: vectors }));
  if (evidenceRewritten + notesRewritten > 0) {
    parts.push(
      fill(t.runs.noticeUpgradeRewritten, { evidence: evidenceRewritten, notes: notesRewritten }),
    );
  }
  if (evidenceLost + notesLost > 0) {
    parts.push(fill(t.runs.noticeUpgradeUnresolved, { evidence: evidenceLost, notes: notesLost }));
  }
  if (attachments > 0) parts.push(fill(t.runs.noticeUpgradeAttachments, { n: attachments }));
  if (failed > 0) parts.push(fill(t.runs.noticeUpgradeFailed, { n: failed }));
  return parts.join('');
}

function describe(notice: CaseNotice): string {
  if (notice.kind === 'derived-upgrade') {
    try {
      return describeUpgrade(JSON.parse(notice.bodyJson) as Record<string, unknown>);
    } catch {
      return t.runs.noticeUnknown;
    }
  }
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
