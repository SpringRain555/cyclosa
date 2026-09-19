/**
 * PDF「版面」檢視（v0.24.1）與正文之間的字元位置換算。
 *
 * ## 為什麼需要換算
 *
 * 點註錨在「頁碼 ＋ **那一頁正文**的字元區間」（ADR-0019）。那份正文在 `derived/` 裡，
 * 而且是**重排過的**（`infrastructure/extract/pdf-reflow.ts`）：行接成段落、字塊之間補空白、
 * 行尾的連字號斷字拿掉。版面檢視上使用者選的卻是 pdf.js 文字層的字塊 —— 原樣、沒有重排。
 *
 * 同一串字，兩種空白、兩種連字號。直接拿文字層的位置去存，存進去的區間會落在別的字上。
 *
 * ## 怎麼換算
 *
 * 兩邊都拿掉**空白與連字號**，剩下的叫「骨架」。同一份快照、同一版 pdf.js、同一個
 * `getTextContent()`，重排只動空白與行尾的連字號 —— 所以兩邊的骨架**應該一字不差**，
 * 而一字不差的時候就逐字對應（`aligned`），精確、不用猜。
 *
 * 骨架不一樣（抽取器換過版而還沒重算、或某一頁有沒料到的差異）才退到「在正文的骨架裡找
 * 這一段」（`searched`）。找到一處就是它；找到好幾處時，只有片段夠長才取位置比例最接近的那一處 ——
 * 短片段在一整頁裡到處都是，猜一個等於**錨到錯的地方**，而那正是 ADR-0010 第 5 條不准的事。
 * 找不到就說找不到。
 *
 * 兩個方向都走這一支：選取（文字層 → 正文）與畫高亮（正文 → 文字層）。
 *
 * ⚠️ 純函式，零依賴。前端從 `@domain` 直接引 —— 一份規則兩個實作，遲早會分岔。
 */

export interface Skeleton {
  /** 拿掉空白與連字號之後剩下的字。 */
  readonly chars: string;
  /** `map[i]` ＝ `chars[i]` 在原文的索引（UTF-16，跟整個專案的字元位移同一種單位）。 */
  readonly map: readonly number[];
}

export type LayerMatch =
  | {
      /** `aligned`：骨架一字不差，逐字對應。`searched`：骨架不同，靠找的。 */
      readonly kind: 'aligned' | 'searched';
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'not-found' };

/**
 * 骨架不一致時，重複出現的片段至少要這麼長，才肯取「位置最接近的那一處」。
 * 八個字（拿掉空白之後）大約是兩三個英文字或四個中文詞 —— 短於這個，同一頁裡撞到別處的機會太高。
 */
export const MIN_AMBIGUOUS_CHARS = 8;

/** 空白、連字號（`-`）、軟連字號、Unicode 的兩種連字號。**寫成字碼**，看不見的字元不放進原始碼。 */
function dropped(ch: string): boolean {
  if (/\s/.test(ch)) return true;
  const code = ch.charCodeAt(0);
  return code === 0x2d || code === 0xad || code === 0x2010 || code === 0x2011;
}

export function skeletonOf(text: string): Skeleton {
  const out: string[] = [];
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (dropped(ch)) continue;
    out.push(ch);
    map.push(i);
  }
  return { chars: out.join(''), map };
}

/** 第一個 `map[i] >= value` 的 `i`；都比它小就回 `map.length`。 */
function lowerBound(map: readonly number[], value: number): number {
  let lo = 0;
  let hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((map[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 骨架已經算好的版本 —— 同一頁要畫好幾則高亮的時候，骨架只算一次。
 *
 * `from`／`to` 是 `source` 原文上的區間（`to` 不含）。回的是 `target` 原文上的區間，
 * **頭尾都落在真的有字的地方**（前後的空白與連字號不算在裡面）。
 */
export function mapBetween(
  source: Skeleton,
  target: Skeleton,
  from: number,
  to: number,
): LayerMatch {
  if (!(to > from)) return { kind: 'not-found' };
  const a = lowerBound(source.map, from);
  const b = lowerBound(source.map, to);
  // 選到的全是空白或連字號：沒有字可以對。
  if (b <= a) return { kind: 'not-found' };

  if (source.chars === target.chars) {
    return {
      kind: 'aligned',
      start: target.map[a] as number,
      end: (target.map[b - 1] as number) + 1,
    };
  }

  const needle = source.chars.slice(a, b);
  const hits: number[] = [];
  for (
    let at = target.chars.indexOf(needle);
    at !== -1;
    at = target.chars.indexOf(needle, at + 1)
  ) {
    hits.push(at);
  }
  if (hits.length === 0) return { kind: 'not-found' };
  if (hits.length > 1 && needle.length < MIN_AMBIGUOUS_CHARS) return { kind: 'not-found' };

  // 位置比例最接近的那一處：這一段在來源骨架的哪裡，就去目標骨架的同一個比例附近找。
  const expected = source.chars.length === 0 ? 0 : (a / source.chars.length) * target.chars.length;
  let best = hits[0] as number;
  for (const at of hits) {
    if (Math.abs(at - expected) < Math.abs(best - expected)) best = at;
  }
  return {
    kind: 'searched',
    start: target.map[best] as number,
    end: (target.map[best + needle.length - 1] as number) + 1,
  };
}

/** 一次性的版本：`source` 上的 `[from, to)` 在 `target` 上是哪一段。 */
export function mapAcross(source: string, target: string, from: number, to: number): LayerMatch {
  return mapBetween(skeletonOf(source), skeletonOf(target), from, to);
}
