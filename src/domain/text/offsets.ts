/**
 * 在一段文字裡找另一段文字，**而回報的位置是原文的位置**。
 *
 * ## 為什麼要有這一支，而不是各自 `indexOf`
 *
 * 兩個地方需要同一件事，理由不同但形狀一樣：
 *
 * | 誰 | 要找什麼 | 為什麼空白對不上 |
 * |---|---|---|
 * | `domain/provider/quote.ts` | 模型回的引文 | 模型會照自己的習慣重排空白 |
 * | `domain/annotation/resolve.ts` | 點註的引文 | **抽取器換版之後空白會變** |
 *
 * 兩邊都要「空白視為等價」的比對，而且**兩邊都必須回原文的座標** ——
 * 就地 `replace` 完了事的話，回報的位置會落在一個不存在的字串上。
 *
 * 一份演算法寫兩次就是兩個各自會漂的地方，所以它在這裡。
 *
 * ⚠️ 純函式，零依賴。
 */

/** 空白視為等價的一個字元；其餘原樣保留。 */
function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * 中日韓的表意文字與全形標點。**判斷「這個空白可不可以省略」用的。**
 *
 * 中文排版有一個很常見的慣例：**中文與英數字之間加一個空格**
 * （「中本聰在 2008 年」）。原文有沒有那個空格取決於作者，
 * 而模型會照自己的習慣加或不加 —— 那是排版差異，**字完全一樣**。
 */
function isCjk(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xff60)
  );
}

/**
 * 壓過空白的字串 ＋ 每個字元在原文的位置。
 *
 * 連續空白壓成一個半形空格，**而那個空格記的是它那一段的第一個字元的位置** ——
 * 這樣回報出來的區間頭尾都落在真的有字的地方。
 */
export interface Squashed {
  readonly flat: string;
  /** `map[i]` ＝ `flat[i]` 在原文的索引。 */
  readonly map: readonly number[];
}

/**
 * 全形標點對半形的對照。**只收長度不變的 1:1 對應。**
 *
 * 存在的理由是量出來的：2026-09-09 追兩條「引文在原文裡找不到」的關聯，
 * **兩條都不是模型捏造的**：
 *
 * | 模型寫的 | 原文 | 差在哪 |
 * |---|---|---|
 * | `朱耀沂。《蜘蛛博物學》.` | `朱耀沂. 《蜘蛛博物學》.` | 半形句點寫成全形 |
 *
 * 而「找不到」的後果是**那條邊不存在**（ADR-0005）。
 * 一個少打一個標點的模型，跟一個捏造引文的模型，在那一欄裡長得一模一樣。
 *
 * **這不會放寬「引文要在原文裡」那條規則** —— 放寬的只是「同一個標點的兩種寫法」。
 * 而且存進 `edge_evidence` 的一直是**原文切出來的那一段**
 * （`expand-service.ts` 用 `derived.text.slice(start, end)`），不是模型打的字，
 * 所以匯出驗證比對的仍然是原文自己。
 */
const PUNCTUATION_FOLD = new Map<string, string>([
  ['。', '.'],
  ['．', '.'],
  ['｡', '.'],
  ['，', ','],
  ['、', ','],
  ['；', ';'],
  ['：', ':'],
  ['！', '!'],
  ['？', '?'],
  ['（', '('],
  ['）', ')'],
  ['［', '['],
  ['］', ']'],
  ['｛', '{'],
  ['｝', '}'],
  ['「', '"'],
  ['」', '"'],
  ['『', "'"],
  ['』', "'"],
  ['“', '"'],
  ['”', '"'],
  ['‘', "'"],
  ['’', "'"],
  ['《', '<'],
  ['》', '>'],
  ['〈', '<'],
  ['〉', '>'],
  ['－', '-'],
  ['～', '~'],
]);

/**
 * 大小寫視為等價的那一份。**逐字轉小寫，而且只在長度不變的時候才轉。**
 *
 * 整段 `toLowerCase()` 會在少數字元上改變長度（`'İ'` 轉出來是兩個字元），
 * 而長度一變，`map` 就對不上了 —— 於是回報出去的位置會偏，
 * 而那個位置正是要拿去切引文、上色、跳到原文的那一個。
 */
function fold(ch: string): string {
  const lower = ch.toLowerCase();
  return lower.length === 1 ? lower : ch;
}

