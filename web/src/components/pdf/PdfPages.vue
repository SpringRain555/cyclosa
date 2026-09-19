<script setup lang="ts">
/**
 * PDF 的「版面」檢視（v0.24.1）：用 pdf.js 把原檔一頁一頁畫出來 —— 圖、公式、表格照原樣。
 *
 * ## 為什麼要有它
 *
 * 2026-09-19 使用者：「閱讀器無法顯示圖片，也無法正常顯示數學公式」。抽出來的正文本來就沒有圖，
 * 公式在文字層裡是一堆位置散開的字符 —— 重排救不了。實量那一份 35 頁的論文：7 頁上有 97 張
 * 點陣圖，另有十幾頁的圖是向量畫的（只抽點陣圖也不夠）。**忠實的做法只有一個：照原檔畫。**
 *
 * ## 點註照舊
 *
 * 畫好的頁面上疊一層 pdf.js 的文字層（透明的字），使用者在上面選字；選到的位置換算回
 * `derived/` 那一頁正文的字元區間（`@domain/annotation/layer-map`），**存的東西跟「文字」檢視
 * 一模一樣**（ADR-0019：頁碼 ＋ 頁內區間）。既有的點註用 CSS Custom Highlight API
 * 塗在文字層的字上 —— 不改 pdf.js 產生的 DOM。
 *
 * ## 安全
 *
 * PDF 是外部輸入。這裡只解析與繪製（解析在 worker 裡）：不開 scripting、不做 XFA 表單、
 * 不畫連結層 —— 讀論文時不小心點到一個外連網址，不該是會發生的事。
 *
 * ## 記憶體
 *
 * 一頁 canvas 在 1.5 倍像素比下是十幾 MB。**只畫看得到的那幾頁**（上下各多一段），
 * 捲出範圍的釋放；像素數也有上限（放大到很大時降解析度，不是吃掉幾百 MB）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from 'pdfjs-dist';

import { mapBetween, skeletonOf, type Skeleton } from '@domain/annotation/layer-map';
import type { ResolvedNote } from '../../api';
import { fill, t } from '../../i18n/zh-TW';
import { loadPdfjs, pdfjsAssetOptions, type Pdfjs } from './pdfjs';
import '../../styles/pdf-layer.css';

const props = defineProps<{
  /** 原始快照的網址（`/api/cases/:slug/items/:id/snapshot`）。 */
  src: string;
  /** `derived/` 的每一頁正文 —— 點註的字元區間是對它算的（ADR-0019）。 */
  pageTexts: readonly string[];
  notes: readonly ResolvedNote[];
  locatedId: string | null;
  /** 剛選好、還沒存的那一段（頁內區間）。 */
  pending: { start: number; end: number; page: number | null } | null;
}>();

const emit = defineEmits<{
  select: [selection: { start: number; end: number; page: number; preview: string }];
  /** 選取做不成點註的原因（跨頁、對不到正文）；`null` 是清掉上一句。 */
  notice: [text: string | null];
}>();

// ── 文件 ────────────────────────────────────────────────
interface Slot {
  readonly n: number;
  /** 縮放 1 時的寬高（CSS px；PDF 的 1 單位 ＝ 1/72 吋，pdf.js 在縮放 1 時當成 1px）。 */
  readonly w: number;
  readonly h: number;
}

const status = ref<'loading' | 'ready' | 'failed'>('loading');
const failure = ref('');
const slots = ref<Slot[]>([]);
let pdfjs: Pdfjs | null = null;
let task: PDFDocumentLoadingTask | null = null;
let doc: PDFDocumentProxy | null = null;
const pages = new Map<number, PDFPageProxy>();
const contents = new Map<number, Awaited<ReturnType<PDFPageProxy['getTextContent']>>>();

const hasText = computed(() => props.pageTexts.some((text) => text.trim().length > 0));

async function open(): Promise<void> {
  status.value = 'loading';
  try {
    pdfjs = await loadPdfjs();
    task = pdfjs.getDocument({
      url: props.src,
      ...pdfjsAssetOptions(),
      // 快照在本機、而那一支不支援 Range：一次整份拿，不走分段請求。
      disableRange: true,
      disableStream: true,
      enableXfa: false,
    });
    doc = await task.promise;
    const out: Slot[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      pages.set(n, page);
      const viewport = page.getViewport({ scale: 1 });
      out.push({ n, w: viewport.width, h: viewport.height });
    }
    slots.value = out;
    status.value = 'ready';
    await nextTick();
    measure();
    observe();
  } catch (e) {
    const reason = e instanceof Error ? e.name || e.message : String(e);
    failure.value = reason;
    status.value = 'failed';
  }
}

