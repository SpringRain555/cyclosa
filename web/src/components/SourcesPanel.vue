<script setup lang="ts">
/**
 * 來源網站清單。
 *
 * ## 這一頁最重要的一欄是「依據」
 *
 * 「讀得到／要登入」是一個判斷，而**判斷的可信度取決於它從哪來**：
 * 「依你抓過的 12 次」與「依一次檢查」是兩件差很多的事，
 * 而它們如果長得一樣，使用者就會把後者當成前者。
 *
 * ## 檢查按鈕會送出真的請求，所以按鈕旁邊寫著它的規矩
 *
 * 這個工具對外的行為（robots、同網域間隔、429 退避重試）是一個承諾，
 * 而**一顆會連外的按鈕不該讓人按下去才知道它做了什麼**。
 *
 * ## 兩條軸：表照「類型」分組，「領域」當篩選
 *
 * 2026-09-16 清單從 22 列長到 39 列（資安那一批），之後跨領域還會再長。
 * 類型是固定的一組、驅動行為（出版社沒探針、API 才有探針），所以它當分組；
 * 領域是自由多值標籤（一個來源可以同時是資安與資訊科學），所以它當篩選 chips。
 * 一棵樹會逼每一列只能待在一個地方。
 *
 * chips 上的詞是**從清單本身長出來的**（每一列的 `fields` 聯集），不是另一份清單 ——
 * 內建的列用的詞彙就是建議詞彙，使用者加的詞會自己出現在 chips 上。
 *
 * ## 編輯與刪除
 *
 * 後端從 v0.7.0 就是整列 upsert ＋ DELETE，畫面在 v0.20.0 之前只接了「關掉」與「新增」。
 * 內建的列按刪除只會關掉（刪了下次升級又回來），**畫面上要說同一句話**。
 */
import { computed, onMounted, ref } from 'vue';

import { api, type ApiError, type SourceRow } from '../api';
import { fill, t } from '../i18n/zh-TW';
import ErrorPanel from './ErrorPanel.vue';

const rows = ref<SourceRow[]>([]);
const error = ref<ApiError | null>(null);
const checking = ref(false);
const busyHost = ref<string | null>(null);

/** 類型與型別的選項就是 i18n 那兩張表的鍵 —— 守門測試釘著它們跟程式那一組一致。 */
const CATEGORY_OPTIONS = Object.keys(t.sources.category) as (keyof typeof t.sources.category)[];
const KIND_OPTIONS = Object.keys(t.sources.kind) as (keyof typeof t.sources.kind)[];

function categoryText(category: string): string {
  return t.sources.category[category as keyof typeof t.sources.category] ?? category;
}

// ── 讀 ────────────────────────────────────────────────────

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

// ── 篩選 ──────────────────────────────────────────────────

const query = ref('');
const pickedFields = ref<Set<string>>(new Set());
const onlyEnabled = ref(false);

/** chips 上的詞：清單裡每一列的領域聯集，照第一次出現的順序（內建的在前）。 */
const allFields = computed(() => {
  const seen = new Set<string>();
  for (const row of rows.value) for (const f of row.fields) seen.add(f);
  return [...seen];
});

function toggleField(field: string): void {
  const next = new Set(pickedFields.value);
  if (next.has(field)) next.delete(field);
  else next.add(field);
  pickedFields.value = next;
}

function matches(row: SourceRow): boolean {
  if (onlyEnabled.value && !row.enabled) return false;
  if (pickedFields.value.size > 0 && !row.fields.some((f) => pickedFields.value.has(f))) {
    return false;
  }
  const q = query.value.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    row.nameZh.toLowerCase().includes(q) ||
    row.host.includes(q) ||
    row.noteZh.toLowerCase().includes(q)
  );
}

/**
 * 分組：照類型，順序跟 i18n 那張表一樣；組內維持伺服器給的順序（抓過多的在前）。
 * **從紀錄長出來的列**（`discovered`）的類型是填的不是知道的，所以它們自成一組排最後。
 */
