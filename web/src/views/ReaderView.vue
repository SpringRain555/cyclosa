<script setup lang="ts">
/**
 * 閱讀器。**這一頁回答：「這份到底寫了什麼，而我能不能信它」**（ui-workflows）。
 *
 * ## 正文為什麼是純文字段落，不是重構後的 HTML
 *
 * 抓回來的 HTML 是**外部輸入**，而這一頁跑在 `127.0.0.1:7433` ——
 * 跟 API 同一個 origin。把它 `v-html` 進來，那份頁面的腳本就能打我們的 API。
 * Readability 會拿掉 `<script>`，但它不是消毒器，也沒有宣稱自己是。
 *
 * 要顯示完整排版得先引一個消毒器（DOMPurify 之類），而那是一個要查授權、
 * 要驗、要維護的新依賴 —— **是一個獨立的決定，不是這一階段順手做的事**。
 * 在那之前：正文顯示純文字段落，而**「看原始快照」給的是完整的原件**
 * （那一條走 `sandbox` ＋ CSP，在瀏覽器層隔離）。
 *
 * ## PDF 有兩種檢視（v0.24.1）
 *
 * 「**版面**」用 pdf.js 照原檔畫（`components/pdf/PdfPages.vue`）—— 圖與公式只有這裡看得到；
 * 「**文字**」是抽出來重排過的正文（v0.24.0 的那一種），窄畫面好讀、沒有圖。
 * **點註兩邊通用**：兩邊選到的都換算成同一種錨點（頁碼 ＋ 頁內區間，ADR-0019）。
 * 預設是版面；使用者切過一次，這台機器上記得（只是偏好，讀不到就回預設）。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api, type DerivedPayload, type Item, type ItemDetail, type ResolvedNote } from '../api';
import { fill, t } from '../i18n/zh-TW';
import ErrorPanel from '../components/ErrorPanel.vue';
import LowConfidenceBadge from '../components/LowConfidenceBadge.vue';
import NotesPanel from '../components/NotesPanel.vue';
import PdfPages from '../components/pdf/PdfPages.vue';

const route = useRoute();
const router = useRouter();

const slug = computed(() => String(route.params['slug'] ?? ''));
const itemId = computed(() => {
  const raw = route.params['itemId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
});

const list = ref<Item[]>([]);
const nextCursor = ref<string | null>(null);
const sort = ref<'recent' | 'title'>('recent');
const filter = ref<'all' | 'low' | 'unread'>('all');
const listError = ref<import('../api').ApiError | null>(null);

const detail = ref<ItemDetail | null>(null);
const derived = ref<DerivedPayload | null>(null);
const detailError = ref<import('../api').ApiError | null>(null);
/** 這份正文是舊版抽取器抽的 —— 要說出來，不然使用者以為重排壞了。 */
const stale = ref(false);
const loading = ref(false);

function query(cursor?: string): Record<string, string> {
  const q: Record<string, string> = { sort: sort.value, limit: '50' };
  if (cursor !== undefined) q['cursor'] = cursor;
  if (filter.value === 'low') q['low'] = '1';
  if (filter.value === 'unread') q['unread'] = '1';
  return q;
}

async function loadList(append = false): Promise<void> {
  const result = await api.items(
    slug.value,
    query(append ? (nextCursor.value ?? undefined) : undefined),
  );
  if (!result.ok) {
    listError.value = result.error;
    return;
  }
  listError.value = null;
  list.value = append ? [...list.value, ...result.data.items] : result.data.items;
  nextCursor.value = result.data.nextCursor;
}

async function loadDetail(): Promise<void> {
  const id = itemId.value;
  detail.value = null;
  derived.value = null;
  detailError.value = null;
  stale.value = false;
  if (id === null) return;

  loading.value = true;
  const [meta, content] = await Promise.all([
    api.item(slug.value, id),
    api.itemContent(slug.value, id),
  ]);
  loading.value = false;

  if (!meta.ok) {
    detailError.value = meta.error;
    return;
  }
  detail.value = meta.data;
  if (content.ok) {
    derived.value = content.data.derived;
    stale.value = content.data.stale;
  }

  // **開起來就是讀過了。** 已讀是正交旗標，不是狀態轉移 —— 它不影響管線。
  if (meta.data.item.readAt === null) {
    const marked = await api.markRead(slug.value, id, true);
    if (marked.ok) {
      const row = list.value.find((i) => i.id === id);
      if (row !== undefined) row.readAt = marked.data;
    }
  }
}

