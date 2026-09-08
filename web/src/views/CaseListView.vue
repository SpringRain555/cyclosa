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
import { useRouter } from 'vue-router';
import { api, type ApiError, type CaseSummary, type DataRootInfo } from '../api';
import { fill, t } from '../i18n/zh-TW';
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

// **第一次啟動不是「出了問題」。** 兩種情況的下一步都是「選一個資料夾」，
// 但成因完全不同：指標檔不存在是全新安裝的正常狀態，指標檔壞掉才是故障。
// 對前者顯示紅邊面板與識別碼，會讓一個順利的第一次啟動看起來像壞了
// （2026-09-07 使用者第一次手動驗收時就是這個反應）。
const isFirstRun = computed(() => error.value?.code === 'IO_POINTER_MISSING');
const pointerBroken = computed(() => error.value?.code === 'IO_POINTER_MALFORMED');
const needsSetup = computed(() => isFirstRun.value || pointerBroken.value);

// 指標檔的路徑在兩種情況下都要說 —— 差別只在用什麼語氣說。
const pointerPath = computed(() => {
  const v = error.value?.detail?.['pointerPath'];
  return typeof v === 'string' ? v : null;
});

const totals = computed(() => ({
  cases: cases.value.length,
  // **點註也是圖上的節點**（ADR-0010 第 4 條），所以它要算進來 ——
  // 而下面表格那一欄問的是「有幾份資料」，那一欄不算它。同一個數字兩種問法。
  nodes: cases.value.reduce(
    (n, c) => n + c.stats.itemCount + c.stats.noteCount + c.stats.entityCount,
    0,
  ),
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

/**
 * 選取一列。**單一專題的操作都掛在這個選取上**，不散在每一列。
 *
 * **點第二下就進關聯圖。** 那是這一頁最常見的下一步，而它原本要走兩步
 * （選一列、再按操作列上的「關聯圖」）。名稱本來是一個連到閱讀器的連結，
 * 現在拿掉了 —— 同一列有兩個目的地，按下去之前分不出會去哪一個。
 *
 * 「我不想選它了」改由操作列上的一顆小按鈕負責 ——
 * 原本靠「再點一次」取消選取，而那個位置現在拿去開關聯圖了。
 */
const router = useRouter();
const pickedSlug = ref<string | null>(null);
const selected = computed(() => cases.value.find((c) => c.slug === pickedSlug.value) ?? null);

function pick(slug: string): void {
  if (pickedSlug.value === slug) {
    void router.push(`/case/${encodeURIComponent(slug)}`);
    return;
  }
  pickedSlug.value = slug;
  renaming.value = false;
  renameError.value = null;
}

function clearPick(): void {
  pickedSlug.value = null;
  renaming.value = false;
  renameError.value = null;
}

const renaming = ref(false);
const renameName = ref('');
const renameBusy = ref(false);
const renameError = ref<ApiError | null>(null);

function startRename(): void {
  const c = selected.value;
  if (c === null) return;
  renaming.value = true;
  renameName.value = c.name;
  renameError.value = null;
}

function cancelRename(): void {
  renaming.value = false;
  renameError.value = null;
}

async function saveRename(): Promise<void> {
  const c = selected.value;
  const name = renameName.value.trim();
  if (c === null || name.length === 0) return;
  renameBusy.value = true;
  const r = await api.renameCase(c.slug, name);
  renameBusy.value = false;
  if (!r.ok) {
    renameError.value = r.error;
    return;
  }
  renaming.value = false;
  renameError.value = null;
  // **slug 換了，所以選取要跟著換** —— 不然操作列會指向一個不存在的專題。
  pickedSlug.value = r.data.slug;
  // 重讀整份清單，不要就地改那一列：排序是照「最後更新」的，那一列會換位置。
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
      <!-- 只有「指標檔壞掉」是故障，要給路徑與識別碼；第一次啟動不給故障面板 -->
      <ErrorPanel v-if="pointerBroken" :error="error!" />
      <p v-else-if="pointerPath" class="muted pointer-note">
        {{ t.setup.pointerNote }} <code class="mono">{{ pointerPath }}</code>
      </p>
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

      <!--
        **單一專題的操作集中在這一條，不散在每一列上。**

        散在列上的版本每加一個功能就多一欄，而每一列都重複一排按鈕 ——
        八列就是八排。集中之後表格只負責「有哪些專題、各自長什麼樣」，
        而「要對哪一個做什麼」是另一件事。

        沒選的時候這一條**還在**（只是按鈕是關的）——
        整條消失的話，使用者不會知道有這些操作存在。
      -->
      <div class="actions" :class="{ armed: selected !== null }">
        <span class="picked-name">{{
          selected === null ? t.caseList.pickHint : fill(t.caseList.picked, { name: selected.name })
        }}</span>
        <button v-if="selected && !renaming" type="button" class="clear" @click="clearPick">
          {{ t.caseList.clearPick }}
        </button>
        <span class="spacer"></span>

        <template v-if="renaming">
          <form class="rename" @submit.prevent="saveRename">
            <input
              v-model="renameName"
              type="text"
              :placeholder="t.caseList.renamePlaceholder"
              :disabled="renameBusy"
            />
            <button type="submit" :disabled="renameBusy">{{ t.caseList.renameSave }}</button>
            <button type="button" :disabled="renameBusy" @click="cancelRename">
              {{ t.caseList.renameCancel }}
            </button>
          </form>
        </template>
        <template v-else>
          <button type="button" :disabled="selected === null" @click="startRename">
            {{ t.caseList.rename }}
          </button>
          <RouterLink
            v-if="selected"
            class="act"
            :to="`/case/${encodeURIComponent(selected.slug)}/runs`"
          >
            {{ t.caseList.columns.open }}
          </RouterLink>
          <button v-else type="button" disabled>{{ t.caseList.columns.open }}</button>
          <RouterLink
            v-if="selected"
            class="act"
            :to="`/case/${encodeURIComponent(selected.slug)}`"
          >
            {{ t.caseList.openGraph }}
          </RouterLink>
          <button v-else type="button" disabled>{{ t.caseList.openGraph }}</button>
        </template>
      </div>

      <!-- **資料夾會跟著改，按下去之前就要知道。** -->
      <p v-if="renaming" class="muted small">{{ t.caseList.renameHint }}</p>
      <ErrorPanel v-if="renameError" :error="renameError" />

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
          <!--
            **整列可以點：第一下選取，第二下進關聯圖。**
            名字不是連結了 —— 一列上有兩個目的地的話，按下去之前分不出會去哪一個。
            進閱讀器改走頂列的分頁（關聯圖 │ 閱讀器 │ 作業紀錄）。
          -->
          <tr
            v-for="c in cases"
            :key="c.slug"
            :class="{ picked: pickedSlug === c.slug }"
            @click="pick(c.slug)"
          >
            <td>
              <span class="name">{{ c.name }}</span>
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
  color: var(--text);
  font-weight: 500;
}
.open {
  color: var(--ui-action);
  text-decoration: none;
  font-size: 13px;
}

/* 改名的入口**平常很輕** —— 它不是這一頁的主要動作，
   而一個跟「開啟」一樣顯眼的改名按鈕會讓人以為那是下一步。 */
/* 操作列：**沒選的時候還在，只是按鈕是關的。**
   整條消失的話，使用者不會知道有這些操作存在。 */
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  margin: 14px 0 4px;
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius);
  background: var(--bg-panel);
}
.actions.armed {
  border-color: var(--line);
}
.picked-name {
  font-size: 12px;
  color: var(--text-tertiary);
}
.actions.armed .picked-name {
  color: var(--text-secondary);
}
.spacer {
  flex: 1;
}
.actions button,
.actions .act {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
  color: var(--text-secondary);
  text-decoration: none;
  cursor: pointer;
}
.actions button:hover:not(:disabled),
.actions .act:hover {
  background: var(--bg-hover);
}
.actions button:disabled {
  opacity: 0.4;
  cursor: default;
}
/* 「取消選取」**不是一個操作，是收回一個選擇** —— 所以它比右邊那幾顆輕，
   而且沒選的時候它整顆不在（沒有東西可以收回）。 */
.actions button.clear {
  border-color: transparent;
  background: transparent;
  color: var(--text-tertiary);
  padding: 2px 6px;
}
.actions button.clear:hover {
  color: var(--text);
  background: var(--bg-hover);
}

tbody tr {
  cursor: pointer;
}
/* 選取用青色 —— 圖上「選取」就是這個顏色（ADR-0018），兩邊一致。 */
tbody tr.picked {
  background: var(--bg-raised);
  box-shadow: inset 2px 0 0 var(--ui-selected);
}

.rename {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.rename input {
  font: inherit;
  font-size: 13px;
  padding: 4px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-app);
  color: var(--text);
  min-width: 180px;
}
.rename button {
  font: inherit;
  font-size: 12px;
  padding: 4px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
  color: var(--text-secondary);
  cursor: pointer;
}
.rename button:hover:not(:disabled) {
  background: var(--bg-hover);
}
.rename button:disabled {
  opacity: 0.5;
  cursor: default;
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
.pointer-note {
  font-size: 13px;
}
.pointer-note code {
  word-break: break-all;
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
