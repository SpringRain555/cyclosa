<script setup lang="ts">
/**
 * 一份資料上的點註清單 ＋ 註記框。
 *
 * ## 註記框固定在這一欄，不是浮在選取的文字旁邊
 *
 * 浮動泡泡在文字上看起來比較高級，而它有三個要處理的情況：
 * 選取跨段落、選到畫面邊緣、以及圖片上的框選（那時候根本沒有「選取的文字」）。
 * **固定的那一欄三種情況都是同一段程式。**
 *
 * ## 錨點狀態一定配文字，不是只有顏色
 *
 * 「對得上／位置移動過／找不到原文位置」三種在畫面上都有一行字說明
 * （ADR-0018 規則 2：每個狀態都有第二重編碼）。
 * 尤其是第三種 —— **「內容還在」是使用者最需要立刻知道的一句**。
 */
import { computed, ref, watch } from 'vue';

import { api, type ApiError, type ResolvedNote } from '../api';
import { fill, t } from '../i18n/zh-TW';
import ErrorPanel from './ErrorPanel.vue';

const props = defineProps<{
  slug: string;
  itemId: string;
  notes: readonly ResolvedNote[];
  /** 目前選到的位置。**文字是字元區間，圖片是矩形。** */
  pending: { start: number; end: number; page: number | null; preview: string } | null;
  pendingRect: { x: number; y: number; w: number; h: number } | null;
  isImage: boolean;
}>();

const emit = defineEmits<{
  changed: [];
  cancel: [];
  locate: [note: ResolvedNote];
}>();

const body = ref('');
const saving = ref(false);
const error = ref<ApiError | null>(null);
const editingId = ref<string | null>(null);

const hasPending = computed(() => props.pending !== null || props.pendingRect !== null);

// 換一份資料、或換一段選取，草稿就重來 —— **不要把上一段的字帶到下一段上。**
watch(
  () => [props.itemId, props.pending, props.pendingRect],
  () => {
    if (editingId.value === null) body.value = '';
    error.value = null;
  },
);

async function save(): Promise<void> {
  saving.value = true;
  error.value = null;

  const result =
    editingId.value !== null
      ? await api.updateNote(props.slug, editingId.value, body.value)
      : await api.createNote(props.slug, props.itemId, {
          body: body.value,
          ...(props.pendingRect !== null
            ? { rect: props.pendingRect }
            : {
                start: props.pending?.start ?? 0,
                end: props.pending?.end ?? 0,
                ...(props.pending?.page === null || props.pending?.page === undefined
                  ? {}
                  : { page: props.pending.page }),
              }),
        });

  saving.value = false;
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  body.value = '';
  editingId.value = null;
  emit('changed');
  emit('cancel');
}

function startEdit(note: ResolvedNote): void {
  editingId.value = note.note.id;
  body.value = note.note.body;
}

function cancel(): void {
  editingId.value = null;
  body.value = '';
  error.value = null;
  emit('cancel');
}

async function remove(note: ResolvedNote): Promise<void> {
  // **刪之前要說出順便拿掉幾條線** —— 那是按下去才發現就太遲的事，
  // 而使用者手動確認過的關聯是這個工具裡最貴的東西。
  const message =
    note.edgeCount > 0
      ? fill(t.notes.confirmDelete, { n: note.edgeCount })
      : t.notes.confirmDeleteNoEdge;
  if (!window.confirm(message)) return;

  const result = await api.deleteNote(props.slug, note.note.id);
  if (!result.ok) {
    error.value = result.error;
    return;
  }
  emit('changed');
}

function anchorLabel(note: ResolvedNote): string {
  if (note.hit.kind === 'not-found') return t.notes.anchorMissing;
  if (note.hit.kind === 'shifted') return t.notes.anchorShifted;
  return t.notes.anchorExact;
}

function anchorWhy(note: ResolvedNote): string {
  if (note.hit.kind === 'not-found') return t.notes.anchorMissingWhy;
  if (note.hit.kind === 'shifted') return t.notes.anchorShiftedWhy;
  return '';
}

function placeLabel(note: ResolvedNote): string {
  if (note.hit.kind === 'rect') return t.notes.rect;
  if (note.hit.kind !== 'not-found' && note.hit.page !== null) {
    return fill(t.notes.onPage, { n: note.hit.page });
  }
  return '';
}

const unresolvedCount = computed(
  () => props.notes.filter((n) => n.hit.kind === 'not-found').length,
);
</script>

