<script setup lang="ts">
/**
 * 專題清單 —— 最上層，沒有分頁。
 *
 * **這一頁回答的問題是「我上次做到哪、現在該做什麼」**，
 * 而「待查證」那一欄就是那個問題的直接答案（REQ-0001）。
 *
 * 資料根有問題時，這一頁顯示的是**那個問題**，不是一個空清單。
 */
import { computed, onMounted, ref } from 'vue';
import { api, type ApiError, type CaseSummary, type DataRootInfo } from '../api';
import { t } from '../i18n/zh-TW';
import ErrorPanel from '../components/ErrorPanel.vue';

const loading = ref(true);
const error = ref<ApiError | null>(null);
const cases = ref<CaseSummary[]>([]);
const root = ref<DataRootInfo | null>(null);

const creating = ref(false);
const newName = ref('');
const newSeed = ref('');
const createError = ref<ApiError | null>(null);

const setupPath = ref('');
const needsSetup = computed(
  () =>
    error.value !== null &&
    (error.value.code === 'IO_POINTER_MISSING' || error.value.code === 'IO_POINTER_MALFORMED'),
);

const totals = computed(() => ({
  cases: cases.value.length,
  nodes: cases.value.reduce((n, c) => n + c.stats.itemCount + c.stats.entityCount, 0),
  pending: cases.value.reduce((n, c) => n + c.stats.pendingNamedEdgeCount, 0),
}));

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  const r = await api.dataRoot();
  if (!r.ok) {
    root.value = null;
    error.value = r.error;
    loading.value = false;
    return;
  }
  root.value = r.data;

  const list = await api.cases();
  if (list.ok) cases.value = list.data;
  else error.value = list.error;
  loading.value = false;
}

async function submitSetup(): Promise<void> {
  if (setupPath.value.trim().length === 0) return;
  const r = await api.setDataRoot(setupPath.value.trim());
  if (r.ok) await load();
  else error.value = r.error;
}

async function submitCreate(): Promise<void> {
  createError.value = null;
  const r = await api.createCase(
    newName.value,
    newSeed.value.trim().length > 0 ? newSeed.value.trim() : undefined,
  );
  if (!r.ok) {
    createError.value = r.error;
    return;
  }
  creating.value = false;
  newName.value = '';
  newSeed.value = '';
  await load();
}

function when(ms: number | null): string {
  return ms === null ? t.caseList.never : new Date(ms).toLocaleDateString('zh-Hant');
}

onMounted(load);
</script>