// ── 縮放 ────────────────────────────────────────────────
/** 相對於「適合寬度」的倍數。1 ＝ 適合寬度。 */
const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;
const zoom = ref(1);
/** 頁面最寬到這裡就不再放大 —— 4K 螢幕上一頁撐滿整欄的話，一行字長到讀不了。 */
const MAX_FIT_WIDTH = 1000;
const available = ref(0);
const widest = computed(() => Math.max(1, ...slots.value.map((s) => s.w)));
const scale = computed(() => {
  const fit = Math.min(available.value, MAX_FIT_WIDTH) / widest.value;
  return Math.max(0.1, fit * zoom.value);
});

function zoomBy(direction: 1 | -1): void {
  const i = ZOOM_STEPS.findIndex((z) => z >= zoom.value - 1e-6);
  const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + direction))];
  if (next !== undefined) zoom.value = next;
}
const zoomText = computed(() =>
  zoom.value === 1 ? t.reader.zoomFit : `${String(Math.round(zoom.value * 100))}%`,
);

function sheetStyle(slot: Slot): Record<string, string> {
  return {
    width: `${String(Math.floor(slot.w * scale.value))}px`,
    height: `${String(Math.floor(slot.h * scale.value))}px`,
    '--scale-factor': String(scale.value),
  };
}

// ── 每一頁畫出來的狀態 ─────────────────────────────────
interface Live {
  readonly scale: number;
  readonly layer: HTMLDivElement;
  render: RenderTask | null;
  textLayer: { cancel(): void } | null;
  /** 文字層上每個文字節點從第幾個字開始（選取與高亮的換算用）。 */
  nodes: { node: Text; start: number }[];
  text: string;
  skeleton: Skeleton | null;
  readonly done: Promise<void>;
}
const live = new Map<number, Live>();
const sheets = new Map<number, HTMLElement>();
const sections = new Map<number, HTMLElement>();
const pageSkeletons = new Map<number, Skeleton>();

function pageSkeleton(n: number): Skeleton {
  let sk = pageSkeletons.get(n);
  if (sk === undefined) {
    sk = skeletonOf(props.pageTexts[n - 1] ?? '');
    pageSkeletons.set(n, sk);
  }
  return sk;
}

/** 放大很多的時候，canvas 的像素數不能跟著無限長（一頁 16M 像素 ≈ 64 MB）。 */
const MAX_CANVAS_PIXELS = 16_777_216;

function release(n: number): void {
  const state = live.get(n);
  if (state === undefined) return;
  live.delete(n);
  state.render?.cancel();
  state.textLayer?.cancel();
  const sheet = sheets.get(n);
  for (const canvas of sheet?.querySelectorAll('canvas') ?? []) {
    canvas.width = 0;
    canvas.height = 0;
  }
  sheet?.replaceChildren();
}

function render(n: number): Promise<void> {
  const current = live.get(n);
  if (current !== undefined && current.scale === scale.value) return current.done;
  if (current !== undefined) release(n);
  const sheet = sheets.get(n);
  const page = pages.get(n);
  if (sheet === undefined || page === undefined || pdfjs === null) return Promise.resolve();

  const s = scale.value;
  const viewport = page.getViewport({ scale: s });
  const area = viewport.width * viewport.height;
  const wanted = window.devicePixelRatio || 1;
  const ratio = Math.min(wanted, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, area)));

  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  layer.addEventListener('mousedown', () => layer.classList.add('selecting'));
  sheet.replaceChildren(canvas, layer);

  const lib = pdfjs;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const state: Live = {
    scale: s,
    layer,
    render: null,
    textLayer: null,
    nodes: [],
    text: '',
    skeleton: null,
    done,
  };
  live.set(n, state);

  void (async () => {
    try {
      const job = page.render({
        canvas,
        viewport,
        ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }),
      });
      state.render = job;
      await job.promise;
      if (live.get(n) !== state) return;

      let content = contents.get(n);
      if (content === undefined) {
        // **跟伺服器抽正文時同一個呼叫、同樣的參數**：兩邊的字塊一樣，骨架才會一字不差。
        content = await page.getTextContent();
        contents.set(n, content);
      }
      if (live.get(n) !== state) return;
      const textLayer = new lib.TextLayer({
        textContentSource: content,
        container: layer,
        viewport,
      });
      state.textLayer = textLayer;
      await textLayer.render();
      if (live.get(n) !== state) return;

      const end = document.createElement('div');
      end.className = 'endOfContent';
      layer.append(end);
      indexLayer(state);
      paintHighlights();
    } catch {
      // 取消（捲出範圍、縮放）是正常的；畫壞了那一頁就是一塊底色，其餘照常。
    } finally {
      resolveDone();
    }
  })();
  return done;
}

