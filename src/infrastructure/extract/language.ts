/**
 * 語言偵測。**偵測不出來記 `und`，不猜**（`multilingual.md`）。
 *
 * > 猜錯的代價不是「標籤錯了」，是**索引走錯路**：
 * > 一份中文內容被判成英文就只進 FTS5 `unicode61`，
 * > 而 `unicode61` 會把一整段沒有空白的中文當成一個 token —— 等於沒有索引。
 *
 * ## 2026-09-07 量測發現的事
 *
 * **`franc` 對短的或碎片化的文字會給出自信而錯誤的答案，而不是回 `und`。**
 * 34 個真實頁面裡：69 個字的頁面被判成 `fra`、一頁滿是使用者代號與日期的
 * 中文論壇索引被判成 `deu`。
 *
 * 所以這裡在 `franc` 外面加兩道**用證據推翻標籤**的閘門。
 * 兩道都只會把答案推向 `und` —— **而 `und` 的內容兩條索引都建**，
 * 所以推翻的代價是多一份索引，漏掉的代價是查不到。
 */
import { franc } from 'franc';

import { cjkRatio, isCjkLanguage } from '../../domain/search/tokenize.js';

/** `franc` 短文字會回 `und`，這正是我們要的行為 —— 不要把它「修好」。 */
export const UNDETERMINED = 'und';

/** 少於這麼多字就不問了。量測裡出錯的那幾頁都在這條線以下或剛好在附近。 */
export const MIN_SAMPLE_CHARS = 100;

/** 文字裡 CJK 比例超過這個值，就不可能是拉丁語系。 */
const CJK_PRESENT = 0.15;
/** 幾乎沒有 CJK 字元，卻被判成 CJK 語言 —— 同樣是矛盾。 */
const CJK_ABSENT = 0.02;

export function detectLanguage(text: string): string {
  const sample = text.trim();
  if (sample.length < MIN_SAMPLE_CHARS) return UNDETERMINED;

  // franc 回 ISO 639-3（中文是 `cmn`）。**`item.lang` 的詞彙表就是 ISO 639-3**，
  // 不要在這裡轉成 BCP-47 —— 兩套詞彙混用會讓 `indexTargets` 的比對漏掉。
  const code = franc(sample);
  if (code === 'und') return UNDETERMINED;

  const ratio = cjkRatio(sample);
  const saysCjk = isCjkLanguage(code);
  if (!saysCjk && ratio >= CJK_PRESENT) return UNDETERMINED;
  if (saysCjk && ratio < CJK_ABSENT) return UNDETERMINED;

  return code;
}