watch([slug, sort, filter], () => void loadList(), { immediate: true });

function open(id: string): void {
  void router.push(`/case/${encodeURIComponent(slug.value)}/reader/${encodeURIComponent(id)}`);
}

interface Para {
  readonly text: string;
  /** 這一段的第一個字在 `sourceText` 裡的位置。 */
  readonly start: number;
}

/**
 * 切段落，**而且記得每一段從第幾個字開始**。
 *
 * 之前這裡是 `split` 加 `trim` —— 好讀，但它把位置資訊丟了，
 * 而點註要的正是那個位置。用 `exec` 走一遍是因為 `split` 不告訴你
 * 分隔符號有多長，**而少算一個換行就會讓那一段之後的錨點全部偏移一格**。
 */
function splitParagraphs(text: string): readonly Para[] {
  const out: Para[] = [];
  const sep = /\n{2,}/g;
  let at = 0;

  const push = (chunk: string, from: number): void => {
    const lead = chunk.length - chunk.trimStart().length;
    const trimmed = chunk.trim();
    if (trimmed.length > 0) out.push({ text: trimmed, start: from + lead });
  };

  let m: RegExpExecArray | null;
  while ((m = sep.exec(text)) !== null) {
    push(text.slice(at, m.index), at);
    at = m.index + m[0].length;
  }
  push(text.slice(at), at);
  return out;
}

/**
 * 正文，按「頁」分塊。**PDF 整份連續捲動**（v0.24.0），每一頁一個 `<section data-page>`，
 * 前面一條「第 n 頁」—— 點註仍然錨在「頁碼 ＋ 頁內字元區間」（ADR-0019），
 * 所以每一頁的 `data-start` 是相對於那一頁的文字，不是整份。
 * 網頁與純文字只有一塊，`page` 是 `null`。
 */
interface PageBlock {
  readonly page: number | null;
  readonly text: string;
  readonly paragraphs: readonly Para[];
}
const blocks = computed<readonly PageBlock[]>(() => {
  const d = derived.value;
  if (d === null) return [];
  if (d.kind === 'pdf' && d.pages !== null) {
    return d.pages.map((text, i) => ({ page: i + 1, text, paragraphs: splitParagraphs(text) }));
  }
  return [{ page: null, text: d.text, paragraphs: splitParagraphs(d.text) }];
});
const hasContent = computed(() => blocks.value.some((b) => b.paragraphs.length > 0));
function textOfPage(page: number | null): string {
  return blocks.value.find((b) => b.page === page)?.text ?? '';
}

// ── PDF 的兩種檢視（v0.24.1）────────────────────────────
type PdfView = 'layout' | 'text';
const VIEW_KEY = 'cyclosa.reader.pdfView';
/** 偏好存在這個瀏覽器裡；讀不到（無痕、被擋）就回預設 —— 它只是方便，不是資料。 */
function readView(): PdfView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'text' ? 'text' : 'layout';
  } catch {
    return 'layout';
  }
}
const pdfView = ref<PdfView>(readView());
function setView(view: PdfView): void {
  pdfView.value = view;
  selectionNote.value = null;
  clearPending();
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // 存不了就只在這一次有效。
  }
}
/** 這一份能不能畫版面：是 PDF，而且快照在（版面是從快照畫的，不是從正文）。 */
const isPdf = computed(
  () => derived.value?.kind === 'pdf' && (detail.value?.item.sha256 ?? null) !== null,
);
const layoutMode = computed(() => isPdf.value && pdfView.value === 'layout');
const pdfPages = ref<InstanceType<typeof PdfPages> | null>(null);

function onLayoutSelect(selection: {
  start: number;
  end: number;
  page: number;
  preview: string;
}): void {
  pendingRect.value = null;
  pending.value = selection;
}

// ── 點註────────────────────────────────────────

const notes = ref<ResolvedNote[]>([]);
/** 剛選好、還沒存的那一段。**存了才是點註。** */
const pending = ref<{ start: number; end: number; page: number | null; preview: string } | null>(
  null,
);
const pendingRect = ref<{ x: number; y: number; w: number; h: number } | null>(null);
/** 「在正文裡找到它」按下去之後暫時提亮的那一則。 */
const locatedId = ref<string | null>(null);
/** 選取跨了兩頁：做不成點註，說一句。 */
const selectionNote = ref<string | null>(null);
const textPane = ref<HTMLElement | null>(null);
const imageEl = ref<HTMLImageElement | null>(null);