<template>
  <main class="page">
    <header class="head">
      <h1>{{ t.caseList.title }}</h1>
      <div class="head-actions">
        <button class="primary" :disabled="root === null" @click="creating = true">
          {{ t.caseList.newCase }}
        </button>
      </div>
    </header>
    <p class="hint">{{ t.caseList.hint }}</p>

    <p v-if="loading" class="muted">{{ t.common.loading }}</p>

    <!-- 第一次啟動：先決定資料放哪裡 -->
    <section v-else-if="needsSetup" class="setup">
      <h2>{{ t.setup.title }}</h2>
      <p class="muted">{{ t.setup.body }}</p>
      <ErrorPanel :error="error!" />
      <label class="field">
        <span>{{ t.setup.pathLabel }}</span>
        <input v-model="setupPath" type="text" @keyup.enter="submitSetup" />
      </label>
      <button class="primary" :disabled="setupPath.trim().length === 0" @click="submitSetup">
        {{ t.setup.submit }}
      </button>
    </section>

    <ErrorPanel v-else-if="error" :error="error" retryable @retry="load" />

    <!-- 空狀態：要說明這個工具是什麼，因為這是第一次看到的畫面 -->
    <section v-else-if="cases.length === 0" class="empty">
      <h2>{{ t.caseList.empty.title }}</h2>
      <p class="muted">{{ t.caseList.empty.body }}</p>
      <button class="primary" @click="creating = true">{{ t.caseList.empty.cta }}</button>
      <p class="muted small">
        {{ t.caseList.empty.willCreateIn }} <code class="mono">{{ root?.dataRoot }}</code>
      </p>
    </section>

    <template v-else>
      <div class="stats">
        <div>
          <b>{{ totals.cases }}</b
          ><span>{{ t.caseList.stats.cases }}</span>
        </div>
        <div>
          <b>{{ totals.nodes.toLocaleString() }}</b
          ><span>{{ t.caseList.stats.nodes }}</span>
        </div>
        <div>
          <b>{{ totals.pending.toLocaleString() }}</b
          ><span>{{ t.caseList.stats.pending }}</span>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>{{ t.caseList.columns.name }}</th>
            <th>{{ t.caseList.columns.status }}</th>
            <th class="num">{{ t.caseList.columns.items }}</th>
            <th class="num">{{ t.caseList.columns.entities }}</th>
            <th class="num">{{ t.caseList.columns.edges }}</th>
            <th class="num">{{ t.caseList.columns.pending }}</th>
            <th>{{ t.caseList.columns.lastRun }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in cases" :key="c.slug">
            <td>
              <div class="name">{{ c.name }}</div>
              <div v-if="c.seed" class="muted small">{{ c.seed }}</div>
            </td>
            <td>{{ t.caseStatus[c.status] }}</td>
            <td class="num">{{ c.stats.itemCount.toLocaleString() }}</td>
            <td class="num">{{ c.stats.entityCount.toLocaleString() }}</td>
            <td class="num">{{ c.stats.edgeCount.toLocaleString() }}</td>
            <td class="num pending">{{ c.stats.pendingNamedEdgeCount.toLocaleString() }}</td>
            <td>{{ when(c.stats.lastRunAt) }}</td>
          </tr>
        </tbody>
      </table>

      <p class="muted small">
        {{ t.caseList.rootIs }} <code class="mono">{{ root?.dataRoot }}</code
        >{{ t.caseList.rootChangeable }}
      </p>
    </template>

    <!-- 新增專題：只要一個名稱，三次點擊以內 -->
    <div v-if="creating" class="modal" @click.self="creating = false">
      <div class="dialog">
        <h2>{{ t.createCase.title }}</h2>
        <label class="field">
          <span>{{ t.createCase.nameLabel }}</span>
          <input
            v-model="newName"
            type="text"
            :placeholder="t.createCase.namePlaceholder"
            @keyup.enter="submitCreate"
          />
        </label>
        <label class="field">
          <span>{{ t.createCase.seedLabel }}</span>
          <input v-model="newSeed" type="text" :placeholder="t.createCase.seedPlaceholder" />
        </label>
        <ErrorPanel v-if="createError" :error="createError" />
        <div class="dialog-actions">
          <button @click="creating = false">{{ t.createCase.cancel }}</button>
          <button class="primary" :disabled="newName.trim().length === 0" @click="submitCreate">
            {{ t.createCase.submit }}
          </button>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.page {
  padding: 22px 26px;
  max-width: 1200px;
  margin: 0 auto;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h1 {
  font-size: 19px;
  margin: 0;
}
h2 {
  font-size: 16px;
  margin: 0 0 8px;
}
.hint {
  color: var(--text-muted);
  font-size: 13px;
  margin: 4px 0 20px;
}
.muted {
  color: var(--text-muted);
}
.small {
  font-size: 12px;
}
.stats {
  display: flex;
  gap: 28px;
  padding: 14px 18px;
  background: var(--bg-panel);
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius-lg);
  margin-bottom: 18px;
}
.stats div {
  display: flex;
  flex-direction: column;
}
.stats b {
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.stats span {
  color: var(--text-muted);
  font-size: 12px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  text-align: left;
  padding: 9px 12px;
  border-bottom: 1px solid var(--line-subtle);
}
th {
  color: var(--text-muted);
  font-weight: 500;
  font-size: 12px;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pending {
  color: var(--edge-pending);
}
.name {
  font-weight: 500;
}
.empty,
.setup {
  border: 1px solid var(--line-subtle);
  background: var(--bg-panel);
  border-radius: var(--radius-lg);
  padding: 28px;
  max-width: 640px;
}
.empty > *,
.setup > * {
  margin-bottom: 12px;
}
.field {
  display: block;
  margin: 12px 0;
}
.field span {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 5px;
}
.modal {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 0.55);
  display: grid;
  place-items: center;
}
.dialog {
  background: var(--bg-panel);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  padding: 22px 24px;
  width: min(520px, 92vw);
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
