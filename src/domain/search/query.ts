/**
 * 查詢那一半。**純函式，零 I/O** —— SQL 在 `infrastructure/index/reader.ts`。
 *
 * 寫入那一半從 Stage 6 就在跑（bigram 表、FTS5、`title_rank`）。
 * 這一支是它的另一端，而它要處理一件寫入那一半沒有的問題：**誤中**。
 *
 * ## 一、索引依 `item.lang` 建，查詢依**查詢字串本身**選路
 *
 * 建索引的時候我們知道那份東西是什麼語言；**查的時候不知道要找的是什麼語言**。
 * 所以路由的依據換了一個：查詢字串裡有 CJK 就走 bigram，有非 CJK 的字就走 FTS5，
 * 兩種都有就兩條都走再合併。
 *
 * 這不是對稱的失敗：`und` 的內容兩邊都建了索引（ADR-0009 第 2 條），
 * 所以「猜不出語言」的那些在兩條路上都找得到。
 *
 * ## 二、索引找候選，**正文確認**
 *
 * ADR-0009 的代價那一節寫著：
 *
 * > bigram 會跨詞誤中（查「台積」可能命中「…來台積極…」），
 * > 所以**結果排序變得比索引本身重要**。
 *
 * 而誤中在索引層是**看不出來的** —— `bigram` 表裡只有 gram、owner 與次數，
 * 沒有位置。查「台積電」切出「台積」與「積電」兩個 gram，兩個都在同一份文件裡，
 * 但它們可能落在相隔三千字的兩個地方，而索引沒有任何欄位說得出這件事。
 *
 * **唯一分得出來的地方是正文本身。** 所以這一階段的判準跟 Stage 11 匯出時
 * 重新驗引文是同一個：**不採信索引，回去看原文。**
 *
 * ## 三、確認不過的不丟掉，標示出來
 *
 * 丟掉會讓搜尋在兩種情況下說謊：正文檔案不在（`derived/` 是可拋的），
 * 以及**空白或大小寫的差異讓字串比對失敗、而它其實是對的**。
 * 所以三種狀態各自有名字，跟 Stage 11 的引文一樣：
 *
 * | | 意思 |
 * |---|---|
 * | `hit` | 正文裡真的有這串字，位置也拿到了 |
 * | `miss` | 正文讀得到，但裡面沒有這串字 —— **這就是跨詞誤中** |
 * | `no-text` | 正文讀不到，**沒驗**。不是誤中，是不知道 |
 *
 * 合成一個布林值就會把最後一種說成「誤中」，而那是一句錯話。
 */
import { findFirstFolded, type Span } from '../text/offsets.js';
import { bigrams, latinRuns, normalize } from './tokenize.js';

/** 走哪一條（或兩條）索引。 */
export type QueryRoute = 'bigram' | 'fts' | 'both';

export interface ParsedQuery {
  /** 使用者打的字串，去掉頭尾空白。**顯示與正文確認用的是它。** */
  readonly raw: string;
  /** CJK 的部分切出來的 gram，全部要命中（AND）。 */
  readonly grams: readonly string[];
  /** 送進 FTS5 `MATCH` 的片語。沒有非 CJK 的字時是 `null`。 */
  readonly phrase: string | null;
  readonly route: QueryRoute;
}

/**
 * FTS5 的片語字串。
 *
 * **一律包成片語並把內部的雙引號重複一次跳脫**（跟 `tokenize.ts` 的
 * `toFtsPhrase` 同一個理由）：直接把使用者輸入丟給 `MATCH` 會讓
 * `AND`、`NEAR`、`*`、`^` 變成語法。那不是 SQL 注入（參數化擋得住那個），
 * 是**注入 FTS5 的查詢語言**，而參數化對它完全沒有作用。
 *
 * 多段的話用空白接起來包成一個片語 —— 它們本來就相鄰。
 */
function toPhrase(runs: readonly string[]): string {
  return `"${normalize(runs.join(' ')).replace(/"/g, '""')}"`;
}

/** 空字串、或只有空白 → `null`（呼叫端回 `SEARCH_QUERY_EMPTY`）。 */
export function parseQuery(raw: string): ParsedQuery | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const grams = [...bigrams(trimmed).keys()];
  const runs = latinRuns(trimmed);
  const phrase = runs.length > 0 ? toPhrase(runs) : null;

  if (grams.length === 0 && phrase === null) return null;
  const route: QueryRoute =
    grams.length > 0 && phrase !== null ? 'both' : grams.length > 0 ? 'bigram' : 'fts';

  return { raw: trimmed, grams, phrase, route };
}

// ── 正文確認 ────────────────────────────────────────────────

export type CheckStatus = 'hit' | 'miss' | 'no-text';

export interface Checked {
  readonly status: CheckStatus;
  /** `hit` 時是原文裡的位置；其餘是 `null`。 */
  readonly span: Span | null;
}