const isImage = computed(() => detail.value?.item.kind === 'image');

async function loadNotes(): Promise<void> {
  const id = itemId.value;
  if (id === null) {
    notes.value = [];
    return;
  }
  const result = await api.itemNotes(slug.value, id);
  if (result.ok) notes.value = [...result.data];
}

function clearPending(): void {
  pending.value = null;
  pendingRect.value = null;
}

/**
 * 把 DOM 的選取換算成**這一屏文字的字元區間**。
 *
 * 走 `TreeWalker` 加總前面每個文字節點的長度，而不是直接用
 * `range.startOffset` —— 因為已經有點註的段落會被切成好幾個
 * `<span>`，那時候 `startOffset` 是相對於某一個 span 的，不是整段的。
 * **那個差別只在「同一段裡標第二則」的時候才會顯現**，也就是最容易漏測的路徑。
 */
function offsetWithin(root: Element, node: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  while (walker.nextNode()) {
    if (walker.currentNode === node) return total + offset;
    total += (walker.currentNode.textContent ?? '').length;
  }
  return total;
}

function paragraphOf(node: Node): HTMLElement | null {
  const start = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  return start?.closest<HTMLElement>('[data-start]') ?? null;
}

/** 這一段在哪一頁。網頁與純文字沒有頁，回 `null`。 */
function pageOf(para: HTMLElement): number | null {
  const raw = para.closest<HTMLElement>('[data-page]')?.dataset['page'];
  return raw === undefined ? null : Number(raw);
}

function onSelect(): void {
  selectionNote.value = null;
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;

  const range = selection.getRangeAt(0);
  const from = paragraphOf(range.startContainer);
  const to = paragraphOf(range.endContainer);
  if (from === null || to === null) return;

  // **跨頁的選取做不成點註**：錨點是「頁碼 ＋ 頁內區間」，一則點註只能在一頁上（ADR-0019）。
  const page = pageOf(from);
  if (page !== pageOf(to)) {
    selectionNote.value = t.reader.crossPage;
    return;
  }

  const start =
    Number(from.dataset['start']) + offsetWithin(from, range.startContainer, range.startOffset);
  const end = Number(to.dataset['start']) + offsetWithin(to, range.endContainer, range.endOffset);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return;

  pendingRect.value = null;
  pending.value = { start, end, page, preview: textOfPage(page).slice(start, end) };
}

/**
 * 這一段裡要標起來的部分。
 *
 * 只算**解得出位置**的點註 —— `not-found` 的那幾則在右邊那一欄裡有它們自己的
 * 位置，而在正文上畫一段「其實不知道在哪」的高亮正好是 ADR-0010 第 5 條
 * 明寫不能做的事。
 */
interface Segment {
  readonly text: string;
  readonly noteId: string | null;
}

function segmentsOf(para: Para, page: number | null): readonly Segment[] {
  const paraEnd = para.start + para.text.length;
  const spans = notes.value
    .map((n) =>
      n.hit.kind === 'exact' || n.hit.kind === 'shifted' ? { id: n.note.id, ...n.hit } : null,
    )
    .filter(
      (
        h,
      ): h is {
        id: string;
        kind: 'exact' | 'shifted';
        start: number;
        end: number;
        page: number | null;
      } => h !== null,
    )
    .filter((h) => h.page === page)
    .filter((h) => h.end > para.start && h.start < paraEnd)
    .sort((a, b) => a.start - b.start);

  if (spans.length === 0) return [{ text: para.text, noteId: null }];

  const out: Segment[] = [];
  let cursor = para.start;
  for (const span of spans) {
    const from = Math.max(cursor, span.start);
    const to = Math.min(paraEnd, span.end);
    if (to <= from) continue;
    if (from > cursor)
      out.push({ text: para.text.slice(cursor - para.start, from - para.start), noteId: null });
    out.push({ text: para.text.slice(from - para.start, to - para.start), noteId: span.id });
    cursor = to;
  }
  if (cursor < paraEnd) out.push({ text: para.text.slice(cursor - para.start), noteId: null });
  return out;
}

