/**
 * 檢索用的切分。**純函式，零 I/O** —— 寫進索引表的是 `infrastructure/index/`。
 *
 * 分成兩條路是實測的結果（`data-model.md`）：
 * FTS5 的 `trigram` 對**兩個字**的中文查詢**命中 0 列**，
 * 而中文查詢多半是兩個字。所以中文自建 bigram，拉丁走 FTS5 `unicode61`。
 */

/** 一次寫進索引的字串上限。超過的截斷 —— 索引是為了找得到，不是為了完整重現。 */
export const MAX_INDEX_CHARS = 200_000;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 這個字元要不要走 bigram 那條路。 */
export function isCjk(ch: string): boolean {
  return CJK.test(ch);
}

/**
 * 文字裡有多少比例是 CJK（不算空白）。
 *
 * 它存在的理由是**語言偵測會給出自信而錯誤的答案**：2026-09-07 的量測裡，
 * 一頁只有 69 個字的頁面被判成法文，一頁滿是使用者代號的中文論壇被判成德文。
 * 判錯語言的代價不是標籤錯，是**索引走錯路**（`multilingual.md`）——
 * 所以路由要看得到證據，不能只看標籤。
 */
export function cjkRatio(text: string): number {
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    total++;
    if (isCjk(ch)) cjk++;
  }
  return total === 0 ? 0 : cjk / total;
}

/** 這個 ISO 639-3 碼是不是 CJK 語言。 */
export function isCjkLanguage(lang: string): boolean {
  return ['cmn', 'zho', 'yue', 'jpn', 'kor', 'zh', 'ja', 'ko', 'nan', 'hak', 'wuu'].includes(lang);
}

/**
 * 正規化。**索引與查詢一定要用同一支** ——
 * 兩邊各自正規化是這類索引最典型的失效方式，而它不會報錯，只會查不到。
 */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/**
 * 中文 bigram。
 *
 * 連續的 CJK 字元切成相鄰兩字；**長度為 1 的連續段落收 unigram**
 * （「A股」的「股」、單字姓氏），否則那個字永遠查不到。
 * 長度 ≥2 的段落**不收 unigram** —— 那會讓索引膨脹成接近全字表，
 * 而它換到的東西（單字查詢）在中文裡幾乎沒有意義。
 */
export function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const src = normalize(text).slice(0, MAX_INDEX_CHARS);
  const chars = [...src];

  let run: string[] = [];
  const flush = (): void => {
    if (run.length === 1) {
      const gram = run[0] as string;
      out.set(gram, (out.get(gram) ?? 0) + 1);
    } else {
      for (let i = 0; i + 1 < run.length; i++) {
        const gram = `${run[i] as string}${run[i + 1] as string}`;
        out.set(gram, (out.get(gram) ?? 0) + 1);
      }
    }
    run = [];
  };

  for (const ch of chars) {
    if (isCjk(ch)) run.push(ch);
    else if (run.length > 0) flush();
  }
  if (run.length > 0) flush();

  return out;
}

/**
 * 查詢字串切成要 AND 起來的 gram。
 *
 * **和索引用同一支 `bigrams`**，只是丟掉次數。
 * 兩個字的查詢會切出一個 gram，三個字切出兩個（AND）—— 這正是
 * `trigram` 做不到的那件事。
 */
export function queryGrams(query: string): readonly string[] {
  return [...bigrams(query).keys()];
}

/**
 * 拉丁／西里爾等要不要進 FTS5。
 *
 * **`und` 兩條路都建**（`data-model.md`）—— 偵測不出語言時我們不猜，
 * 而不猜的代價就是兩份索引。
 */
export function indexTargets(lang: string): { readonly bigram: boolean; readonly fts: boolean } {
  if (lang === 'und') return { bigram: true, fts: true };
  if (isCjkLanguage(lang)) return { bigram: true, fts: false };
  return { bigram: false, fts: true };
}

/**
 * 送進 FTS5 `MATCH` 的字串。
 *
 * **一律包成片語（雙引號）並把內部的雙引號重複一次跳脫。**
 * 直接把使用者輸入丟給 `MATCH` 會讓 `AND`、`NEAR`、`*`、`^` 變成語法 ——
 * 那不是注入 SQL（參數化擋得住那個），是注入 **FTS5 的查詢語言**，
 * 而參數化對它完全沒有作用。
 */
export function toFtsPhrase(query: string): string {
  return `"${normalize(query).replace(/"/g, '""')}"`;
}
