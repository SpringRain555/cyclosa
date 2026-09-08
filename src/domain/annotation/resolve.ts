/**
 * 把一則點註的選擇器解回「現在這份文字裡的哪一段」。
 *
 * ## 這一支就是 ADR-0010 第 5 條的實作點
 *
 * 「錨點解析失敗時明確標示『找不到原文位置』並保留註記內容，
 * **不靜默丟掉也不錨到錯的地方**」——
 * 那句話裡最重要的是後半段。丟掉是看得見的失敗，
 * **錨到錯的地方是看不見的**：畫面上有一段被標起來的文字，
 * 而它不是使用者當初標的那一段。
 *
 * 所以這裡只有三種結局，沒有「差不多」：
 *
 * | 結局 | 意思 |
 * |---|---|
 * | `exact` | 位置對得上，而且那個位置的文字**就是**當初存的引文 |
 * | `shifted` | 位置對不上，但引文在別處找到了（抽取器換版之後的正常情況）|
 * | `not-found` | 找不到。**標起來，內容留著。** |
 *
 * ## 為什麼沒有引文就直接算失敗
 *
 * 只有位置沒有引文的話，**我們沒有任何辦法知道那個位置對不對** ——
 * 而回一個沒驗過的位置，長相跟驗過的一模一樣。
 * 寫入路徑一律兩個都存（`selector.ts`），所以「只有位置」代表那一列壞了，
 * 而壞掉的那一列該走的是「找不到原文位置」這條路。
 *
 * ## 解析的目標是 `derived/`，而錨定的對象是 `sources/`
 *
 * 這兩句話不衝突，而它們的分工正是這一階段的驗收條件：
 *
 * - **錨定的對象**是那一份不可變的快照（`note.snapshot_sha256`）。
 *   快照不變，重抽多少次結果都一樣 —— 這是 `差異必須為 0` 成立的理由。
 * - **解析的目標**是當下這一份 `derived/`，因為那是使用者眼睛看到的東西。
 *   抽取器換版之後引文可能落在別的位置，**而錨點跟著它走**（`shifted`）。
 *
 * ⚠️ 純函式，零依賴。
 */
import { findAll, type Span } from '../text/offsets.js';
import {
  pickPage,
  pickPosition,
  pickQuote,
  pickRect,
  type Rect,
  type Selector,
  type TextQuoteSelector,
} from './selector.js';

export type AnchorHit =
  | {
      readonly kind: 'exact' | 'shifted';
      readonly start: number;
      readonly end: number;
      /** PDF 才有。**1-based。** */
      readonly page: number | null;
    }
  | { readonly kind: 'rect'; readonly rect: Rect }
  | { readonly kind: 'not-found' };

/**
 * 同一段引文最多考慮幾個候選位置。
 *
 * 上限存在的理由不是效能，是**判斷力**：同一句話在一篇裡出現 200 次的時候，
 * 前後文那 32 個字已經分不出哪一個是對的了。
 * 那種情況下「挑一個」跟「挑錯一個」沒有差別，所以不挑。
 */
const MAX_CANDIDATES = 200;

/** 兩個字串結尾有多少個字元一樣。 */
function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** 兩個字串開頭有多少個字元一樣。 */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[n] === b[n]) n++;
  return n;
}

/**
 * 從多個候選位置裡挑一個 —— **靠前後文，不是靠順序**。
 *
 * 這是 `TextQuoteSelector` 的 `prefix`／`suffix` 唯一的用途。
 * 沒有它的話，一篇文章裡第二次出現的那句話會永遠錨到第一次那裡，
 * 而**使用者看不出差別** —— 被標起來的字是對的，位置是錯的。
 *
 * 平手時比「離原本記的位置多近」：抽取器換版通常只讓文字整體位移一點點，
 * 所以離得近的那個比較可能是同一段。
 */