function locate(note: ResolvedNote): void {
  if (note.hit.kind === 'rect' || note.hit.kind === 'not-found') return;
  // 整份連續捲動：不用翻頁，直接捲到那一則。
  locatedId.value = note.note.id;
  if (layoutMode.value) {
    void pdfPages.value?.scrollToNote(note.note.id);
    return;
  }
  void nextTick(() => {
    const mark = textPane.value?.querySelector(`[data-note="${note.note.id}"]`);
    mark?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

// ── 圖片上框一塊 ──────────────────────────────────────────

const dragFrom = ref<{ x: number; y: number } | null>(null);

/**
 * 螢幕座標換成**快照原尺寸的像素座標**。
 *
 * 存的是 `pixel:` 不是 `percent:`（ADR-0019），所以縮放比例只在這裡出現一次 ——
 * 存進去的數字對那一份不可變的快照永遠有效，跟畫面多大無關。
 */
function toPixels(event: MouseEvent): { x: number; y: number } | null {
  const img = imageEl.value;
  if (img === null || img.clientWidth === 0 || img.naturalWidth === 0) return null;
  const box = img.getBoundingClientRect();
  const scale = img.naturalWidth / box.width;
  return {
    x: Math.round((event.clientX - box.left) * scale),
    y: Math.round((event.clientY - box.top) * scale),
  };
}

function rectStart(event: MouseEvent): void {
  const at = toPixels(event);
  if (at === null) return;
  event.preventDefault();
  dragFrom.value = at;
  pendingRect.value = null;
}

function rectMove(event: MouseEvent): void {
  const from = dragFrom.value;
  if (from === null) return;
  const at = toPixels(event);
  if (at === null) return;
  pendingRect.value = {
    x: Math.min(from.x, at.x),
    y: Math.min(from.y, at.y),
    w: Math.abs(at.x - from.x),
    h: Math.abs(at.y - from.y),
  };
}

function rectEnd(): void {
  dragFrom.value = null;
  // 點一下（不是拖）不算框選 —— 一個 0×0 的矩形不是使用者的意思。
  if (pendingRect.value !== null && (pendingRect.value.w < 2 || pendingRect.value.h < 2)) {
    pendingRect.value = null;
  }
}

/** 把快照像素座標換回畫面座標，用來畫既有點註的框。 */
function rectStyle(rect: { x: number; y: number; w: number; h: number }): Record<string, string> {
  const img = imageEl.value;
  if (img === null || img.naturalWidth === 0) return { display: 'none' };
  const scale = img.clientWidth / img.naturalWidth;
  return {
    left: `${String(rect.x * scale)}px`,
    top: `${String(rect.y * scale)}px`,
    width: `${String(rect.w * scale)}px`,
    height: `${String(rect.h * scale)}px`,
  };
}

const imageRects = computed(() =>
  notes.value
    .map((n) => (n.hit.kind === 'rect' ? { id: n.note.id, rect: n.hit.rect } : null))
    .filter(
      (r): r is { id: string; rect: { x: number; y: number; w: number; h: number } } => r !== null,
    ),
);

/**
 * 換一份資料就重新載入。
 *
 * **這個 watch 必須在點註那幾個 `ref` 之後宣告** —— 它是 `immediate` 的，
 * 所以它在 setup 期間就會跑一次，而那時候宣告在它下面的 `const` 還在
 * 暫時死區裡。放錯位置的症狀不是紅字，是**右邊那一欄永遠停在
 * 「從左邊選一份來讀」** —— Vue 把 watcher 裡的例外吞掉並記到 console，
 * 而畫面上完全看不出有東西壞了。2026-09-08 第一次開起來就是這樣。
 */
watch(
  itemId,
  () => {
    clearPending();
    locatedId.value = null;
    selectionNote.value = null;
    void loadDetail();
    void loadNotes();
  },
  { immediate: true },
);

/**
 * 來源是不是一個網址。**檔案匯入的來源是檔名**（`source_url` 記的是「這些位元組實際從哪來」），
 * 做成連結的話會指到這個 app 自己的一個不存在的頁面。
 */
const WEB_URL = /^https?:\/\//i;
const sourceIsUrl = computed(() => WEB_URL.test(detail.value?.item.sourceUrl ?? ''));

/**
 * 你上傳的那一份是替哪個網址拿的（研究的「對回候選上傳」，R10）：來源是檔名、
 * 而 `requested_url` 是一個網址。**出處指得回那個網址**，研究的紀錄刪掉之後也一樣。
 */
const uploadedFor = computed(() => {
  const item = detail.value?.item;
  if (item === undefined || item.requestedUrl === null || sourceIsUrl.value) return null;
  return WEB_URL.test(item.requestedUrl) ? item.requestedUrl : null;
});

const snapshotUrl = computed(() =>
  detail.value === null ? '' : api.snapshotUrl(slug.value, detail.value.item.id),
);

function humanSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function when(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toLocaleString('zh-Hant');
}

async function act(action: 'exclude' | 'restore' | 'retry'): Promise<void> {
  const id = itemId.value;
  if (id === null) return;
  const result = await api.itemAction(slug.value, id, action);
  if (!result.ok) {
    detailError.value = result.error;
    return;
  }
  await loadList();
  await loadDetail();
}
</script>

<template>
  <main :class="['reader', { layout: layoutMode }]">
    <aside class="list">
      <header class="list-head">
        <h2>{{ t.reader.listTitle }}</h2>
        <div class="controls">
          <select v-model="sort" :aria-label="t.reader.sortRecent">
            <option value="recent">{{ t.reader.sortRecent }}</option>
            <option value="title">{{ t.reader.sortTitle }}</option>
          </select>
          <select v-model="filter" :aria-label="t.reader.filterAll">
            <option value="all">{{ t.reader.filterAll }}</option>
            <option value="low">{{ t.reader.filterLowConfidence }}</option>
            <option value="unread">{{ t.reader.filterUnread }}</option>
          </select>
        </div>
      </header>

      <ErrorPanel v-if="listError" :error="listError" retryable @retry="loadList()" />
      <p v-else-if="list.length === 0" class="muted empty">{{ t.reader.empty }}</p>

      <ul v-else class="rows">
        <li v-for="row in list" :key="row.id">
          <button
            class="row"
            :class="{ active: row.id === itemId, read: row.readAt !== null }"
            @click="open(row.id)"
          >
            <span class="row-title">{{ row.title }}</span>
            <span class="row-meta">
              <span class="kind">{{ row.kind }}</span>
              <span v-if="row.status !== 'included'" class="status">
                {{ t.itemStatus[row.status] }}
              </span>
              <LowConfidenceBadge
                v-if="row.lowConfidence"
                compact
                :reasons="row.lowConfidenceReasons"
              />
            </span>
          </button>
        </li>
      </ul>

      <button v-if="nextCursor" class="more" @click="loadList(true)">
        {{ t.reader.loadMore }}
      </button>
    </aside>

    <section class="pane">
      <p v-if="loading" class="muted">{{ t.common.loading }}</p>
      <ErrorPanel v-else-if="detailError" :error="detailError" />
      <p v-else-if="detail === null" class="muted pick">{{ t.reader.pickOne }}</p>

      <article v-else :class="{ wide: layoutMode }">
        <header class="doc-head">
          <p class="position">
            {{
              fill(t.reader.position, {
                index: detail.position.index,
                total: detail.position.total,
              })
            }}
          </p>
          <h1>{{ detail.item.title }}</h1>
          <!-- 研究的候選還沒確認（D8）：可以先讀，但確認之前不會從它抽任何關聯。 -->
          <p v-if="detail.candidacy" class="callout pending candidacy">
            {{ fill(t.reader.candidateOf, { topic: detail.candidacy.topic }) }}
          </p>

          <!-- 表頭資料一列一組，不逐行（v0.24.0）：來源那一格可能很長，放最後、可以縮。 -->
          <dl class="facts-row">
            <div v-if="detail.item.fetchedAt" class="fact">
              <dt>{{ t.reader.fetchedAt }}</dt>
              <dd>{{ when(detail.item.fetchedAt) }}</dd>
            </div>
            <div class="fact">
              <dt>{{ t.reader.language }}</dt>
              <dd>
                {{ detail.item.lang === 'und' ? t.reader.unknownLanguage : detail.item.lang }}
              </dd>
            </div>
            <div v-if="detail.item.byteSize" class="fact">
              <dt>{{ t.reader.size }}</dt>
              <dd>{{ humanSize(detail.item.byteSize) }}</dd>
            </div>
            <div v-if="derived?.kind === 'pdf' && derived.pages" class="fact">
              <dt>{{ t.reader.pageCount }}</dt>
              <dd>{{ derived.pages.length }}</dd>
            </div>
            <div v-if="detail.item.sourceUrl" class="fact source">
              <dt>{{ t.reader.source }}</dt>
              <dd>
                <a
                  v-if="sourceIsUrl"
                  :href="detail.item.sourceUrl"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {{ detail.item.sourceUrl }}
                </a>
                <template v-else>{{ detail.item.sourceUrl }}</template>
              </dd>
            </div>
            <div v-if="uploadedFor" class="fact source">
              <dt>{{ t.reader.uploadedFor }}</dt>
              <dd>
                <a :href="uploadedFor" target="_blank" rel="noreferrer noopener">
                  {{ uploadedFor }}
                </a>
              </dd>
            </div>
          </dl>

          <div class="actions">
            <a
              v-if="detail.item.sha256"
              class="btn"
              :href="snapshotUrl"
              target="_blank"
              rel="noreferrer noopener"
            >
              {{ t.reader.openSnapshot }}
            </a>
            <!-- **原文／繁中切換要有譯文才有意義。** 這一版沒有翻譯，
                 所以按鈕是關的，而旁邊寫著為什麼 —— 不是一個按了沒反應的按鈕。 -->
            <button disabled>{{ t.reader.translated }}</button>
            <span class="muted note">{{ t.reader.noTranslation }}</span>
          </div>

          <div class="actions">
            <button v-if="detail.item.status === 'excluded'" @click="act('restore')">
              {{ t.reader.restore }}
            </button>
            <button v-else @click="act('exclude')">{{ t.reader.exclude }}</button>
            <button
              v-if="detail.item.status === 'failed' && detail.item.requestedUrl"
              @click="act('retry')"
            >
              {{ t.reader.retry }}
            </button>
          </div>

          <!-- PDF 的兩種檢視（v0.24.1）：版面照原檔畫（圖、公式都在），文字是重排過的正文。 -->
          <div v-if="isPdf" class="view-switch" role="group" :aria-label="t.reader.viewLabel">
            <span class="tabs">
              <button
                type="button"
                :class="{ on: pdfView === 'layout' }"
                :aria-pressed="pdfView === 'layout'"
                @click="setView('layout')"
              >
                {{ t.reader.viewLayout }}
              </button>
              <button
                type="button"
                :class="{ on: pdfView === 'text' }"
                :aria-pressed="pdfView === 'text'"
                @click="setView('text')"
              >
                {{ t.reader.viewText }}
              </button>
            </span>
            <span class="muted note">{{
              pdfView === 'layout' ? t.reader.viewLayoutWhat : t.reader.viewTextWhat
            }}</span>
          </div>
        </header>

        <p v-if="detail.item.status === 'excluded'" class="notice">{{ t.reader.excluded }}</p>
        <p v-if="detail.item.status === 'failed'" class="notice">{{ t.reader.failedNotice }}</p>

        <LowConfidenceBadge
          v-if="detail.item.lowConfidence"
          :reasons="detail.item.lowConfidenceReasons"
        />

        <div v-if="detail.item.kind === 'image'" class="image-wrap">
          <p class="muted">{{ t.reader.imageOnly }}</p>
          <!-- 框選：按住拖曳。**座標存的是快照的原尺寸像素**，跟畫面多大無關。 -->
          <div
            class="canvas"
            @mousedown="rectStart"
            @mousemove="rectMove"
            @mouseup="rectEnd"
            @mouseleave="rectEnd"
          >
            <img ref="imageEl" :src="snapshotUrl" :alt="detail.item.title" draggable="false" />
            <span
              v-for="r in imageRects"
              :key="r.id"
              class="rect"
              :class="{ located: r.id === locatedId }"
              :style="rectStyle(r.rect)"
            ></span>
            <span v-if="pendingRect" class="rect pending" :style="rectStyle(pendingRect)"></span>
          </div>
        </div>

        <template v-else-if="derived && layoutMode">
          <p v-if="selectionNote" class="callout pending">{{ selectionNote }}</p>
          <PdfPages
            ref="pdfPages"
            :key="detail.item.id"
            :src="snapshotUrl"
            :page-texts="derived.pages ?? []"
            :notes="notes"
            :located-id="locatedId"
            :pending="pending"
            @select="onLayoutSelect"
            @notice="selectionNote = $event"
          />
        </template>

        <template v-else-if="derived">
          <!-- 舊版抽取器抽的正文：讀得到，但要說 —— 不然使用者以為重排壞了。 -->
          <p v-if="stale" class="callout">{{ t.reader.staleDerived }}</p>
          <p v-if="selectionNote" class="callout pending">{{ selectionNote }}</p>

          <p v-if="!hasContent" class="muted">{{ t.reader.noContent }}</p>
          <!--
            **PDF 整份連續捲動**，每一頁一個區塊、前面一條「第 n 頁」。
            v0.23.0 之前一次一頁、翻頁鈕 —— 而使用者要的是整份往下讀。
            `data-start` 是選取換算的依據（相對於那一頁），`@mouseup` 是它的觸發點。
          -->
          <div v-else ref="textPane" class="body-text" @mouseup="onSelect">
            <section
              v-for="block in blocks"
              :key="block.page ?? 0"
              class="page-block"
              :data-page="block.page ?? undefined"
            >
              <div v-if="block.page !== null" class="page-mark">
                <span>{{ fill(t.reader.page, { n: block.page }) }}</span>
              </div>
              <p v-for="p in block.paragraphs" :key="p.start" class="para" :data-start="p.start">
                <template v-for="(seg, j) in segmentsOf(p, block.page)" :key="j">
                  <mark
                    v-if="seg.noteId"
                    class="hl"
                    :class="{ located: seg.noteId === locatedId }"
                    :data-note="seg.noteId"
                    >{{ seg.text }}</mark
                  >
                  <template v-else>{{ seg.text }}</template>
                </template>
              </p>
            </section>
          </div>
        </template>

        <p v-else class="muted">{{ t.reader.noContent }}</p>

        <nav class="neighbours">
          <button
            :disabled="!detail.neighbours.previous"
            @click="open(detail.neighbours.previous!)"
          >
            {{ t.reader.previous }}
          </button>
          <button :disabled="!detail.neighbours.next" @click="open(detail.neighbours.next!)">
            {{ t.reader.next }}
          </button>
        </nav>
      </article>
    </section>

    <NotesPanel
      v-if="detail"
      :slug="slug"
      :item-id="detail.item.id"
      :notes="notes"
      :pending="pending"
      :pending-rect="pendingRect"
      :is-image="isImage"
      @changed="loadNotes()"
      @cancel="clearPending()"
      @locate="locate"
    />
  </main>
</template>

<style scoped>
/**
 * 三欄：清單 · 正文 · 點註。**點註不是彈出視窗** —— 它跟正文一直在同一屏上，
 * 因為「我標了什麼」與「原文寫了什麼」要能互相對照。
 *
 * 寬度：正文那一欄至少要 40ch（release-checklist D10 第四個數字）。
 * 1000px 以下三欄放不下 —— 2026-09-19 量到 768px 時中間只剩 140px、14ch，900px 時 37ch ——
 * 所以點註欄改到正文底下，清單縮成 180px。
 */
.reader {
  display: grid;
  grid-template-columns: minmax(180px, 220px) minmax(0, 1fr) minmax(240px, 300px);
  height: 100%;
  min-height: 0;
}
@media (max-width: 999px) {
  .reader {
    grid-template-columns: minmax(150px, 180px) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }
  /* 點註欄（NotesPanel 的根元素）橫跨底下一整列，最多佔四成高度。 */
  .reader > .notes {
    grid-column: 1 / -1;
    border-left: 0;
    border-top: 1px solid var(--line-subtle);
    max-height: 40vh;
    overflow-y: auto;
  }
}

/**
 * **PDF 的版面檢視要的是寬度**：一頁論文畫在 440px 寬（1024 寬的三欄）裡，字不到 10px。
 * 所以版面檢視在 1280px 以下就把點註欄移到底下 —— 跟文字檢視 1000px 以下同一個形狀。
 */
@media (max-width: 1279px) {
  .reader.layout {
    grid-template-columns: minmax(150px, 180px) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }
  .reader.layout > .notes {
    grid-column: 1 / -1;
    border-left: 0;
    border-top: 1px solid var(--line-subtle);
    max-height: 40vh;
    overflow-y: auto;
  }
}

/**
 * 正文：**16px、行高 1.7、最寬 68ch**。行長 50–75 個拉丁字母、中文約 40 字是閱讀的
 * 舒適範圍（`ui-workflows.md` 三條跨頁規則），68ch 是中英混排的折衷。
 * 選取要順手，所以這一塊不做任何 user-select 的限制。
 */
.body-text {
  min-width: 0;
  max-width: 68ch;
  font-size: var(--fs-reading);
  line-height: 1.7;
}
.page-block {
  margin: 0;
}
/* 頁與頁之間一條線、中間寫「第 n 頁」。它是版面不是正文，所以不在 .para 裡。 */
.page-mark {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 28px 0 16px;
  color: var(--text-muted);
  font-size: var(--fs-label);
  user-select: none;
}
.page-block:first-child .page-mark {
  margin-top: 4px;
}
.page-mark::before,
.page-mark::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--line-subtle);
}
.para {
  margin: 0 0 1em;
  white-space: pre-wrap;
}

/* 點註的高亮：暖色底 ＋ 底線。**底線是第二重編碼**（ADR-0018 規則 2）——
   色盲的使用者看不出那個底色，但看得出那條線。 */
.hl {
  background: color-mix(in srgb, var(--node-note) 22%, transparent);
  border-bottom: 1px solid var(--node-note);
  color: inherit;
  padding: 0 1px;
}
.hl.located {
  background: color-mix(in srgb, var(--node-note) 42%, transparent);
}

.canvas {
  position: relative;
  display: inline-block;
  cursor: crosshair;
  user-select: none;
}
.canvas img {
  display: block;
  max-width: 100%;
}
.rect {
  position: absolute;
  border: 2px solid var(--node-note);
  background: color-mix(in srgb, var(--node-note) 12%, transparent);
  pointer-events: none;
}
.rect.located {
  background: color-mix(in srgb, var(--node-note) 30%, transparent);
}
/* 框選中的那一個用虛線，跟已經存下來的分得開。 */
.rect.pending {
  border-style: dashed;
  border-color: var(--ui-selected);
  background: color-mix(in srgb, var(--ui-selected) 12%, transparent);
}

/* ── 左欄：清單 ── */
.list {
  border-right: 1px solid var(--line-subtle);
  overflow-y: auto;
  padding: 12px;
  background: var(--bg-panel);
  min-width: 0;
}
.list-head h2 {
  font-size: var(--fs-body);
  margin: 0 0 8px;
}
/* 兩個下拉選單：欄夠寬就並排，不夠就各佔一行 —— 900px 寬時擠在一起，字壓到箭頭上。
   右邊留給箭頭的那一段不能省（base.css 的 select 本來就留了）。 */
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.controls select {
  flex: 1 1 90px;
  min-width: 0;
  padding: 5px 24px 5px 8px;
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
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
/* 已讀＝灰色內環的平面版：左邊一條灰線。**明暗不表示程度**，這是狀態不是深淺。 */
.row.read {
  border-left: 3px solid var(--ring-read);
}
.row-title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  font-size: var(--fs-label);
  color: var(--text-muted);
}
.status {
  color: var(--edge-pending);
}
.more {
  width: 100%;
  margin-top: 10px;
}

/* ── 中欄：正文 ── */
.pane {
  /* 版面檢視的工具列要抵掉這一格才貼得住頂（PdfPages.vue）。 */
  --pane-pad-top: 24px;
  overflow-y: auto;
  padding: var(--pane-pad-top) 32px 60px;
  min-width: 0;
}
.pane article {
  max-width: 80ch;
}
/* 版面檢視：頁面自己決定寬度（適合寬度，最寬 1000px），不受閱讀欄的 80ch 限制。 */
.pane article.wide {
  max-width: none;
}
.view-switch {
  display: flex;
  align-items: center;
  gap: var(--s3);
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.position {
  color: var(--text-muted);
  font-size: var(--fs-label);
  margin: 0;
}
.doc-head h1 {
  margin: 4px 0 12px;
  line-height: 1.4;
}
/* 表頭一列一組：時間 · 語言 · 大小 · 頁數 · 來源。來源最長，放最後，可以縮。 */
.facts-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  margin: 0 0 14px;
  font-size: var(--fs-label);
}
.fact {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.fact dt {
  color: var(--text-muted);
  white-space: nowrap;
}
.fact dd {
  margin: 0;
  color: var(--text-secondary);
}
.fact.source {
  flex: 1 1 100%;
}
.fact.source dd {
  overflow-wrap: anywhere;
}
.actions {
  margin-bottom: 10px;
}
.note {
  font-size: var(--fs-label);
}
.notice {
  border-left: 3px solid var(--edge-pending);
  padding: 8px 12px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  border-radius: var(--radius);
}
.image-wrap img {
  max-width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.neighbours {
  display: flex;
  gap: 8px;
  margin-top: 32px;
  padding-top: 16px;
  border-top: 1px solid var(--line-subtle);
}
.empty,
.pick {
  font-size: var(--fs-small);
}
</style>
