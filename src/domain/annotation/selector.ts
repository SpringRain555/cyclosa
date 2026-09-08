/**
 * W3C Web Annotation 的選擇器 —— **一個欄位裝三種來源**（ADR-0019）。
 *
 * ## 為什麼不為三種來源開三張表
 *
 * 最常見的查詢是「這個專題所有的點註」。三張表的話那句話是 UNION 三張表，
 * 而 W3C 模型本身就是為這件事設計的：**一個標註可以帶多個選擇器，
 * 解析端依序嘗試**。
 *
 * ## 三種來源各存什麼
 *
 * | 來源 | 選擇器 |
 * |---|---|
 * | 網頁／Markdown／純文字 | `TextQuoteSelector` ＋ `TextPositionSelector` |
 * | PDF | 上面兩個，**外面再包一層頁碼**；字元區間**相對於那一頁** |
 * | 圖片 | `FragmentSelector`：`#xywh=pixel:x,y,w,h` |
 *
 * **圖片沒有第二重錨點**，而那是明知的不對稱：純文字與 PDF 的備援是引文，
 * 圖片沒有等價物。它不需要備援 —— 需要備援的是**會被重新抽取的東西**，
 * 而像素座標對一份不可變的快照永遠有效。
 *
 * ## 這裡的東西是從資料庫讀出來的，所以它是不可信輸入
 *
 * `selector_json` 是一個 TEXT 欄位。它可能是舊版寫的、可能被手改過、
 * 也可能是一個 bug 寫壞的。**`parseSelectors` 的職責是「壞掉的當作沒有」**，
 * 不是相信它 —— 一個型別對但數字荒謬的選擇器會錨到錯的地方，
 * 而那正是 ADR-0010 第 5 條要避免的事。
 *
 * ⚠️ 純函式，零依賴。
 */

/** W3C Media Fragments URI 1.0 —— 圖片的矩形。 */
export const MEDIA_FRAGMENT = 'http://www.w3.org/TR/media-frags/';

/** RFC 3778（`application/pdf` 的媒體型別）—— `#page=N` 是它定義的。 */
export const PDF_FRAGMENT = 'http://tools.ietf.org/rfc/rfc3778';

/**
 * 引文前後各留幾個字當前後文。
 *
 * 32 是量出來的下限方向：中文一行大約 30–40 字，而前後文的用途是
 * **在同一篇裡分辨重複出現的同一句話**。太短分不開，太長會被排版差異弄髒。
 */
export const CONTEXT_CHARS = 32;

/** 選得太短的東西不是點註。一個字的「的」錨到哪裡都對，也就都不對。 */
export const MIN_SELECTION_CHARS = 2;

/** 一則點註不是一份副本。超過就是使用者想要的其實是匯出。 */
export const MAX_SELECTION_CHARS = 2000;

export interface TextQuoteSelector {
  readonly type: 'TextQuoteSelector';
  readonly exact: string;
  readonly prefix: string;
  readonly suffix: string;
}

export interface TextPositionSelector {
  readonly type: 'TextPositionSelector';
  readonly start: number;
  readonly end: number;
}

/**
 * 片段選擇器。**兩種用途共用一個型別，靠 `conformsTo` 分**：
 * 圖片的矩形（`MEDIA_FRAGMENT`）與 PDF 的頁碼（`PDF_FRAGMENT`）。
 *
 * `refinedBy` 是 W3C 定義的巢狀：**先縮到這個片段，再用裡面那個縮一次**。
 * PDF 就是這樣表達「第 3 頁的第 120–180 個字」的。
 */
export interface FragmentSelector {
  readonly type: 'FragmentSelector';
  readonly conformsTo: string;
  readonly value: string;
  readonly refinedBy?: TextPositionSelector;
}

export type Selector = TextQuoteSelector | TextPositionSelector | FragmentSelector;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

// ── 建立 ──────────────────────────────────────────────────

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && Number.isFinite(v);
}

export type BuildResult<T> =
  | { readonly kind: 'ok'; readonly selectors: readonly Selector[]; readonly value: T }
  | { readonly kind: 'too-short' }
  | { readonly kind: 'too-long' }
  | { readonly kind: 'out-of-range' };

/**
 * 從一段文字的選取範圍建選擇器。
 *
 * **兩個都存**：位置快、引文抗漂移（ADR-0010）。
 * 前後文從**同一份文字**取，所以它跟 `exact` 是一起漂或一起不漂的。
 */
export function textSelectors(
  text: string,
  start: number,
  end: number,
): BuildResult<{ readonly exact: string }> {
  if (!isInt(start) || !isInt(end) || start < 0 || end > text.length || end <= start) {
    return { kind: 'out-of-range' };
  }
  const exact = text.slice(start, end);
  if (exact.trim().length < MIN_SELECTION_CHARS) return { kind: 'too-short' };
  if (exact.length > MAX_SELECTION_CHARS) return { kind: 'too-long' };

  const quote: TextQuoteSelector = {
    type: 'TextQuoteSelector',
    exact,
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(end, Math.min(text.length, end + CONTEXT_CHARS)),
  };
  const position: TextPositionSelector = { type: 'TextPositionSelector', start, end };
  return { kind: 'ok', selectors: [quote, position], value: { exact } };
}

/**
 * PDF：**頁碼在外，字元區間在內**。
 *
 * `page` 是 1-based，`pages[0]` 是第 1 頁 —— 這是整個專案裡少數幾個
 * 1-based 的地方，所以欄位叫 `page` 而不是 `pageIndex`（ADR-0019 的代價）。
 *
 * 字元區間相對於**那一頁**，不是整份文件：整份文件的位移會被前面任何一頁的
 * 抽取差異推移，**一頁抽錯會讓後面每一頁全漂**。失敗要能被局部化。
 */