const groups = computed(() => {
  const visible = rows.value.filter(matches);
  const out: { key: string; label: string; rows: SourceRow[] }[] = [];
  for (const category of CATEGORY_OPTIONS) {
    const inGroup = visible.filter((r) => !r.discovered && r.category === category);
    if (inGroup.length > 0)
      out.push({ key: category, label: categoryText(category), rows: inGroup });
  }
  const discovered = visible.filter((r) => r.discovered);
  if (discovered.length > 0) {
    out.push({ key: 'discovered', label: t.sources.groupDiscovered, rows: discovered });
  }
  return out;
});

const visibleCount = computed(() => groups.value.reduce((n, g) => n + g.rows.length, 0));
const enabledCount = computed(() => rows.value.filter((r) => r.enabled).length);

// ── 檢查 ──────────────────────────────────────────────────

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
  const r = await api.saveSource({ host: row.host, enabled: !row.enabled });
  busyHost.value = null;
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  apply(r.data);
}

// ── 編輯 ──────────────────────────────────────────────────

interface Draft {
  host: string;
  nameZh: string;
  kind: SourceRow['kind'];
  category: string;
  /** 逗號分隔的一串；存的時候才切。**輸入框裡不即時切**，不然打到一半的逗號會跳。 */
  fieldsText: string;
  probe: string;
  noteZh: string;
}

const editing = ref<Draft | null>(null);

