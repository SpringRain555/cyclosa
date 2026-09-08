<script setup lang="ts">
/**
 * 來源網站清單（Stage 10.5）。
 *
 * ## 這一頁最重要的一欄是「依據」
 *
 * 「讀得到／要登入」是一個判斷，而**判斷的可信度取決於它從哪來**：
 * 「依你抓過的 12 次」與「依一次檢查」是兩件差很多的事，
 * 而它們如果長得一樣，使用者就會把後者當成前者。
 *
 * ## 檢查按鈕會送出真的請求，所以按鈕旁邊寫著它的規矩
 *
 * 這個工具對外的行為（robots、間隔、429 立刻停）是一個承諾，
 * 而**一顆會連外的按鈕不該讓人按下去才知道它做了什麼**。
 */
import { computed, onMounted, ref } from 'vue';

import { api, type ApiError, type SourceRow } from '../api';
import { fill, t } from '../i18n/zh-TW';
import ErrorPanel from './ErrorPanel.vue';

const rows = ref<SourceRow[]>([]);
const error = ref<ApiError | null>(null);
const checking = ref(false);
const busyHost = ref<string | null>(null);

const newHost = ref('');
const newName = ref('');
const newProbe = ref('');

async function load(): Promise<void> {
  const r = await api.sources();
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  error.value = null;
  rows.value = [...r.data];
}
onMounted(() => void load());

function apply(next: readonly SourceRow[]): void {
  rows.value = [...next];
}

async function checkAll(): Promise<void> {
  checking.value = true;
  const r = await api.checkSources();
  checking.value = false;
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  apply(r.data);
}

async function checkOne(host: string): Promise<void> {
  busyHost.value = host;
  const r = await api.checkSources([host]);
  busyHost.value = null;
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  apply(r.data);
}

async function toggle(row: SourceRow): Promise<void> {
  busyHost.value = row.host;
  const r = await api.saveSource({ ...row, enabled: !row.enabled });
  busyHost.value = null;
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  apply(r.data);
}

async function add(): Promise<void> {
  const host = newHost.value.trim();
  if (host.length === 0) return;
  const r = await api.saveSource({
    host,
    nameZh: newName.value.trim().length > 0 ? newName.value.trim() : host,
    kind: 'site',
    category: 'reference',
    probe: newProbe.value.trim().length > 0 ? newProbe.value.trim() : null,
    enabled: true,
  });
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  newHost.value = '';
  newName.value = '';
  newProbe.value = '';
  apply(r.data);
}

function accessText(row: SourceRow): string {
  return (
    t.sources.access[row.verdict.access as keyof typeof t.sources.access] ?? row.verdict.access
  );
}

/** 判斷是從哪來的。**這一句跟判斷本身一樣重要。** */
function basisText(row: SourceRow): string {
  if (row.verdict.basis === 'history') {
    return fill(t.sources.basisHistory, { n: row.verdict.attempts });
  }
  if (row.verdict.basis === 'probe') return t.sources.basisProbe;
  return t.sources.basisNone;
}

function when(ms: number | null): string {
  return ms === null ? t.sources.lastCheckedNever : new Date(ms).toLocaleString('zh-Hant');
}

const enabledCount = computed(() => rows.value.filter((r) => r.enabled).length);
</script>