<template>
  <aside class="notes">
    <header>
      <h3>{{ t.notes.panelTitle }}</h3>
      <p class="muted count">
        {{ fill(t.notes.count, { n: notes.length })
        }}<template v-if="unresolvedCount > 0">
          · <span class="warn">{{ fill(t.notes.unresolved, { n: unresolvedCount }) }}</span>
        </template>
      </p>
    </header>

    <!-- 註記框：**選了東西才出現**。沒選的時候那裡是一句怎麼開始的話。 -->
    <form v-if="hasPending || editingId !== null" class="composer" @submit.prevent="save">
      <p v-if="pending" class="excerpt">
        <span class="muted">{{ t.notes.selected }}</span>
        <q>{{ pending.preview }}</q>
      </p>
      <p v-else-if="pendingRect" class="excerpt">
        <span class="muted">{{ t.notes.selected }}</span>
        <span class="mono">
          {{ pendingRect.x }}, {{ pendingRect.y }} · {{ pendingRect.w }}×{{ pendingRect.h }}
        </span>
      </p>

      <label>
        <span class="label">{{ t.notes.bodyLabel }}</span>
        <textarea v-model="body" rows="4" :placeholder="t.notes.bodyPlaceholder"></textarea>
      </label>

      <ErrorPanel v-if="error" :error="error" />

      <div class="row">
        <button type="submit" class="primary" :disabled="saving">{{ t.notes.save }}</button>
        <button type="button" @click="cancel">{{ t.notes.cancel }}</button>
      </div>
    </form>

    <p v-else class="muted hint">{{ isImage ? t.notes.emptyImage : t.notes.hint }}</p>

    <p v-if="notes.length === 0" class="muted empty">
      {{ isImage ? t.notes.emptyImage : t.notes.empty }}
    </p>

    <ul v-else class="rows">
      <li v-for="n in notes" :key="n.note.id" class="note">
        <blockquote v-if="n.quote" class="quote">{{ n.quote }}</blockquote>
        <p v-if="n.note.body" class="body">{{ n.note.body }}</p>

        <p class="anchor" :class="n.hit.kind">
          <!-- 記號在顏色之外：對得上是實心點，移動過是箭頭，找不到是打叉。 -->
          <span class="mark" aria-hidden="true">{{
            n.hit.kind === 'not-found' ? '×' : n.hit.kind === 'shifted' ? '→' : '·'
          }}</span>
          {{ anchorLabel(n) }}
          <span v-if="placeLabel(n)" class="muted">· {{ placeLabel(n) }}</span>
        </p>
        <p v-if="anchorWhy(n)" class="muted why">{{ anchorWhy(n) }}</p>

        <div class="row">
          <button v-if="n.hit.kind !== 'not-found' && !isImage" @click="emit('locate', n)">
            {{ t.notes.locate }}
          </button>
          <button @click="startEdit(n)">{{ t.notes.edit }}</button>
          <button @click="remove(n)">{{ t.notes.remove }}</button>
        </div>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.notes {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border-left: 1px solid var(--line-subtle);
  background: var(--bg-panel);
  min-width: 0;
}

h3 {
  margin: 0;
  font-size: 14px;
}

.count {
  margin: 4px 0 0;
  font-size: 12px;
}

.warn {
  color: var(--edge-pending);
}

.muted {
  color: var(--text-tertiary);
}

.hint,
.empty {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
}

.excerpt {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

.excerpt q {
  color: var(--text);
}

.mono {
  font-family: ui-monospace, monospace;
}

.label {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

textarea {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-app);
  color: var(--text);
  font: inherit;
  line-height: 1.6;
}

.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

button {
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--bg-raised);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

button:hover {
  background: var(--bg-hover);
}

/* 這一欄的按鈕比全域的小一號，所以整組要在這裡重寫一次 ——
   **而重寫的時候很容易只改一半**：只寫 `color: var(--ui-action)`
   就會得到藍底藍字，一個看得到形狀但讀不到字的按鈕。
   2026-09-08 第一次截圖就是那樣。 */
button.primary {
  background: var(--ui-action);
  border-color: var(--ui-action);
  color: var(--bg-app);
  font-weight: 600;
}

button.primary:hover:not(:disabled) {
  background: var(--ui-action);
  filter: brightness(1.08);
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
}

.note {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--line-subtle);
  /* 暖色的左邊界 ＝ 這是你自己寫的（ADR-0018 的那一對軸）。 */
  border-left: 3px solid var(--node-note);
  border-radius: var(--radius);
  background: var(--bg-raised);
}

.quote {
  margin: 0;
  padding-left: 8px;
  border-left: 2px solid var(--line-strong);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.body {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.anchor {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
}

.anchor.shifted {
  color: var(--edge-pending);
}

.anchor.not-found {
  color: var(--edge-pending);
}

.mark {
  display: inline-block;
  width: 1em;
  text-align: center;
}

.why {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
}
</style>