function splitFields(text: string): string[] {
  const seen = new Set<string>();
  for (const piece of text.split(/[,，、]/)) {
    const trimmed = piece.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

function startEdit(row: SourceRow): void {
  editing.value = {
    host: row.host,
    nameZh: row.nameZh,
    kind: row.kind,
    category: row.category,
    fieldsText: row.fields.join(', '),
    probe: row.probe ?? '',
    noteZh: row.noteZh,
  };
}

function cancelEdit(): void {
  editing.value = null;
}

async function saveEdit(): Promise<void> {
  const draft = editing.value;
  if (draft === null) return;
  busyHost.value = draft.host;
  const r = await api.saveSource({
    host: draft.host,
    nameZh: draft.nameZh.trim().length > 0 ? draft.nameZh.trim() : draft.host,
    kind: draft.kind,
    category: draft.category,
    fields: splitFields(draft.fieldsText),
    probe: draft.probe.trim().length > 0 ? draft.probe.trim() : null,
    noteZh: draft.noteZh.trim(),
  });
  busyHost.value = null;
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  editing.value = null;
  apply(r.data);
}

/**
 * 刪除。**內建的列不會被刪，只會被關掉** —— 那是後端的行為，畫面要先說。
 * 使用者自己加的列才真的從清單上消失；抓過的紀錄還在（它會以「從紀錄長出來的」身分回來）。
 */
async function remove(row: SourceRow): Promise<void> {
  if (row.builtIn) {
    window.alert(t.sources.removeBuiltIn);
    return;
  }
  if (!window.confirm(fill(t.sources.removeConfirm, { name: row.nameZh }))) return;
  busyHost.value = row.host;
  const r = await api.removeSource(row.host);
  busyHost.value = null;
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  if (editing.value?.host === row.host) editing.value = null;
  apply(r.data);
}

// ── 新增 ──────────────────────────────────────────────────

const newHost = ref('');
const newName = ref('');
const newKind = ref<SourceRow['kind']>('site');
const newCategory = ref<string>('reference');
const newFields = ref('');
const newProbe = ref('');
const newNote = ref('');

async function add(): Promise<void> {
  const host = newHost.value.trim();
  if (host.length === 0) return;
  const r = await api.saveSource({
    host,
    nameZh: newName.value.trim().length > 0 ? newName.value.trim() : host,
    kind: newKind.value,
    category: newCategory.value,
    fields: splitFields(newFields.value),
    probe: newProbe.value.trim().length > 0 ? newProbe.value.trim() : null,
    noteZh: newNote.value.trim(),
    enabled: true,
  });
  if (!r.ok) {
    error.value = r.error;
    return;
  }
  newHost.value = '';
  newName.value = '';
  newFields.value = '';
  newProbe.value = '';
  newNote.value = '';
  apply(r.data);
}

// ── 顯示 ──────────────────────────────────────────────────

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
</script>

<template>
  <section class="sources">
    <p class="intro">{{ t.sources.intro }}</p>
    <p class="intro">{{ t.sources.maintain }}</p>
    <ErrorPanel v-if="error" :error="error" />

    <div class="toolbar">
      <button :disabled="checking" @click="checkAll">
        {{ checking ? t.sources.checking : t.sources.check }}
      </button>
      <span class="hint">{{ t.sources.checkNote }}</span>
    </div>

    <!-- 篩選列：搜尋 ＋ 領域 chips ＋ 只看打開的。chips 的詞從清單本身長出來。 -->
    <div class="filters">
      <input v-model="query" type="search" class="search" :placeholder="t.sources.search" />
      <label class="only">
        <input v-model="onlyEnabled" type="checkbox" />
        {{ t.sources.onlyEnabled }}
      </label>
      <div class="chips" role="group" :aria-label="t.sources.fieldsLabel">
        <button
          type="button"
          class="chip"
          :class="{ on: pickedFields.size === 0 }"
          @click="pickedFields = new Set()"
        >
          {{ t.sources.fieldsAll }}
        </button>
        <button
          v-for="field in allFields"
          :key="field"
          type="button"
          class="chip"
          :class="{ on: pickedFields.has(field) }"
          @click="toggleField(field)"
        >
          {{ field }}
        </button>
      </div>
    </div>

    <p v-if="rows.length === 0" class="muted">{{ t.sources.empty }}</p>
    <p v-else-if="groups.length === 0" class="muted">{{ t.sources.noMatch }}</p>

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
      <tbody v-for="group in groups" :key="group.key">
        <tr class="group">
          <th colspan="5">
            {{ group.label }}
            <span class="group-n">{{ fill(t.sources.groupCount, { n: group.rows.length }) }}</span>
          </th>
        </tr>
        <template v-for="row in group.rows" :key="row.host">
          <tr :class="{ off: !row.enabled }">
            <td>
              <div class="name">
                {{ row.nameZh }}
                <!-- 從抓取紀錄長出來的那幾列，型別與分類是填的不是知道的 ——
                     **顯示一個猜的分類會讓它看起來像被整理過。** -->
                <template v-if="!row.discovered">
                  <span class="tag">{{ t.sources.kind[row.kind] }}</span>
                  <span v-for="field in row.fields" :key="field" class="tag field">{{
                    field
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
              <button
                v-if="!row.discovered"
                :disabled="busyHost !== null || editing?.host === row.host"
                @click="startEdit(row)"
              >
                {{ t.sources.edit }}
              </button>
              <!-- 內建的列也有這顆，按下去說「只會關掉」—— 不給的話使用者會去找它。 -->
              <button v-if="!row.discovered" :disabled="busyHost !== null" @click="remove(row)">
                {{ t.sources.remove }}
              </button>
            </td>
          </tr>

          <!-- 就地展開的編輯列。同一時間只開一列。 -->
          <tr v-if="editing !== null && editing.host === row.host" class="editor">
            <td colspan="5">
              <form class="edit-form" @submit.prevent="saveEdit">
                <label>
                  <span>{{ t.sources.fieldName }}</span>
                  <input v-model="editing.nameZh" type="text" />
                </label>
                <label>
                  <span>{{ t.sources.fieldKind }}</span>
                  <select v-model="editing.kind">
                    <option v-for="kind in KIND_OPTIONS" :key="kind" :value="kind">
                      {{ t.sources.kind[kind] }}
                    </option>
                  </select>
                </label>
                <label>
                  <span>{{ t.sources.fieldCategory }}</span>
                  <select v-model="editing.category">
                    <option v-for="category in CATEGORY_OPTIONS" :key="category" :value="category">
                      {{ t.sources.category[category] }}
                    </option>
                  </select>
                </label>
                <label class="wide">
                  <span>{{ t.sources.fieldFields }}</span>
                  <input v-model="editing.fieldsText" type="text" list="source-fields" />
                </label>
                <label class="wide">
                  <span>{{ t.sources.fieldProbe }}</span>
                  <input v-model="editing.probe" type="url" />
                </label>
                <label class="wide">
                  <span>{{ t.sources.fieldNote }}</span>
                  <input v-model="editing.noteZh" type="text" />
                </label>
                <div class="edit-actions">
                  <button type="submit" :disabled="busyHost !== null">{{ t.sources.save }}</button>
                  <button type="button" :disabled="busyHost !== null" @click="cancelEdit">
                    {{ t.sources.cancel }}
                  </button>
                </div>
              </form>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <p class="muted count">
      {{
        fill(t.sources.countLine, {
          visible: visibleCount,
          total: rows.length,
          enabled: enabledCount,
        })
      }}
    </p>

    <!-- 領域的建議詞彙：就是清單裡已經在用的那些。 -->
    <datalist id="source-fields">
      <option v-for="field in allFields" :key="field" :value="field" />
    </datalist>

    <form class="add" @submit.prevent="add">
      <h3>{{ t.sources.addTitle }}</h3>
      <div class="fields">
        <input v-model="newHost" type="text" :placeholder="t.sources.addHost" />
        <input v-model="newName" type="text" :placeholder="t.sources.addName" />
        <select v-model="newKind" :aria-label="t.sources.fieldKind">
          <option v-for="kind in KIND_OPTIONS" :key="kind" :value="kind">
            {{ t.sources.kind[kind] }}
          </option>
        </select>
        <select v-model="newCategory" :aria-label="t.sources.fieldCategory">
          <option v-for="category in CATEGORY_OPTIONS" :key="category" :value="category">
            {{ t.sources.category[category] }}
          </option>
        </select>
        <input
          v-model="newFields"
          type="text"
          list="source-fields"
          :placeholder="t.sources.fieldFields"
        />
        <input v-model="newProbe" type="text" :placeholder="t.sources.addProbe" />
        <input v-model="newNote" type="text" :placeholder="t.sources.fieldNote" />
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

.toolbar,
.filters {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.search {
  min-width: 220px;
}

.only {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.only input {
  min-width: 0;
}

.chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

/* chips 的「選到」用選取青的外框 —— 跟圖上「選取」同一個意思（ADR-0018）。 */
.chip {
  border-radius: 999px;
  padding: 2px 10px;
}

.chip.on {
  border-color: var(--ring-selected);
  color: var(--text);
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

tr.group th {
  padding-top: 14px;
  color: var(--text-secondary);
  font-weight: 600;
  border-bottom: 1px solid var(--line);
}

.group-n {
  margin-left: 8px;
  font-weight: 400;
  color: var(--text-muted);
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

/* 領域標籤跟型別標籤的差別靠形狀不靠顏色：圓角一邊、實線。 */
.tag.field {
  border-radius: 999px;
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
  flex-wrap: wrap;
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

tr.editor td {
  background: var(--bg-raised);
}

.edit-form {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 12px;
}

.edit-form label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--text-tertiary);
  min-width: 0;
}

.edit-form label.wide {
  grid-column: 1 / -1;
}

.edit-form input,
.edit-form select {
  min-width: 0;
  width: 100%;
}

.edit-actions {
  grid-column: 1 / -1;
  display: flex;
  gap: 6px;
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

input,
select {
  font: inherit;
  font-size: 13px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-app);
  color: var(--text);
  min-width: 160px;
}

@media (max-width: 720px) {
  .edit-form {
    grid-template-columns: 1fr;
  }
}
</style>