function bestCandidate(
  text: string,
  candidates: readonly Span[],
  quote: TextQuoteSelector,
  near: number | null,
): Span | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] as Span;

  let best: Span | null = null;
  let bestScore = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const span of candidates) {
    const before = text.slice(Math.max(0, span.start - quote.prefix.length), span.start);
    const after = text.slice(span.end, span.end + quote.suffix.length);
    const score =
      commonSuffixLength(quote.prefix, before) + commonPrefixLength(quote.suffix, after);
    const distance = near === null ? 0 : Math.abs(span.start - near);

    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = span;
      bestScore = score;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * 在一段文字裡解析。**先試位置，對不上才用引文重找**（ADR-0010）。
 *
 * 順序不能反過來：位置那一條是 O(1)，而且**它對得上就代表沒有漂**，
 * 那是最強的證據，不需要再猜。
 */
export function resolveInText(
  text: string,
  selectors: readonly Selector[],
  page: number | null = null,
): AnchorHit {
  const quote = pickQuote(selectors);
  if (quote === null) return { kind: 'not-found' };

  const position = pickPosition(selectors);
  if (
    position !== null &&
    position.end <= text.length &&
    text.slice(position.start, position.end) === quote.exact
  ) {
    return { kind: 'exact', start: position.start, end: position.end, page };
  }

  const candidates = findAll(text, quote.exact);
  if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) return { kind: 'not-found' };

  const hit = bestCandidate(text, candidates, quote, position?.start ?? null);
  if (hit === null) return { kind: 'not-found' };
  return { kind: 'shifted', start: hit.start, end: hit.end, page };
}

/**
 * PDF：先在**記著的那一頁**裡找，對不上才擴大到相鄰頁（ADR-0019）。
 *
 * **不掃整份文件。** 一份 300 頁的 PDF 裡，「本研究指出」在每一頁都找得到 ——
 * 掃到第 47 頁找到一個，看起來像成功，實際上是錨到別的地方。
 * 相鄰頁的範圍反映的是真正會發生的事：抽取器換版讓一段字掉到前一頁或後一頁。
 */
export function resolveInPdf(pages: readonly string[], selectors: readonly Selector[]): AnchorHit {
  const page = pickPage(selectors);
  if (page === null || pages.length === 0) return { kind: 'not-found' };

  // 1-based → 0-based **只在這裡做一次**（ADR-0019 的代價那一條）。
  const order = [page, page - 1, page + 1];
  for (const candidate of order) {
    const text = pages[candidate - 1];
    if (text === undefined) continue;
    const hit = resolveInText(text, selectors, candidate);
    if (hit.kind !== 'exact' && hit.kind !== 'shifted') continue;
    // **換了一頁就不算 `exact`。** 頁內位移對得上，但頁碼本身已經漂了。
    const kind = candidate === page ? hit.kind : 'shifted';
    return { kind, start: hit.start, end: hit.end, page: candidate };
  }
  return { kind: 'not-found' };
}

/**
 * 圖片：矩形要落在快照的尺寸裡面。
 *
 * **沒有第二重錨點可以退**（ADR-0019）——
 * 所以這裡唯一會失敗的情況是「這個框對不上這張圖」，
 * 而那代表快照換了，也就是 ADR-0003 的不可變被違反了。
 * 那時候該顯示的是「找不到原文位置」，不是把框硬夾進邊界裡。
 */
export function resolveInImage(
  selectors: readonly Selector[],
  width: number | null,
  height: number | null,
): AnchorHit {
  const rect = pickRect(selectors);
  if (rect === null) return { kind: 'not-found' };
  // 尺寸不知道的時候放行 —— 舊的匯入沒有記尺寸，而那不是這則點註的錯。
  if (width === null || height === null) return { kind: 'rect', rect };
  if (rect.x + rect.w > width || rect.y + rect.h > height) return { kind: 'not-found' };
  return { kind: 'rect', rect };
}

export interface ResolveTarget {
  readonly kind: 'web' | 'pdf' | 'image' | 'text';
  readonly text: string;
  readonly pages: readonly string[] | null;
  readonly width: number | null;
  readonly height: number | null;
}

/** 依來源型別分派。**三種來源三條路，而它們共用同一個 `selector_json`。** */
export function resolveAnchor(target: ResolveTarget, selectors: readonly Selector[]): AnchorHit {
  if (target.kind === 'image') return resolveInImage(selectors, target.width, target.height);
  if (target.kind === 'pdf') return resolveInPdf(target.pages ?? [], selectors);
  return resolveInText(target.text, selectors);
}

/** 解析成功就是「錨得住」。`anchor_ok` 那一欄存的就是這個。 */
export function anchorOk(hit: AnchorHit): boolean {
  return hit.kind !== 'not-found';
}
