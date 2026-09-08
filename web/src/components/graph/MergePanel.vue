<script setup lang="ts">
/**
 * 「看起來是同一個」的實體配對（Stage 10.5）。
 *
 * ## 為什麼這個面板要說出後果，而不只是給一個數字
 *
 * 「有 3 組重複的實體」聽起來像一件可以之後再處理的事。
 * **它不是** —— 投影門檻是「被 3 份以上提到才畫成節點」，
 * 所以一個被 9 份文件提到、但拆成三種叫法的實體，
 * 三個都低於門檻，**圖上一個都不會出現**。
 *
 * 所以這裡的說明寫的是那個後果，不是那個數字。
 *
 * ## 每一條都要人按，而且按錯了取消得掉
 *
 * 一次錯的合併會把兩個人的事蹟混成一個人，而**混進去之後
 * 每一條線看起來都正常**。所以：建議帶理由、合併不刪任何一列、
 * 而且動了哪幾條邊記在資料庫裡。
 */
import { onMounted, ref, watch } from 'vue';

import { api, type ApiError, type MergeCandidate } from '../../api';
import { fill, t } from '../../i18n/zh-TW';
import ErrorPanel from '../ErrorPanel.vue';

const props = defineProps<{ slug: string }>();
const emit = defineEmits<{ merged: [] }>();

const rows = ref<MergeCandidate[]>([]);
const error = ref<ApiError | null>(null);
const busy = ref(false);
const lastResult = ref<string | null>(null);

async function load(): Promise<void> {
  const r = await api.mergeCandidates(props.slug);
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  error.value = null;
  rows.value = [...r.data];
}

onMounted(() => void load());
watch(
  () => props.slug,
  () => void load(),
);

async function merge(row: MergeCandidate): Promise<void> {
  const message = fill(t.entities.confirmMerge, { keep: row.keep.name, merge: row.merge.name });
  if (!window.confirm(message)) return;

  busy.value = true;
  const r = await api.mergeEntities(props.slug, row.keep.id, row.merge.id);
  busy.value = false;
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  // **平行線要說出來。** 合併兩條邊要決定出處與裁決歷史怎麼處理，
  // 而那些決定沒有一個可以自動做對 —— 所以留給人看、留給人否決。
  lastResult.value =
    fill(t.entities.merged, { moved: r.data.movedEdges }) +
    (r.data.duplicateEdges > 0
      ? ` ${fill(t.entities.duplicates, { n: r.data.duplicateEdges })}`
      : '');
  await load();
  emit('merged');
}
</script>

<template>
  <section class="merges">
    <h3>{{ t.entities.mergeTitle }}</h3>
    <ErrorPanel v-if="error" :error="error" />

    <p v-if="rows.length === 0" class="muted">{{ t.entities.mergeNone }}</p>

    <template v-else>
      <p class="why">{{ t.entities.mergeWhy }}</p>

      <ul>
        <li v-for="(row, i) in rows" :key="`${row.keep.id}|${row.merge.id}|${i}`">
          <div class="pair">
            <div class="side keep">
              <span class="label">{{ t.entities.keep }}</span>
              <strong>{{ row.keep.name }}</strong>
              <span class="muted">{{ fill(t.entities.mentions, { n: row.keep.mentions }) }}</span>
            </div>
            <div class="side">
              <span class="label">{{ t.entities.mergeInto }}</span>
              <strong>{{ row.merge.name }}</strong>
              <span class="muted">{{ fill(t.entities.mentions, { n: row.merge.mentions }) }}</span>
            </div>
          </div>
          <!-- **理由要顯示** —— 沒有理由的建議不該按。 -->
          <p class="reason">{{ t.entities.reason[row.reason] }}</p>
          <button :disabled="busy" @click="merge(row)">{{ t.entities.merge }}</button>
        </li>
      </ul>
    </template>

    <p v-if="lastResult" class="result">{{ lastResult }}</p>
  </section>
</template>

<style scoped>
.merges {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h3 {
  margin: 0;
  font-size: 13px;
}

.muted,
.why,
.reason,
.result {
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.7;
  margin: 0;
}

.why {
  color: var(--edge-pending);
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

li {
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius);
  padding: 8px;
  background: var(--bg-raised);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.pair {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.side {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  flex-wrap: wrap;
}

.side .label {
  color: var(--text-muted);
  font-size: 10px;
  min-width: 3.5em;
}

.side.keep strong {
  color: var(--text);
}

button {
  align-self: flex-start;
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-panel);
  color: var(--text-secondary);
  cursor: pointer;
}

button:hover:not(:disabled) {
  background: var(--bg-hover);
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
