/**
 * 語意檢索的分塊：**一份正文切成幾段，每段一個向量。**
 *
 * ## 為什麼不是一份文件一個向量
 *
 * 兩個理由，而第一個是產品層的：
 *
 * 1. **命中要指得回原文。** 這個工具從 Stage 8 起每一條斷言都要能回到
 *    `item` 與字元區間（引文、出處、匯出、點註都是）。
 *    一份文件一個向量的話，「這份文件跟你問的有關」是它能說的全部 ——
 *    **而畫面上沒有東西可以標。**
 * 2. **選模型那一輪量的就是段落級**（`research/embedding-choice.md`，
 *    1955 段、50 條查詢、跨語言 MRR 0.940）。換成文件級的話，
 *    那個 0.940 對出貨的東西**不成立** —— 它量的是另一個系統。
 *
 * ## 所以這一支跟量測用的那一支要是同一份
 *
 * 切法原本住在 `tools/research/fetch-eval-corpus.ts` 裡。
 * 留在那裡的話會有兩份切法，而**抄的那一份會漂** ——
 * 這個 repo 為同一種形狀修過五次（agent 檔清單、卡片的 `data_root`、
 * `docs/index.md` 的現況欄、設定頁的建議模型、`CHAT_TIMEOUT_MS`）。
 * 漂掉的症狀特別糟：出貨的檢索品質**不再是量出來的那個數字**，
 * 而沒有任何地方會報錯。
 *
 * 所以切法搬到這裡，研究工具改成 import 它。
 *
 * ## 參數由**文字本身**決定，不是由語言碼決定
 *
 * 第一版寫的是 `chunkRuleFor(item.lang)`，而它在 2026-09-10 的實測裡
 * 安靜地丟掉了一整份文件：那份正文只有 97 個字，
 * **短於 `detectLanguage` 的 `MIN_SAMPLE_CHARS`（100）所以語言是 `und`**，
 * 而 `und` 不是 CJK 語言 → 套上拉丁那組（min 320）→ 97 < 320 → 零段 → 沒有向量。
 *
 * 畫面上完全看不出來：那份資料匯入成功、全文檢索查得到、
 * 只有語意檢索永遠找不到它。**而回填會永遠回報「還有 1 份沒算」。**
 *
 * `cjkRatio` 的註解早就寫了這件事的通則 ——
 * 「語言偵測會給出自信而錯誤的答案，所以路由要看得到證據，不能只看標籤」。
 * 這一支現在就照那句話做。
 *
 * ## 中文與英文的目標長度不同，那是量出來的
 *
 * 同樣一段話中文用的字數大約是英文的一半。用同一個字元預算切，
 * 中文段落的資訊量只有英文的一半 —— 而那個差別會被算進模型的分數裡，
 * 於是量到的就不只是模型了。
 *
 * ## 太短的行直接丟掉，而且它同時是一個段落界線
 *
 * Readability 的輸出裡**章節標題就是一行短字**，沒有任何標記分得出來。
 * 把它併進前一段會讓一段話橫跨兩個主題；單獨成段則是一個沒有內容的向量。
 */

import { cjkRatio } from './tokenize.js';

