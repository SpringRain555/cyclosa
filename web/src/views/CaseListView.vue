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
import { api, type ApiError, type CaseDeletion, type CaseSummary, type DataRootInfo } from '../api';
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

/**
 * 全部標成未讀。
 *
 * **二次確認的門在伺服器端**：第一次呼叫只回「有幾份標著已讀」，
 * 什麼都不改；帶了 `force` 才真的清。只做在畫面上的話它是一個繞得過的提醒，
 * 而這件事沒有回頭路 —— 哪幾份讀過是使用者累積出來的資訊。
 *
 * 確認那句話要說出**三件事**：數字、回不去、以及那個副作用
 * （已讀是「復原」用來判斷「人動過這一份」的訊號之一）。
 */
const unreadBusy = ref(false);
const unreadNote = ref<string | null>(null);

async function clearAllRead(): Promise<void> {
  const c = selected.value;
  if (c === null) return;
  unreadBusy.value = true;
  unreadNote.value = null;
  const probe = await api.clearAllRead(c.slug, false);
  if (!probe.ok) {
    unreadBusy.value = false;
    renameError.value = probe.error;
    return;
  }
  if (probe.data.read === 0) {
    unreadBusy.value = false;
    unreadNote.value = t.caseList.unreadNone;
    return;
  }
  if (!window.confirm(fill(t.caseList.unreadConfirm, { n: probe.data.read, name: c.name }))) {
    unreadBusy.value = false;
    return;
  }
  const done = await api.clearAllRead(c.slug, true);
  unreadBusy.value = false;
  if (!done.ok) {
    renameError.value = done.error;
    return;
  }
  unreadNote.value = fill(t.caseList.unreadDone, { n: done.data.cleared });
}

/**
 * 封存與重新開啟。**這一支 API 從 v0.1.0 就在，而在這之前零個呼叫點** ——
 * 一個沒有按鈕的狀態轉移，使用者永遠到不了那個狀態。
 */
const statusBusy = ref(false);

async function toggleArchive(): Promise<void> {
  const c = selected.value;
  if (c === null) return;
  const action = c.status === 'archived' ? 'reopen' : 'archive';
  statusBusy.value = true;
  const r = await api.setCaseStatus(c.slug, action);
  statusBusy.value = false;
  if (!r.ok) {
    renameError.value = r.error;
    return;
  }
  unreadNote.value = fill(action === 'archive' ? t.caseList.archiveDone : t.caseList.reopenDone, {
    name: c.name,
  });
  await load();
}

/**
 * 刪除專題。
 *
 * **不是 `window.confirm`** —— 這一顆要求逐字打對名稱，而那需要一個輸入框。
 * 「全部標成未讀」用一次確認就夠，因為它清掉的是關於**你**的標記；
 * 這一顆清掉的是**蒐集來的東西本身**。兩者的後果不在同一個量級。
 *
 * 第一段（`confirmName: null`）只問「會失去什麼」，一個檔都不動 ——
 * 對話框上那些數字就是那一次回來的。
 */
const deleting = ref<CaseDeletion | null>(null);
const deleteTyped = ref('');
const deleteBusy = ref(false);

/** 打對了才給按。**伺服器端也會再比一次** —— 這裡只是讓那顆鍵不要看起來可按。 */
const deleteArmed = computed(
  () => deleting.value !== null && deleteTyped.value.trim() === deleting.value.name,
);

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

async function startDelete(): Promise<void> {
  const c = selected.value;
  if (c === null) return;
  deleteBusy.value = true;
  renameError.value = null;
  const probe = await api.deleteCase(c.slug, null);
  deleteBusy.value = false;
  if (!probe.ok) {
    renameError.value = probe.error;
    return;
  }
  deleteTyped.value = '';
  deleting.value = probe.data;
}

function cancelDelete(): void {
  deleting.value = null;
  deleteTyped.value = '';
}

async function confirmDelete(): Promise<void> {
  const c = selected.value;
  if (c === null || !deleteArmed.value) return;
  deleteBusy.value = true;
  const r = await api.deleteCase(c.slug, deleteTyped.value.trim());
  deleteBusy.value = false;
  if (!r.ok) {
    renameError.value = r.error;
    return;
  }
  deleting.value = null;
  deleteTyped.value = '';
  // **選取要清掉** —— 那個專題不在了，操作列不能繼續指著它。
  pickedSlug.value = null;
  unreadNote.value = fill(t.caseList.delDone, { name: r.data.name, to: r.data.movedTo ?? '' });
  await load();
}

function when(ms: number | null): string {
  return ms === null ? t.caseList.never : new Date(ms).toLocaleDateString('zh-Hant');
}

onMounted(load);
</script>