/** 文字層的字，照 DOM 順序接起來；記住每個文字節點的起點。 */
function indexLayer(state: Live): void {
  const walker = document.createTreeWalker(state.layer, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  const parts: string[] = [];
  let at = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    nodes.push({ node, start: at });
    parts.push(node.data);
    at += node.data.length;
  }
  state.nodes = nodes;
  state.text = parts.join('');
  state.skeleton = skeletonOf(state.text);
}

// ── 看得到的那幾頁才畫 ─────────────────────────────────
const root = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;
let resizer: ResizeObserver | null = null;
const visible = new Set<number>();
const current = ref(1);

/** 捲動的是閱讀器中間那一欄（`.pane`），不是整頁。 */
function scroller(): HTMLElement | null {
  return root.value?.closest<HTMLElement>('.pane') ?? null;
}

function observe(): void {
  observer?.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const n = Number((entry.target as HTMLElement).dataset['page']);
        if (entry.isIntersecting) {
          visible.add(n);
          void render(n);
        } else {
          visible.delete(n);
          release(n);
        }
      }
    },
    // 上下各多一段：捲到的時候已經畫好了，而不是捲到才開始畫。
    { root: scroller(), rootMargin: '1200px 0px' },
  );
  for (const el of sections.values()) observer.observe(el);
}

function setSection(n: number, el: unknown): void {
  if (el instanceof HTMLElement) sections.set(n, el);
  else sections.delete(n);
}
function setSheet(n: number, el: unknown): void {
  if (el instanceof HTMLElement) sheets.set(n, el);
  else sheets.delete(n);
}

function measure(): void {
  const width = root.value?.clientWidth ?? 0;
  if (width > 0) available.value = width;
}

let rerender = 0;
watch(scale, () => {
  // 視窗一直在拉的時候不要每一格都重畫：停下來 150ms 之後，只重畫看得到的那幾頁。
  window.clearTimeout(rerender);
  rerender = window.setTimeout(() => {
    for (const n of [...live.keys()]) if (!visible.has(n)) release(n);
    for (const n of visible) void render(n);
  }, 150);
});

/** 現在讀到第幾頁：畫面中線落在哪一頁上。 */
let ticking = false;
function onScroll(): void {
  if (ticking) return;
  ticking = true;
  window.requestAnimationFrame(() => {
    ticking = false;
    const pane = scroller();
    if (pane === null) return;
    const box = pane.getBoundingClientRect();
    const middle = box.top + box.height / 2;
    for (const [n, el] of sections) {
      const r = el.getBoundingClientRect();
      if (r.top <= middle && r.bottom >= middle) {
        current.value = n;
        break;
      }
    }
  });
}

// ── 選取 → 點註 ────────────────────────────────────────
function pageOfNode(node: Node): number | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const raw = el?.closest<HTMLElement>('[data-page]')?.dataset['page'];
  return raw === undefined ? null : Number(raw);
}

/** DOM 上的一個點 → 文字層字串上的位置。選取的邊界可能落在元素上而不是文字節點上，所以用 Range 量。 */
function layerOffset(state: Live, container: Node, offset: number): number {
  if (!state.layer.contains(container)) {
    const before =
      state.layer.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_PRECEDING;
    return before ? 0 : state.text.length;
  }
  const range = document.createRange();
  range.setStart(state.layer, 0);
  range.setEnd(container, offset);
  return range.toString().length;
}

