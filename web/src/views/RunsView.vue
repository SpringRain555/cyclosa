<script setup lang="ts">
/**
 * 作業紀錄。**這一頁是「擷取不是黑箱」的體現**（ui-workflows）。
 *
 * 三件事一定要看得見：
 *   1. **節流狀態列一直在畫面上** —— 它是這個工具對外的行為承諾
 *   2. **每一項的失敗各自帶自己的碼與繁中訊息**，不是一個「匯入失敗」
 *   3. **`部分失敗` 不是「失敗」的一種**：成功幾個、失敗幾個、原因各是什麼
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api, type ApiError, type Run, type RunItem } from '../api';
import { errorMessages, fill, t } from '../i18n/zh-TW';
import ErrorPanel from '../components/ErrorPanel.vue';

const route = useRoute();
const router = useRouter();

const slug = computed(() => String(route.params['slug'] ?? ''));
const runId = computed(() => {
  const raw = route.params['runId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
});

const runList = ref<Run[]>([]);
const run = ref<Run | null>(null);
const runItems = ref<RunItem[]>([]);
const error = ref<ApiError | null>(null);

const urls = ref('');
const busy = ref(false);
const dragging = ref(false);
const throttleNow = ref<{ host: string; ms: number } | null>(null);

let stream: EventSource | null = null;

function closeStream(): void {
  stream?.close();
  stream = null;
  throttleNow.value = null;
}
onUnmounted(closeStream);

async function loadRuns(): Promise<void> {
  const result = await api.runs(slug.value);
  if (result.ok) runList.value = result.data;
  else error.value = result.error;
}

async function loadRun(): Promise<void> {
  const id = runId.value;
  closeStream();
  run.value = null;
  runItems.value = [];
  if (id === null) return;

  const result = await api.run(slug.value, id);
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  run.value = result.data.run;
  runItems.value = result.data.items;

  // 還在跑就接上 SSE。**跑完了就不接** —— 那條端點會立刻回一個結束事件。
  if (result.data.run.live) subscribe(id);
}

function subscribe(id: string): void {
  stream = new EventSource(api.runEventsUrl(slug.value, id));
  stream.onmessage = (message) => {
    const event = JSON.parse(message.data as string) as Record<string, unknown>;
    if (event['type'] === 'throttled') {
      throttleNow.value = { host: String(event['host']), ms: Number(event['waitedMs']) };
    }
    if (event['type'] === 'item' || event['type'] === 'settled') {
      throttleNow.value = null;
      void refreshRun(id);
    }
    if (event['type'] === 'settled') {
      closeStream();
      void loadRuns();
    }
  };
  stream.onerror = () => closeStream();
}

async function refreshRun(id: string): Promise<void> {
  const result = await api.run(slug.value, id);
  if (!result.ok) return;
  run.value = result.data.run;
  runItems.value = result.data.items;
}

watch(slug, () => void loadRuns(), { immediate: true });
watch(runId, () => void loadRun(), { immediate: true });

function openRun(id: string): void {
  void router.push(`/case/${encodeURIComponent(slug.value)}/runs/${encodeURIComponent(id)}`);
}

async function submitUrls(): Promise<void> {
  const list = urls.value
    .split(/[\s]+/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  if (list.length === 0) return;

  busy.value = true;
  const result = await api.importUrls(slug.value, list);
  busy.value = false;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  urls.value = '';
  await loadRuns();
  openRun(result.data.runId);
}

async function submitFiles(files: FileList | null): Promise<void> {
  if (files === null || files.length === 0) return;
  busy.value = true;
  let lastRun: string | null = null;
  for (const file of Array.from(files)) {
    const result = await api.importFile(slug.value, file);
    if (result.ok) lastRun = result.data.runId;
    else error.value = result.error;
  }
  busy.value = false;
  await loadRuns();
  if (lastRun !== null) openRun(lastRun);
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  void submitFiles(event.dataTransfer?.files ?? null);
}

async function cancel(): Promise<void> {
  const id = runId.value;
  if (id === null) return;
  const result = await api.cancelRun(slug.value, id);
  if (!result.ok) error.value = result.error;
}

function when(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toLocaleString('zh-Hant');
}

function noteOf(item: RunItem): string {
  if (item.code === null) return '';
  return errorMessages[item.code] ?? item.code;
}

function openItem(id: string | null): void {
  if (id === null) return;
  void router.push(`/case/${encodeURIComponent(slug.value)}/reader/${encodeURIComponent(id)}`);
}
</script>

<template>
  <main class="runs">
    <section class="import" :class="{ dragging }">
      <h2>{{ t.runs.newImport }}</h2>

      <label class="field">
        <span>{{ t.runs.urlsLabel }}</span>
        <textarea v-model="urls" rows="3" :placeholder="t.runs.urlsPlaceholder"></textarea>
      </label>

      <div class="import-actions">
        <button class="primary" :disabled="busy || urls.trim().length === 0" @click="submitUrls">
          {{ busy ? t.runs.uploading : t.runs.submitUrls }}
        </button>
        <label class="btn">
          {{ t.runs.picking }}
          <input
            type="file"
            multiple
            hidden
            @change="submitFiles(($event.target as HTMLInputElement).files)"
          />
        </label>
      </div>

      <div
        class="drop"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        {{ t.runs.dropHint }}
      </div>
    </section>

    <!-- **這一列一直在畫面上。** 它是這個工具對外的行為承諾。 -->
    <section class="throttle">
      <span class="label">{{ t.runs.throttleTitle }}</span>
      <span class="rule">{{ t.runs.throttleInterval }}</span>
      <span class="rule">{{ t.runs.throttleBackoff }}</span>
      <span class="rule">{{ t.runs.throttleRobots }}</span>
      <span v-if="throttleNow" class="now">
        {{ fill(t.runs.throttleNow, { host: throttleNow.host, ms: throttleNow.ms }) }}
      </span>
    </section>

    <ErrorPanel v-if="error" :error="error" />

    <div class="split">
      <aside class="list">
        <h2>{{ t.runs.title }}</h2>
        <p v-if="runList.length === 0" class="muted">{{ t.runs.empty }}</p>
        <ul v-else class="rows">
          <li v-for="r in runList" :key="r.id">
            <button class="row" :class="{ active: r.id === runId }" @click="openRun(r.id)">
              <span class="row-title">{{ r.label }}</span>
              <span class="row-meta">
                <span :class="['badge', r.status]">{{ t.runStatus[r.status] }}</span>
                <span v-if="r.live" class="live">{{ t.runs.live }}</span>
                <span>{{ when(r.createdAt) }}</span>
              </span>
            </button>
          </li>
        </ul>
      </aside>

      <section v-if="run" class="detail">
        <header class="detail-head">
          <h2>{{ run.label }}</h2>
          <p class="counts">
            <span :class="['badge', run.status]">{{ t.runStatus[run.status] }}</span>
            {{
              fill(t.runs.counts, {
                succeeded: run.succeeded,
                failed: run.failed,
                total: run.total,
              })
            }}
          </p>
          <button v-if="run.live" @click="cancel">{{ t.runs.cancel }}</button>
        </header>

        <table>
          <thead>
            <tr>
              <th>{{ t.runs.colStatus }}</th>
              <th>{{ t.runs.colSource }}</th>
              <th>{{ t.runs.colHost }}</th>
              <th>{{ t.runs.colNodes }}</th>
              <th>{{ t.runs.colEdges }}</th>
              <th>{{ t.runs.colNote }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in runItems" :key="item.id">
              <td>
                <span :class="['badge', item.outcome]">{{ t.runOutcome[item.outcome] }}</span>
              </td>
              <td class="src">
                <button v-if="item.itemId" class="link" @click="openItem(item.itemId)">
                  {{ item.requested }}
                </button>
                <span v-else>{{ item.requested }}</span>
              </td>
              <td class="mono">{{ item.host ?? '' }}</td>
              <td class="num">{{ item.newNodes }}</td>
              <td class="num">{{ item.newEdges }}</td>
              <td class="note">
                {{ noteOf(item) }}
                <span v-if="item.waitedMs" class="muted waited">
                  {{ fill(t.runs.waited, { ms: item.waitedMs }) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </main>
</template>

<style scoped>
.runs {
  padding: 20px 24px 60px;
  overflow-y: auto;
  height: 100%;
}
h2 {
  font-size: 14px;
  margin: 0 0 10px;
}
.import {
  border: 1px solid var(--line-subtle);
  background: var(--bg-panel);
  border-radius: var(--radius-lg);
  padding: 16px 18px;
  max-width: 760px;
}
.import.dragging {
  border-color: var(--ui-action);
}
.field span {
  display: block;
  font-size: 12px;
  color: var(--text-tertiary);
  margin-bottom: 4px;
}
textarea {
  font: inherit;
  width: 100%;
  background: var(--bg-app);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 8px 10px;
  resize: vertical;
}
textarea:focus {
  outline: none;
  border-color: var(--ui-action);
}
.import-actions {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}
.btn {
  display: inline-block;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  color: var(--text);
  border-radius: var(--radius);
  padding: 6px 14px;
  cursor: pointer;
}
.drop {
  border: 1px dashed var(--line-muted);
  border-radius: var(--radius);
  padding: 14px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
.throttle {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin: 14px 0;
  padding: 8px 12px;
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius);
  background: var(--bg-panel);
  font-size: 12px;
  color: var(--text-tertiary);
}
.throttle .label {
  color: var(--text-secondary);
  font-weight: 600;
}
.throttle .rule::before {
  content: '· ';
}
.throttle .now {
  color: var(--edge-pending);
  margin-left: auto;
}
.split {
  display: grid;
  grid-template-columns: minmax(220px, 300px) 1fr;
  gap: 20px;
  margin-top: 16px;
  align-items: start;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.row {
  display: block;
  width: 100%;
  text-align: left;
  border: 1px solid transparent;
  background: transparent;
  padding: 8px 10px;
  border-radius: var(--radius);
}
.row:hover {
  background: var(--bg-hover);
}
.row.active {
  border-color: var(--ring-selected);
  background: var(--bg-raised);
}
.row-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-muted);
}
.live {
  color: var(--ui-action);
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.counts {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
  font-size: 13px;
}
th {
  text-align: left;
  font-weight: 500;
  color: var(--text-muted);
  font-size: 11px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}
td {
  padding: 8px;
  border-bottom: 1px solid var(--line-subtle);
  vertical-align: top;
}
td.num {
  text-align: right;
  width: 72px;
}
td.src {
  max-width: 320px;
  word-break: break-all;
}
td.note {
  color: var(--text-secondary);
}
.waited {
  display: block;
  font-size: 11px;
}
.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--ui-action);
  text-align: left;
  text-decoration: underline;
}
/* **狀態一律是文字，顏色只是輔助。** 綠對紅在綠紅色盲下只差 ΔE 2.2（ADR-0018）。 */
.badge {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  font-size: 11px;
  white-space: nowrap;
}
.badge.done,
.badge.ok {
  border-color: var(--ui-success);
  color: var(--ui-success);
}
.badge.partial,
.badge.running,
.badge.queued,
.badge.duplicate {
  border-color: var(--edge-pending);
  color: var(--edge-pending);
}
.badge.failed {
  border-color: var(--ui-danger);
  color: var(--ui-danger);
}
.muted {
  color: var(--text-tertiary);
}
</style>