export function squash(
  text: string,
  foldCase = false,
  foldPunctuation = false,
  /**
   * **CJK 旁邊的空白視為可有可無。**
   *
   * 只在 `domain/provider/quote.ts` 開。理由是量出來的：
   * `qwen3.5:4b` 的 41 條引文裡有 10 條**只差中英文之間的空格**
   * （「中本聰在 2008 年」對「中本聰在2008年」）—— 命中率 73% 對 98%。
   *
   * **不能整個把空白刪掉**：拉丁文的空格是有意義的
   * （`the rapist` 會對上 `therapist`）。所以條件是**兩側至少有一邊是 CJK**，
   * 那正是那個排版慣例發生的地方。
   */
  dropCjkAdjacentSpace = false,
): Squashed {
  const chars: string[] = [];
  /**
   * 折之前的樣子。**只給 `isCjk` 用。**
   *
   * 順序會咬人：標點折疊先把 `《` 換成 `<`，而 `<` 不是 CJK ——
   * 於是「CJK 旁邊的空白可省略」就認不出那個邊界了。
   * 兩條規則同時開的時候，**CJK 要看原本那個字**。
   */
  const rawChars: string[] = [];
  const map: number[] = [];
  let pendingSpace = -1;

  for (let i = 0; i < text.length; i++) {
    const raw = text[i] as string;
    const cased = foldCase ? fold(raw) : raw;
    // **1:1 才換。** `map` 是逐字元對照，長度一變位置就全歪。
    const ch = foldPunctuation ? (PUNCTUATION_FOLD.get(cased) ?? cased) : cased;
    if (isSpace(ch)) {
      if (pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0 && chars.length > 0) {
      const before = rawChars[rawChars.length - 1] as string;
      if (!(dropCjkAdjacentSpace && (isCjk(before) || isCjk(raw)))) {
        chars.push(' ');
        rawChars.push(' ');
        map.push(pendingSpace);
      }
    }
    pendingSpace = -1;
    chars.push(ch);
    rawChars.push(raw);
    map.push(i);
  }
  return { flat: chars.join(''), map };
}

/** 原文的半開區間。 */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * 把壓過空白的座標換回原文座標。
 *
 * **`end` 是半開區間的右界**，所以是最後一個字元的位置再加一 ——
 * 不是 `map[flatEnd]`，那會指到下一個字元的開頭而把尾巴切掉。
 */
export function spanOf(haystack: Squashed, flatStart: number, flatLength: number): Span {
  const start = haystack.map[flatStart] as number;
  const lastOriginal = haystack.map[flatStart + flatLength - 1] as number;
  return { start, end: lastOriginal + 1 };
}

/**
 * 找出**每一個**出現位置，回原文座標。
 *
 * 為什麼是「每一個」而不是第一個：點註要靠前後文從多個相同的字串裡挑對的那一個
 * （`TextQuoteSelector` 的 `prefix`／`suffix` 就是為這件事存在的）。
 * 只回第一個的話，一篇文章裡第二次出現的「他表示」會永遠錨到第一次那裡。
 *
 * 先精確找一遍是為了速度：絕大多數情況下空白本來就一樣，而 `squash` 要走過整篇。
 */
export function findAll(text: string, needle: string): readonly Span[] {
  if (needle.length === 0) return [];

  const exact: Span[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    exact.push({ start: at, end: at + needle.length });
  }
  if (exact.length > 0) return exact;

  const haystack = squash(text);
  const flatNeedle = squash(needle).flat;
  if (flatNeedle.length === 0) return [];

  const out: Span[] = [];
  for (
    let at = haystack.flat.indexOf(flatNeedle);
    at >= 0;
    at = haystack.flat.indexOf(flatNeedle, at + 1)
  ) {
    out.push(spanOf(haystack, at, flatNeedle.length));
  }
  return out;
}

/** 第一個出現位置。找不到回 `null`。 */
export function findFirst(text: string, needle: string): Span | null {
  return findAll(text, needle)[0] ?? null;
}

/**
 * 第一個出現位置，**大小寫也視為等價**。
 *
 * 檢索要的是這一支：「Cyclosa」與「cyclosa」是同一個字，
 * 而引文與點註要的是原本那一支 —— **引文要一字不差**，
 * 大小寫不同就是不同的一句話，不能悄悄對上。
 */
export function findFirstFolded(text: string, needle: string): Span | null {
  const exact = findFirst(text, needle);
  if (exact !== null) return exact;

  const haystack = squash(text, true);
  const flatNeedle = squash(needle, true).flat;
  if (flatNeedle.length === 0) return null;
  const at = haystack.flat.indexOf(flatNeedle);
  return at < 0 ? null : spanOf(haystack, at, flatNeedle.length);
}

/**
 * 第一個出現位置，**全形與半形標點也視為等價**。
 *
 * 給 `domain/provider/quote.ts` 用 —— **模型寫的引文才需要這一層**。
 * 點註的引文來自使用者自己在同一份文字上框選，標點不會不一樣；
 * 檢索要的是 `findFirstFolded`（大小寫等價）。
 *
 * 先跑一次嚴格的（`findFirst`：精確 → 空白等價），**失敗了才放寬** ——
 * 分層的理由是精確度：能嚴格對上的就不要用寬鬆的規則去對，
 * 否則兩個只差一個標點的句子會被對到同一個地方。
 */
export function findFirstFoldingPunctuation(
  text: string,
  needle: string,
  dropCjkAdjacentSpace = false,
): Span | null {
  const strict = findFirst(text, needle);
  if (strict !== null) return strict;

  const haystack = squash(text, false, true, dropCjkAdjacentSpace);
  const flatNeedle = squash(needle, false, true, dropCjkAdjacentSpace).flat;
  if (flatNeedle.length === 0) return null;
  const at = haystack.flat.indexOf(flatNeedle);
  return at < 0 ? null : spanOf(haystack, at, flatNeedle.length);
}