<template>
  <!-- 表格頁，用寬的那一種頁寬（base.css：1200）。 -->
  <main class="page wide">
    <header class="page-head">
      <h1>{{ t.caseList.title }}</h1>
      <button class="primary" :disabled="root === null" @click="creating = true">
        {{ t.caseList.newCase }}
      </button>
    </header>
    <p class="page-lead">{{ t.caseList.hint }}</p>

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
        <button v-if="selected && !renaming" type="button" class="quiet small" @click="clearPick">
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
            <button type="submit" class="small" :disabled="renameBusy">
              {{ t.caseList.renameSave }}
            </button>
            <button type="button" class="small" :disabled="renameBusy" @click="cancelRename">
              {{ t.caseList.renameCancel }}
            </button>
          </form>
        </template>
        <template v-else>
          <button type="button" class="small" :disabled="selected === null" @click="startRename">
            {{ t.caseList.rename }}
          </button>
          <!--
            **全部標成未讀。** 二次確認的門在伺服器端 ——
            第一次呼叫只回「有幾份標著已讀」，帶了 force 才真的清。
            這件事沒有回頭路：哪幾份讀過是使用者累積出來的資訊。
          -->
          <button
            type="button"
            class="small"
            :disabled="selected === null || unreadBusy"
            @click="clearAllRead"
          >
            {{ t.caseList.unreadAll }}
          </button>
          <!--
            **封存／重新開啟。** 這一支 API 從 v0.1.0 就在，
            而在 v0.17.0 之前**零個呼叫點** —— 一個沒有按鈕的狀態轉移，
            使用者永遠到不了那個狀態。
          -->
          <button
            type="button"
            class="small"
            :disabled="selected === null || statusBusy"
            @click="toggleArchive"
          >
            {{ selected?.status === 'archived' ? t.caseList.reopen : t.caseList.archive }}
          </button>
          <!--
            **刪除不是 window.confirm。** 它要求逐字打對名稱，所以需要一個輸入框；
            而那個比對**在伺服器端也會再做一次**。
          -->
          <button
            type="button"
            class="danger small"
            :disabled="selected === null || deleteBusy"
            @click="startDelete"
          >
            {{ t.caseList.del }}
          </button>
          <RouterLink
            v-if="selected"
            class="btn small"
            :to="`/case/${encodeURIComponent(selected.slug)}/runs`"
          >
            {{ t.caseList.columns.open }}
          </RouterLink>
          <button v-else type="button" class="small" disabled>
            {{ t.caseList.columns.open }}
          </button>
          <RouterLink
            v-if="selected"
            class="btn small"
            :to="`/case/${encodeURIComponent(selected.slug)}`"
          >
            {{ t.caseList.openGraph }}
          </RouterLink>
          <button v-else type="button" class="small" disabled>{{ t.caseList.openGraph }}</button>
        </template>
      </div>

      <!-- **資料夾會跟著改，按下去之前就要知道。** -->
      <p v-if="renaming" class="muted small">{{ t.caseList.renameHint }}</p>
      <p v-if="unreadNote" class="muted small">{{ unreadNote }}</p>
      <ErrorPanel v-if="renameError" :error="renameError" />

      <table class="table clickable case-table">
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

    <!--
      **刪除專題。** 這個對話框的工作是讓使用者在按下去之前看見四件事：
      會失去什麼、佔多大、資料夾搬去哪、以及**磁碟空間不會變多**。

      最後那一件最容易漏，而漏掉的後果是使用者刪了一個 4 GB 的專題、
      去看硬碟、發現一點都沒空出來 —— 然後不知道該相信哪一句話。

      點外面**不會**關掉它（沒有 `@click.self`）—— 一個正在打字的確認框
      被誤點關掉，使用者要從頭再來一次。
    -->
    <div v-if="deleting" class="modal">
      <div class="dialog danger-dialog">
        <h2>{{ fill(t.caseList.delTitle, { name: deleting.name }) }}</h2>
        <p>
          {{
            fill(t.caseList.delLose, {
              items: deleting.stats.itemCount.toLocaleString(),
              notes: deleting.stats.noteCount.toLocaleString(),
              entities: deleting.stats.entityCount.toLocaleString(),
              edges: deleting.stats.edgeCount.toLocaleString(),
            })
          }}
        </p>
        <p>{{ fill(t.caseList.delSize, { size: humanBytes(deleting.bytes) }) }}</p>
        <p class="muted small">{{ t.caseList.delMoved }}</p>
        <p class="muted small">{{ t.caseList.delSpace }}</p>
        <label class="field">
          <span>{{ t.caseList.delTypeName }}</span>
          <input
            v-model="deleteTyped"
            type="text"
            :placeholder="deleting.name"
            :disabled="deleteBusy"
          />
        </label>
        <div class="dialog-actions">
          <button :disabled="deleteBusy" @click="cancelDelete">{{ t.caseList.delCancel }}</button>
          <button class="danger" :disabled="!deleteArmed || deleteBusy" @click="confirmDelete">
            {{ t.caseList.delConfirm }}
          </button>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
/* 頁寬、標題、表格、表單、按鈕都在 base.css；這裡只有這一頁自己的東西。 */
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
  font-size: var(--fs-title);
  font-variant-numeric: tabular-nums;
}
.stats span {
  color: var(--text-muted);
  font-size: var(--fs-label);
}
.pending {
  color: var(--edge-pending);
}
.name {
  color: var(--text);
  font-weight: 500;
}

/* 操作列：**沒選的時候還在，只是按鈕是關的。**
   整條消失的話，使用者不會知道有這些操作存在。 */
.actions {
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
  font-size: var(--fs-label);
  color: var(--text-tertiary);
}
.actions.armed .picked-name {
  color: var(--text-secondary);
}
.spacer {
  flex: 1;
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
/* 改名的輸入框在一列裡，不是表單欄位 —— 不吃 base.css 的 100% 寬。 */
.rename input {
  width: auto;
  min-width: 180px;
  padding: 4px 8px;
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
  font-size: var(--fs-small);
}
.pointer-note code {
  word-break: break-all;
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
.dialog h2 {
  margin-bottom: 12px;
}
/* 刪除對話框：**上緣一條紅線**，而不是整片紅底。
   那條線的工作是讓人在打字之前先知道自己在哪一個對話框裡。 */
.danger-dialog {
  border-top: 2px solid var(--ui-danger);
}
.danger-dialog p {
  margin: 6px 0;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

/*
 * **窄畫面不從字中間斷**（2026-10-02 D10 截圖看到的）：768 寬時「實體」「關聯」「已就緒」都被拆成兩行。
 * 表頭與名稱以外的欄不換行，寬度的壓力全給專題名稱那一欄 —— 它本來就是會換行的那一格。
 */
.case-table th,
.case-table td:not(:first-child) {
  white-space: nowrap;
}
</style>