function onMouseUp(): void {
  for (const state of live.values()) state.layer.classList.remove('selecting');
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const from = pageOfNode(range.startContainer);
  const to = pageOfNode(range.endContainer);
  if (from === null || to === null) return;
  // **跨頁的選取做不成點註**：錨點是「頁碼 ＋ 頁內區間」（ADR-0019），跟文字檢視同一條規則。
  if (from !== to) {
    emit('notice', t.reader.crossPage);
    return;
  }
  const state = live.get(from);
  if (state?.skeleton == null) return;
  const start = layerOffset(state, range.startContainer, range.startOffset);
  const end = layerOffset(state, range.endContainer, range.endOffset);
  const hit = mapBetween(state.skeleton, pageSkeleton(from), start, end);
  if (hit.kind === 'not-found') {
    emit('notice', hasText.value ? t.reader.layoutUnmatched : t.reader.layoutNoText);
    return;
  }
  const text = props.pageTexts[from - 1] ?? '';
  emit('notice', null);
  emit('select', {
    start: hit.start,
    end: hit.end,
    page: from,
    preview: text.slice(hit.start, hit.end),
  });
}

// ── 高亮 ────────────────────────────────────────────────
const HL_NOTE = 'cyclosa-note';
const HL_LOCATED = 'cyclosa-note-located';
const HL_PENDING = 'cyclosa-pending';

/**
 * 正文的頁內區間 → 文字層上的幾段 Range（**一個文字節點一段**）。這一頁還沒畫、或對不上，就是空的。
 *
 * 不是一整段 Range：pdf.js 在行尾放了一個只有空白的字塊，它的框一路延伸到欄外 ——
 * 整段塗的話，高亮會越過欄間距蓋到隔壁那一欄的字上（2026-09-19 截圖看到的）。只有空白的那幾段跳過。
 */
function rangesFor(n: number, start: number, end: number): Range[] {
  const state = live.get(n);
  if (state?.skeleton == null) return [];
  const hit = mapBetween(pageSkeleton(n), state.skeleton, start, end);
  if (hit.kind === 'not-found') return [];
  const out: Range[] = [];
  for (const { node, start: at } of state.nodes) {
    const from = Math.max(hit.start, at);
    const to = Math.min(hit.end, at + node.data.length);
    if (to <= from) continue;
    if (node.data.slice(from - at, to - at).trim().length === 0) continue;
    const range = document.createRange();
    range.setStart(node, from - at);
    range.setEnd(node, to - at);
    out.push(range);
  }
  return out;
}

function paintHighlights(): void {
  const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
  if (registry === undefined) return;
  const normal = new Highlight();
  const located = new Highlight();
  for (const note of props.notes) {
    const hit = note.hit;
    if ((hit.kind !== 'exact' && hit.kind !== 'shifted') || hit.page === null) continue;
    const target = note.note.id === props.locatedId ? located : normal;
    for (const range of rangesFor(hit.page, hit.start, hit.end)) target.add(range);
  }
  const pendingHighlight = new Highlight();
  const p = props.pending;
  if (p !== null && p.page !== null) {
    for (const range of rangesFor(p.page, p.start, p.end)) pendingHighlight.add(range);
  }
  registry.set(HL_NOTE, normal);
  registry.set(HL_LOCATED, located);
  registry.set(HL_PENDING, pendingHighlight);
}

watch(() => [props.notes, props.locatedId, props.pending], paintHighlights, { deep: false });

/**
 * 「在正文裡找到它」：捲到那一頁、等它畫好、再把那一段捲到畫面上三分之一的地方。
 * 由閱讀器呼叫（`defineExpose`）—— 同一則按兩次也要再捲一次，所以不是 watch `locatedId`。
 */
async function scrollToNote(noteId: string): Promise<void> {
  const note = props.notes.find((n) => n.note.id === noteId);
  if (note === undefined) return;
  const hit = note.hit;
  if ((hit.kind !== 'exact' && hit.kind !== 'shifted') || hit.page === null) return;
  const section = sections.get(hit.page);
  const pane = scroller();
  if (section === undefined || pane === null) return;
  pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16;
  visible.add(hit.page);
  await render(hit.page);
  paintHighlights();
  const first = rangesFor(hit.page, hit.start, hit.end)[0];
  if (first === undefined) return;
  const r = first.getBoundingClientRect();
  const box = pane.getBoundingClientRect();
  pane.scrollBy({ top: r.top - box.top - box.height / 3, behavior: 'smooth' });
}

