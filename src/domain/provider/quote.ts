/**
 * 在正文裡找出模型給的引文。
 *
 * ## 模型給的字元位置一律不採信
 *
 * 抽關聯的時候，模型會回「引文 ＋ 起訖位置」。**起訖位置直接丟掉，自己去找。**
 *
 * 理由不是模型會算錯（雖然它會），而是**兩種錯的後果完全不同**：
 * 位置錯了，`edge_evidence` 那一列仍然存在、仍然顯示一段引文，
 * 但點下去跳到的是別的地方 —— 而**使用者要驗的正是「這句話真的在那裡嗎」**。
 * 一個指錯位置的出處，比沒有出處更糟：它看起來已經被驗過了。
 *
 * 所以規則是：**引文在正文裡找得到，才有這條出處；找不到就沒有這條邊。**
 * 這條規則的碼是 `PROVIDER_QUOTE_NOT_FOUND`，級別 `partial` ——
 * 一條抽壞了不該讓整批擴展失敗。
 *
 * ## 為什麼要做空白正規化
 *
 * 正文是從 HTML 抽出來的，換行與連續空白怎麼保留取決於抽取器；
 * 模型看到的是同一段文字，但它會照自己的習慣重排空白。
 * **只做精確比對的話，中文以外的來源幾乎全部會找不到。**
 *
 * 但正規化之後回報的位置必須是**原文的**位置 —— 所以要留一張索引對照表，
 * 不能就地 `replace` 完了事。
 */
import { findFirst } from '../text/offsets.js';

/**
 * 短引文不算出處。
 *
 * 「表示」兩個字在任何一篇裡都找得到，**找得到不等於驗得了**。
 * 8 個字是中文一句話的下限；再短的多半是模型抓了一個詞當引文。
 */
export const MIN_QUOTE_CHARS = 8;

/** 超過這個長度的「引文」是整段複製，不是引文。 */
export const MAX_QUOTE_CHARS = 500;

export type QuoteLocation =
  | { readonly kind: 'found'; readonly start: number; readonly end: number }
  | { readonly kind: 'too-short' }
  | { readonly kind: 'not-found' };

/**
 * 找一段引文在正文裡的位置。
 *
 * **回的是原文的字元區間**（`char_start`／`char_end`，半開區間），
 * 就是 `edge_evidence` 那兩欄要存的東西。
 *
 * 比對本身在 `domain/text/offsets.ts` —— 點註用的是同一支
 * （同樣要「空白視為等價」而且同樣必須回原文座標）。
 * **這裡多的只有兩條長度限制**，而那兩條是給模型的，不是給人的。
 */
export function locateQuote(text: string, quote: string): QuoteLocation {
  const trimmed = quote.trim();
  if (trimmed.length < MIN_QUOTE_CHARS) return { kind: 'too-short' };
  if (trimmed.length > MAX_QUOTE_CHARS) return { kind: 'not-found' };

  const span = findFirst(text, trimmed);
  if (span === null) return { kind: 'not-found' };
  return { kind: 'found', start: span.start, end: span.end };
}
