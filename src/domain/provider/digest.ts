/**
 * 初讀：模型把一份抓回來（或上傳）的候選讀一次，交回「跟這次研究有沒有關」與繁中標題、繁中摘要
 * （Stage 21，ADR-0033 D9、REQ-0009 R14–R16）。
 *
 * ## 為什麼判斷與摘要是同一次呼叫
 *
 * 貴的是把正文送出去，不是多回兩個欄位（D9）。分成兩個任務的話，同一份正文送兩次。
 *
 * ## 這裡處理的是模型輸出，也就是外部輸入
 *
 * 跟 `candidates.ts`、`plan.ts` 同一條規則：每一行都假設對面會回垃圾。
 * `relevance` 不是三個值之一的，**整份不採用**（回 `null`）—— 一個猜出來的「有關」會變成確認畫面上
 * 「進圖」的預設值（D10），那是這個欄位唯一的用途，所以它錯的代價最大。
 * 標題與摘要超長的切掉、空的就是空的（畫面退回原文，不替它編一個）。
 *
 * ## 繁中標題與摘要是衍生物
 *
 * 它們寫進 `item` 的另外四欄（`title_zh`、`summary_zh`、`digested_by`、`digested_at`），
 * **原文欄位永遠不被覆蓋**（`multilingual.md`、R15）；刪掉這四欄，原文完全不變。
 */

export const RELEVANCES = ['yes', 'no', 'unsure'] as const;
export type Relevance = (typeof RELEVANCES)[number];

/**
 * 送給模型讀的正文上限（字元）。
 *
 * **初讀要回答的是「跟這次研究有沒有關」與兩三句摘要** —— 論文的摘要與緒論、網頁的前幾段就夠了，
 * 整份送出去只是把錢花在它不會用到的地方（走線上端點的話是真的錢）。
 * 抽取的上限是 12,000（`MAX_TEXT_CHARS`），這裡取一半。
 *
 * 這個數字與 `TASK_DIGEST.minContextTokens` 綁在一起（`tests/guards/extract-context.test.ts`）。
 */
export const DIGEST_TEXT_CHARS = 6_000;

/**
 * 提示詞裡「這是哪一份、在查什麼」那幾行各自的上限。**它們是脈絡，不是要讀的東西** ——
 * 而沒有上限的話 context 算不準（`TASK_DIGEST`）：網址最長可以到 2,048 字元，主題是使用者自己打的字。
 */
export const DIGEST_TOPIC_CHARS = 200;
export const DIGEST_SOURCE_TITLE_CHARS = 200;
export const DIGEST_URL_CHARS = 300;

/** 各欄的長度上限。**匯出的理由是它們要進 schema**（`research-prompts.ts`）。 */
export const MAX_DIGEST_WHY_CHARS = 160;
export const MAX_DIGEST_TITLE_CHARS = 160;
/** 兩三句繁中。**給上限是為了讓它不變成全文翻譯**（R16：全文不翻）。 */
export const MAX_DIGEST_SUMMARY_CHARS = 360;

export interface Digest {
  readonly relevance: Relevance;
  /** 一句理由：為什麼有關／沒關／說不準 */
  readonly why: string;
  /** 繁中標題。原文已經是繁中的時候，模型可以照抄 */
  readonly titleZh: string;
  /** 兩三句繁中摘要 */
  readonly summaryZh: string;
}

type Raw = Record<string, unknown>;

/** 同 `candidates.ts` 的 `text()`：空白壓成一個、切到上限。 */
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export function isRelevance(value: unknown): value is Relevance {
  return RELEVANCES.includes(value as Relevance);
}

/**
 * 整理模型交回來的那一份。**不丟例外**：形狀不對或 `relevance` 不是三個值之一，回 `null`
 * （呼叫端把它記成那一份的初讀失敗，其餘照常 —— 部分完成是一等公民）。
 *
 * 標題與摘要**兩個都空**也回 `null`：那是一份什麼都沒讀出來的初讀，而畫面上的「繁中」會是一片空白。
 */
export function normalizeDigest(raw: unknown): Digest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Raw;
  const relevance = row['relevance'];
  if (!isRelevance(relevance)) return null;
  const titleZh = text(row['title_zh'], MAX_DIGEST_TITLE_CHARS);
  const summaryZh = text(row['summary_zh'], MAX_DIGEST_SUMMARY_CHARS);
  if (titleZh.length === 0 && summaryZh.length === 0) return null;
  return {
    relevance,
    why: text(row['why'], MAX_DIGEST_WHY_CHARS),
    titleZh,
    summaryZh,
  };
}

/** 中日韓的字（漢字、假名、諺文）。 */
const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * 初讀交回的「繁中標題」，**沒翻就當沒有**（2026-10-28 試用回饋 7；roadmap 四(a)）。
 *
 * 初讀的提示詞要的是繁中翻譯（原文已是繁中就照抄），但 granite 在 #11 量測裡 28 份只翻 1 份，
 * 試用時 22 份有 15 份是原文照抄 —— 畫面切到「繁中」看到的是英文，還標著「譯文」。
 * 判準刻意簡單：**一個中日韓的字都沒有，就不是繁中標題**。原文是中文、照抄過來的那種有中文字，照樣留著。
 * 這是讀的時候的判斷，資料庫裡模型交回的那一格不動。
 */
export function translatedTitleOf(titleZh: string | null): string | null {
  if (titleZh === null) return null;
  const trimmed = titleZh.trim();
  return trimmed.length > 0 && HAS_CJK.test(trimmed) ? trimmed : null;
}

/**
 * 送出去的正文：**開頭那一段**，切在上限。
 *
 * 不從中間挑「最重要的幾段」—— 那要先有一個判斷，而判斷就是這一次呼叫要做的事。
 * 論文與報導的開頭本來就是摘要與導言。
 */
export function digestExcerpt(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > DIGEST_TEXT_CHARS ? trimmed.slice(0, DIGEST_TEXT_CHARS) : trimmed;
}