/**
 * 在正文裡找查詢字串。
 *
 * `text` 是 `null` 代表**正文讀不到**（`derived/` 可以被清掉，那是它的定義），
 * 而那跟「找不到」是兩件事 —— 見這個檔案開頭的第三點。
 *
 * 比對本身空白視為等價、大小寫視為等價（`findFirstFolded`）：
 * 抽取器換版之後空白會變，而「Cyclosa」與「cyclosa」是同一個字。
 */
export function checkText(text: string | null, query: string): Checked {
  if (text === null) return { status: 'no-text', span: null };
  const span = findFirstFolded(text, query);
  return span === null ? { status: 'miss', span: null } : { status: 'hit', span };
}

// ── 排序 ────────────────────────────────────────────────────

export interface RankableHit {
  readonly id: string;
  readonly status: CheckStatus;
  /** 命中的位置在標題裡（正文的前面接著標題，見 `indexText`）。 */
  readonly inTitle: boolean;
  /** 索引給的分數：bigram 是次數總和，FTS5 是 `-bm25`。 */
  readonly indexScore: number;
  /** 中文標題的名次，同分時的穩定決勝（`collate.ts`）。 */
  readonly titleRank: string;
}

/**
 * 排序。**確認過的在前面，而「沒驗」排在「誤中」前面。**
 *
 * 那個順序是刻意的：`no-text` 的那一份可能完全正確（只是正文被清掉了），
 * 而 `miss` 的那一份我們**已經看過正文、確定裡面沒有這串字**。
 * 把不知道的排在確定不對的前面。
 *
 * 標題命中排在正文命中前面：使用者查的常常就是標題裡的詞。
 */
const TIER: Readonly<Record<CheckStatus, number>> = { hit: 0, 'no-text': 1, miss: 2 };

export function rankHits<T extends RankableHit>(hits: readonly T[]): readonly T[] {
  return [...hits].sort((a, b) => {
    const tier = TIER[a.status] - TIER[b.status];
    if (tier !== 0) return tier;
    if (a.status === 'hit' && b.status === 'hit' && a.inTitle !== b.inTitle) {
      return a.inTitle ? -1 : 1;
    }
    if (a.indexScore !== b.indexScore) return b.indexScore - a.indexScore;
    const byRank = a.titleRank.localeCompare(b.titleRank);
    return byRank !== 0 ? byRank : a.id.localeCompare(b.id);
  });
}

// ── 摘要 ────────────────────────────────────────────────────

/** 命中位置前後各留幾個字。中文一行大約 30–40 個字，兩邊各 48 大概是三行。 */
export const SNIPPET_RADIUS = 48;

export interface Snippet {
  readonly text: string;
  /** 命中在 `text` 裡的位置 —— **前端拿它上色，不用自己再找一次。** */
  readonly matchStart: number;
  readonly matchEnd: number;
  readonly cutHead: boolean;
  readonly cutTail: boolean;
}

/**
 * 命中處前後切一段出來。
 *
 * **位置一起回**，因為前端如果自己在摘要裡再找一次字串，
 * 它會找到摘要裡**另一個**同樣的字（一段話裡出現兩次很常見），
 * 於是畫面上上色的那一個不是命中的那一個。
 */
export function snippetAround(text: string, span: Span, radius = SNIPPET_RADIUS): Snippet {
  const from = Math.max(0, span.start - radius);
  const to = Math.min(text.length, span.end + radius);
  return {
    text: text.slice(from, to).replace(/\s+/g, ' ').trim(),
    // `replace` 之後長度會變，所以位置要在壓縮前算完再校正一次。
    ...offsetsAfterSquash(text.slice(from, to), span.start - from, span.end - from),
    cutHead: from > 0,
    cutTail: to < text.length,
  };
}

/**
 * 把「壓過空白之前」的位置換算成「壓過之後」的位置。
 *
 * 摘要要壓掉換行（一段正文裡的換行在一行摘要裡只會變成破洞），
 * 而壓完之後位置會往前移。不校正的話上色會偏移，**而偏移量剛好等於
 * 命中位置前面有幾個多餘的空白** —— 也就是說中文正文上偏移通常是 0，
 * 所以這個錯很容易在測試裡漏掉，直到遇上一份排版鬆散的英文頁面。
 */
function offsetsAfterSquash(
  raw: string,
  start: number,
  end: number,
): { matchStart: number; matchEnd: number } {
  let out = 0;
  let matchStart = 0;
  let matchEnd = 0;
  let inSpace = false;
  let leading = true;

  for (let i = 0; i < raw.length; i++) {
    if (i === start) matchStart = out;
    if (i === end) matchEnd = out;
    const isSpace = /\s/.test(raw[i] as string);
    if (isSpace) {
      if (!inSpace && !leading) out++;
      inSpace = true;
    } else {
      out++;
      inSpace = false;
      leading = false;
    }
  }
  if (end >= raw.length) matchEnd = out;
  return { matchStart, matchEnd: Math.max(matchStart, matchEnd) };
}