defineExpose({ scrollToNote });

onMounted(() => {
  void open();
  if (root.value !== null) {
    resizer = new ResizeObserver(() => measure());
    resizer.observe(root.value);
  }
  scroller()?.addEventListener('scroll', onScroll, { passive: true });
});

onBeforeUnmount(() => {
  window.clearTimeout(rerender);
  observer?.disconnect();
  resizer?.disconnect();
  scroller()?.removeEventListener('scroll', onScroll);
  for (const n of [...live.keys()]) release(n);
  if (typeof CSS !== 'undefined' && CSS.highlights !== undefined) {
    for (const name of [HL_NOTE, HL_LOCATED, HL_PENDING]) CSS.highlights.delete(name);
  }
  void task?.destroy();
});
</script>

<template>
  <div ref="root" class="pdf-view" @mouseup="onMouseUp">
    <p v-if="status === 'loading'" class="muted">{{ t.reader.layoutLoading }}</p>
    <p v-else-if="status === 'failed'" class="callout">
      {{ fill(t.reader.layoutFailed, { reason: failure }) }}
    </p>

    <template v-else>
      <div class="pdf-toolbar compact">
        <span class="where">{{
          fill(t.reader.layoutPage, { n: current, total: slots.length })
        }}</span>
        <span class="zoom">
          <button
            class="small"
            type="button"
            :aria-label="t.reader.zoomOut"
            :title="t.reader.zoomOut"
            :disabled="zoom <= ZOOM_STEPS[0]"
            @click="zoomBy(-1)"
          >
            -
          </button>
          <button class="small" type="button" :disabled="zoom === 1" @click="zoom = 1">
            {{ zoomText }}
          </button>
          <button
            class="small"
            type="button"
            :aria-label="t.reader.zoomIn"
            :title="t.reader.zoomIn"
            :disabled="zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]!"
            @click="zoomBy(1)"
          >
            +
          </button>
        </span>
      </div>

      <p v-if="!hasText" class="callout pending">{{ t.reader.layoutNoText }}</p>

      <!-- 放大之後頁面比欄寬：在這一層裡橫捲。工具列在這一層外面，才貼得住中間那一欄的頂。 -->
      <div class="pdf-pages">
        <section
          v-for="slot in slots"
          :key="slot.n"
          :ref="(el) => setSection(slot.n, el)"
          class="pdf-page"
          :data-page="slot.n"
        >
          <div class="page-mark">
            <span>{{ fill(t.reader.page, { n: slot.n }) }}</span>
          </div>
          <div
            :ref="(el) => setSheet(slot.n, el)"
            class="pdf-sheet"
            :style="sheetStyle(slot)"
          ></div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pdf-view {
  min-width: 0;
}
/* 頁面比欄寬的時候（放大之後）在這一層裡橫捲，不讓整頁出現橫捲軸（release-checklist D10）。 */
.pdf-pages {
  min-width: 0;
  overflow-x: auto;
}
/*
 * 貼在中間那一欄（.pane）的頂上：捲到第 20 頁也看得到在第幾頁、縮放多少。
 * sticky 的 0 是那一欄的內距之內 —— 所以往上抵掉內距（`--pane-pad-top`，ReaderView 宣告），
 * 不然頂上會留一條縫，捲過去的頁面從縫裡露出來。
 */
.pdf-toolbar {
  position: sticky;
  top: calc(-1 * var(--pane-pad-top, 0px));
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s2);
  flex-wrap: wrap;
  padding: var(--s1) 0;
  background: var(--bg-app);
  border-bottom: 1px solid var(--line-subtle);
  font-size: var(--fs-label);
  color: var(--text-muted);
}
.zoom {
  display: inline-flex;
  gap: var(--s1);
}
.pdf-page {
  margin: 0;
}
/* 頁與頁之間一條線、中間寫「第 n 頁」—— 跟文字檢視同一個樣子。 */
.page-mark {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 10px;
  color: var(--text-muted);
  font-size: var(--fs-label);
  user-select: none;
}
.page-mark::before,
.page-mark::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--line-subtle);
}
.pdf-sheet {
  margin: 0 auto;
}
</style>