export function pdfSelectors(
  pageText: string,
  page: number,
  start: number,
  end: number,
): BuildResult<{ readonly exact: string; readonly page: number }> {
  if (!isInt(page) || page < 1) return { kind: 'out-of-range' };
  const inner = textSelectors(pageText, start, end);
  if (inner.kind !== 'ok') return inner;

  const [quote, position] = inner.selectors as [TextQuoteSelector, TextPositionSelector];
  const fragment: FragmentSelector = {
    type: 'FragmentSelector',
    conformsTo: PDF_FRAGMENT,
    value: `#page=${String(page)}`,
    refinedBy: position,
  };
  return { kind: 'ok', selectors: [fragment, quote], value: { exact: inner.value.exact, page } };
}

/**
 * 圖片：`#xywh=pixel:x,y,w,h`。
 *
 * **`pixel:` 而不是 `percent:`** —— 快照的原始尺寸是不可變的，
 * 所以像素座標對它永遠有效，而百分比在四捨五入上會漂。
 */
export function imageSelector(rect: Rect, width: number, height: number): BuildResult<Rect> {
  const { x, y, w, h } = rect;
  if (![x, y, w, h].every(isInt)) return { kind: 'out-of-range' };
  if (w < 1 || h < 1) return { kind: 'too-short' };
  // **超出邊界一律拒絕。** 一個框在圖外面的矩形不是「差不多」，是錯的來源。
  if (x < 0 || y < 0 || x + w > width || y + h > height) return { kind: 'out-of-range' };

  const value = `#xywh=pixel:${String(x)},${String(y)},${String(w)},${String(h)}`;
  const fragment: FragmentSelector = {
    type: 'FragmentSelector',
    conformsTo: MEDIA_FRAGMENT,
    value,
  };
  return { kind: 'ok', selectors: [fragment], value: rect };
}

// ── 讀回來 ────────────────────────────────────────────────

function asPosition(v: Record<string, unknown>): TextPositionSelector | null {
  const start = v['start'];
  const end = v['end'];
  if (!isInt(start) || !isInt(end)) return null;
  // 空區間與反向區間都不是選取範圍。**荒謬的數字當作沒有。**
  if (start < 0 || end <= start) return null;
  return { type: 'TextPositionSelector', start, end };
}

/**
 * 從 `selector_json` 讀回來。**壞掉的當作沒有，不丟例外。**
 *
 * 一則點註的選擇器壞掉一個，另一個仍然可能救得回來 ——
 * 整串丟掉的話，一個型別打錯的位置選擇器會把好好的引文一起帶走。
 */
export function parseSelectors(json: string): readonly Selector[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const out: Selector[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const v = entry as Record<string, unknown>;

    if (v['type'] === 'TextQuoteSelector') {
      const exact = v['exact'];
      if (typeof exact !== 'string' || exact.length === 0) continue;
      out.push({
        type: 'TextQuoteSelector',
        exact,
        prefix: typeof v['prefix'] === 'string' ? v['prefix'] : '',
        suffix: typeof v['suffix'] === 'string' ? v['suffix'] : '',
      });
      continue;
    }

    if (v['type'] === 'TextPositionSelector') {
      const p = asPosition(v);
      if (p !== null) out.push(p);
      continue;
    }

    if (v['type'] === 'FragmentSelector') {
      const conformsTo = v['conformsTo'];
      const value = v['value'];
      if (typeof conformsTo !== 'string' || typeof value !== 'string') continue;
      const refined =
        typeof v['refinedBy'] === 'object' && v['refinedBy'] !== null
          ? asPosition(v['refinedBy'] as Record<string, unknown>)
          : null;
      out.push({
        type: 'FragmentSelector',
        conformsTo,
        value,
        ...(refined === null ? {} : { refinedBy: refined }),
      });
    }
  }
  return out;
}

export function pickQuote(selectors: readonly Selector[]): TextQuoteSelector | null {
  return selectors.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector') ?? null;
}

export function pickPosition(selectors: readonly Selector[]): TextPositionSelector | null {
  const flat = selectors.find((s): s is TextPositionSelector => s.type === 'TextPositionSelector');
  if (flat !== undefined) return flat;
  // PDF 的位置在頁碼片段的 `refinedBy` 裡面。
  const page = selectors.find(
    (s): s is FragmentSelector => s.type === 'FragmentSelector' && s.conformsTo === PDF_FRAGMENT,
  );
  return page?.refinedBy ?? null;
}

const PAGE_RE = /^#page=(\d+)$/;

/** PDF 的頁碼。**1-based。** 沒有頁碼片段就回 `null`。 */
export function pickPage(selectors: readonly Selector[]): number | null {
  for (const s of selectors) {
    if (s.type !== 'FragmentSelector' || s.conformsTo !== PDF_FRAGMENT) continue;
    const m = PAGE_RE.exec(s.value);
    if (m === null) continue;
    const page = Number(m[1]);
    if (Number.isInteger(page) && page >= 1) return page;
  }
  return null;
}

const XYWH_RE = /^#xywh=pixel:(\d+),(\d+),(\d+),(\d+)$/;

export function pickRect(selectors: readonly Selector[]): Rect | null {
  for (const s of selectors) {
    if (s.type !== 'FragmentSelector' || s.conformsTo !== MEDIA_FRAGMENT) continue;
    const m = XYWH_RE.exec(s.value);
    if (m === null) continue;
    const [x, y, w, h] = m.slice(1, 5).map(Number) as [number, number, number, number];
    if (w < 1 || h < 1) continue;
    return { x, y, w, h };
  }
  return null;
}
