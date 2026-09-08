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

/** 空白視為等價的一個字元；其餘原樣保留。 */
function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * 建一份「壓過空白」的字串，同時記下每個字元在原文的位置。
 *
 * 連續空白壓成一個半形空格，**而那個空格記的是它那一段的第一個字元的位置** ——
 * 這樣回報出來的區間頭尾都落在真的有字的地方。
 */
function squash(text: string): { readonly flat: string; readonly map: readonly number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  let pendingSpace = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (isSpace(ch)) {
      if (pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0 && chars.length > 0) {
      chars.push(' ');
      map.push(pendingSpace);
    }
    pendingSpace = -1;
    chars.push(ch);
    map.push(i);
  }
  return { flat: chars.join(''), map };
}

/**
 * 找一段引文在正文裡的位置。
 *
 * **回的是原文的字元區間**（`char_start`／`char_end`，半開區間），
 * 就是 `edge_evidence` 那兩欄要存的東西。
 *
 * 先精確找一次是為了速度：絕大多數情況下正文與引文的空白本來就一樣，
 * 而 `squash` 要走過整篇。
 */
export function locateQuote(text: string, quote: string): QuoteLocation {
  const trimmed = quote.trim();
  if (trimmed.length < MIN_QUOTE_CHARS) return { kind: 'too-short' };
  if (trimmed.length > MAX_QUOTE_CHARS) return { kind: 'not-found' };

  const exact = text.indexOf(trimmed);
  if (exact >= 0) return { kind: 'found', start: exact, end: exact + trimmed.length };

  const haystack = squash(text);
  const needle = squash(trimmed);
  if (needle.flat.length === 0) return { kind: 'too-short' };

  const at = haystack.flat.indexOf(needle.flat);
  if (at < 0) return { kind: 'not-found' };

  const start = haystack.map[at] as number;
  const lastFlat = at + needle.flat.length - 1;
  const lastOriginal = haystack.map[lastFlat] as number;
  // `end` 是半開區間的右界，所以是最後一個字元的位置再加一。
  return { kind: 'found', start, end: lastOriginal + 1 };
}