/** 一段。**`text` 是送去嵌入的字串，`[start, end)` 是它在原文裡的範圍。** */
export interface Chunk {
  readonly ord: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * 切分參數。**CJK 與其餘兩套**，理由見檔頭。
 *
 * `short` 是「這一行短到不成段」的門檻 —— 它同時是段落界線。
 */
interface ChunkRule {
  readonly target: number;
  readonly min: number;
  readonly short: number;
}

export const CHUNK_CJK: ChunkRule = { target: 300, min: 120, short: 20 };
export const CHUNK_LATIN: ChunkRule = { target: 800, min: 320, short: 40 };

/**
 * 一份文件最多切幾段。
 *
 * **這個上限不是品質決定的，是預算決定的**，而那個預算是 Stage 13 的一條：
 * 5 萬筆暴力比對要在 500 ms 內。2026-09-09 量到 5 萬條 2560 維的向量
 * 是 **69 ms**，線性外推到 500 ms 大約是 **35 萬條**。
 *
 * 5 萬份資料 × 這個上限要落在 35 萬以內，所以是 7 —— 取 **6**，留一點餘裕
 * 給實體與點註的向量（它們也佔位置）。
 *
 * **超過上限的那些段落不是被合併，是被丟掉的**，而那是一個真的損失：
 * 一份長文件的後半在語意檢索裡看不見。
 * 兩件事讓這個損失可以接受，而它們都要寫出來：
 *
 * - **全文檢索沒有這個上限** —— bigram 與 FTS5 收整份正文，
 *   所以「正文裡到底有沒有這串字」在任何長度都答得出來。
 * - 抽取那一步早就只看前 12,000 字（`MAX_TEXT_CHARS`），
 *   所以「長文件的後半處理得比較淺」在這個工具裡不是新規則。
 *
 * **這個數字要在 Stage 13 用真的 5 萬筆重新量。** 上面那個外推是線性的，
 * 而 5 萬到 35 萬之間有沒有別的東西變成瓶頸（記憶體、GC）沒有量過。
 */
export const MAX_CHUNKS_PER_ITEM = 6;

/**
 * 這一段文字裡有多少 CJK 就算「用 CJK 在寫」。
 *
 * 跟 `language.ts` 的 `CJK_PRESENT` 是同一個數字，**但不是同一個問題**：
 * 那一邊問的是「宣告的語言與內容矛不矛盾」，這一邊問的是
 * 「一個字大約承載多少意思」。兩個問題剛好在同一條線上，
 * 而**把它們綁成同一個常數會讓其中一邊改不動**。
 */
export const CJK_MIX_RATIO = 0.15;

/** 這一段文字該用哪一組參數。**看文字，不看語言碼** —— 理由見檔頭。 */
export function chunkRuleFor(text: string): ChunkRule {
  return cjkRatio(text) >= CJK_MIX_RATIO ? CHUNK_CJK : CHUNK_LATIN;
}

/**
 * 切段。
 *
 * **回傳的 `text` 是行與行之間用空白接起來的**，所以它不一定是原文的子字串；
 * 而 `[start, end)` 一定是原文裡的真實範圍。
 * 兩者的分工是刻意的：前者是送去嵌入的東西（換行對嵌入沒有意義），
 * 後者是**畫面上要標的位置**，而那必須指得回沒有被動過的正文。
 */
export function chunkText(
  text: string,
  /**
   * **量測要傳 `Infinity`。**
   *
   * 上限是預算決定的，而評測語料要的是「這份文件全部切出來長什麼樣」——
   * 帶著上限去量會讓語料只剩 34×6 段，量到的就是另一個東西。
   * 預設值是出貨的行為，所以**忘了傳的那一邊是安全的那一邊**。
   */
  maxChunks: number = MAX_CHUNKS_PER_ITEM,
): readonly Chunk[] {
  const rule = chunkRuleFor(text);
  const out: Chunk[] = [];

  let buffer: { text: string; start: number; end: number }[] = [];
  const flush = (): void => {
    const lines = buffer;
    buffer = [];
    if (lines.length === 0) return;
    const joined = lines
      .map((l) => l.text)
      .join(' ')
      .trim();
    if (joined.length < rule.min) return;
    if (out.length >= maxChunks) return;
    out.push({
      ord: out.length,
      start: lines[0]?.start ?? 0,
      end: lines[lines.length - 1]?.end ?? 0,
      text: joined,
    });
  };

  // **自己走位置，不用 `split`** —— `split('\n')` 之後就沒有偏移量了，
  // 而偏移量正是這一支存在的一半理由。
  let cursor = 0;
  while (cursor <= text.length) {
    const nl = text.indexOf('\n', cursor);
    const lineEnd = nl < 0 ? text.length : nl;
    const raw = text.slice(cursor, lineEnd);
    // trim 過的那一段在原文裡的真實範圍
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length < rule.short) {
      // 標題／短殘留：它本身不成段，但它代表一個段落界線。
      flush();
    } else {
      buffer.push({ text: trimmed, start: cursor + lead, end: cursor + lead + trimmed.length });
      if (buffer.reduce((n, l) => n + l.text.length + 1, -1) >= rule.target) flush();
    }
    if (nl < 0) break;
    cursor = nl + 1;
  }
  flush();

  /**
   * **整份文件都切不出一段的話，就整份當成一段。**
   *
   * `min` 那條門檻是用來丟**文件裡的碎片**的（章節標題、導覽殘留、
   * 結尾那半段），而不是用來丟**整份短文件**的。
   * 兩者的差別在 2026-09-10 之前不存在，於是一份 97 個字的資料
   * 完全沒有向量 —— 語意檢索永遠找不到它，而**回填會永遠說「還有 1 份沒算」**
   * （`processed` 每次都是 1、`written` 每次都是 0、`remaining` 不動）。
   *
   * 所以這裡有一個保底：非空的正文一定至少產生一段。
   * 它同時讓「沒有向量」這件事變成只有一個原因（正文是空的），
   * 而那個原因是回填**收斂得了**的。
   */
  if (out.length === 0) {
    const whole = text.trim();
    if (whole.length > 0) {
      const start = text.indexOf(whole[0] as string);
      return [{ ord: 0, start, end: start + whole.length, text: whole.replace(/\s+/gu, ' ') }];
    }
  }
  return out;
}