<template>
  <section class="sources">
    <p class="intro">{{ t.sources.intro }}</p>
    <ErrorPanel v-if="error" :error="error" />

    <div class="toolbar">
      <button :disabled="checking" @click="checkAll">
        {{ checking ? t.sources.checking : t.sources.check }}
      </button>
      <span class="hint">{{ t.sources.checkNote }}</span>
    </div>

    <p v-if="rows.length === 0" class="muted">{{ t.sources.empty }}</p>

    <table v-else>
      <thead>
        <tr>
          <th>{{ t.sources.columns.site }}</th>
          <th>{{ t.sources.columns.status }}</th>
          <th class="num">{{ t.sources.columns.attempts }}</th>
          <th>{{ t.sources.columns.checked }}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.host" :class="{ off: !row.enabled }">
          <td>
            <div class="name">
              {{ row.nameZh }}
              <!-- 從抓取紀錄長出來的那幾列，型別與分類是填的不是知道的 ——
                   **顯示一個猜的分類會讓它看起來像被整理過。** -->
              <template v-if="!row.discovered">
                <span class="tag">{{ t.sources.kind[row.kind] }}</span>
                <span class="tag">{{
                  t.sources.category[row.category as keyof typeof t.sources.category] ??
                  row.category
                }}</span>
              </template>
              <span v-if="row.builtIn" class="tag">{{ t.sources.builtIn }}</span>
              <span v-if="!row.enabled" class="tag off-tag">{{ t.sources.disabled }}</span>
            </div>
            <div class="host">{{ row.host }}</div>
            <div v-if="row.noteZh" class="note">{{ row.noteZh }}</div>
          </td>

          <td>
            <!-- 每個狀態都有第二重編碼：**記號在顏色之外**（ADR-0018）。 -->
            <span :class="['access', row.verdict.access]">
              <span class="mark" aria-hidden="true">{{
                row.verdict.access === 'open' ? '·' : row.verdict.access === 'unknown' ? '?' : '×'
              }}</span>
              {{ accessText(row) }}
            </span>
            <div class="basis">{{ basisText(row) }}</div>
            <div v-if="row.expected && row.verdict.basis === 'none'" class="basis">
              {{ t.sources.expected[row.expected] }}
            </div>
          </td>

          <td class="num">{{ row.history.attempts || '—' }}</td>

          <td>
            <template v-if="row.probe">{{ when(row.lastProbe?.at ?? null) }}</template>
            <template v-else>
              <span class="muted" :title="t.sources.noProbeWhy">{{ t.sources.noProbe }}</span>
            </template>
          </td>

          <td class="actions">
            <button v-if="row.probe" :disabled="busyHost !== null" @click="checkOne(row.host)">
              {{ busyHost === row.host ? t.sources.checking : t.sources.checkOne }}
            </button>
            <button :disabled="busyHost !== null" @click="toggle(row)">
              {{ row.enabled ? t.sources.disable : t.sources.enable }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="muted count">{{ enabledCount }} / {{ rows.length }}</p>

    <form class="add" @submit.prevent="add">
      <h3>{{ t.sources.addTitle }}</h3>
      <div class="fields">
        <input v-model="newHost" type="text" :placeholder="t.sources.addHost" />
        <input v-model="newName" type="text" :placeholder="t.sources.addName" />
        <input v-model="newProbe" type="text" :placeholder="t.sources.addProbe" />
        <button type="submit">{{ t.sources.add }}</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.sources {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.intro,
.hint,
.muted {
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.7;
  margin: 0;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

th {
  text-align: left;
  font-weight: 500;
  color: var(--text-tertiary);
  font-size: 12px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}

td {
  padding: 8px;
  border-bottom: 1px solid var(--line-subtle);
  vertical-align: top;
}

tr.off {
  opacity: 0.55;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.host {
  color: var(--text-muted);
  font-size: 11px;
  font-family: ui-monospace, monospace;
}

.note {
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.6;
  margin-top: 3px;
  max-width: 46ch;
}

.tag {
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 5px;
  font-size: 10px;
  color: var(--text-tertiary);
}

.tag.off-tag {
  border-style: dashed;
}

.access {
  white-space: nowrap;
}

.mark {
  display: inline-block;
  width: 1em;
  text-align: center;
}

/* 只有「讀得到」是中性的；其餘一律琥珀，而且都帶記號。
   **綠色不用在這裡** —— 那個顏色在這個工具裡只有「確認」一個意思。 */
.access.login,
.access.disallowed,
.access.throttled,
.access.unreachable,
.access.js-only {
  color: var(--edge-pending);
}

.access.unknown {
  color: var(--text-muted);
}

.basis {
  color: var(--text-muted);
  font-size: 11px;
  margin-top: 2px;
}

.actions {
  display: flex;
  gap: 6px;
  white-space: nowrap;
}

button {
  font: inherit;
  font-size: 12px;
  padding: 4px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
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

.count {
  text-align: right;
}

.add h3 {
  font-size: 13px;
  margin: 0 0 8px;
}

.fields {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

input {
  font: inherit;
  font-size: 13px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-app);
  color: var(--text);
  min-width: 160px;
}
</style>
