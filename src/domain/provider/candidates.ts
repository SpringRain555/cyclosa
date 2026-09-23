/**
 * 研究的候選來源：找來源那一步交回來的東西（Stage 20，ADR-0033 D7、REQ-0009 R7）。
 *
 * ## 跟舊的擴展差在哪
 *
 * 舊的只要網址與「為什麼」（`angles.ts` 的 `normalizeCandidates`，Stage 22 跟著擴展退場）。
 * 研究的候選要能變成**書目節點**（拿不到的那一份，D12），所以多了：
 *
 * - **`title`**：搜尋結果上的標題，原文，不翻 —— 書目節點要有名字
 * - **作者、年份、出處**：**搜尋結果裡看得到才填**，不叫模型猜。一個猜出來的年份
 *   會以一個精確的樣子出現在書目上，而那正是這個工具在避免的東西（同 ADR-0017）
 *
 * ## 這裡處理的是模型輸出，也就是外部輸入
 *
 * 跟 `plan.ts` 同一條規則：每一行都假設對面會回垃圾。網址不是 http(s) 的丟掉、
 * 重複的丟掉、欄位超長的切掉、年份不像年份的清成空字串。**真正的網址正規化與去重
 * 在擷取管線與寫入那一層**（`domain/ingest/url.ts`）—— 這裡只做最粗的一層。
 */

/**
 * 一條方向最多帶幾個候選回來。
 *
 * 十二條方向 × 8 ＝ 最多 96 筆 —— ADR-0033「什麼情況要重新考慮」寫著
 * 「一次研究的候選常常超過一百筆，確認畫面要有批次操作」，這個上限讓那一天晚一點來。
 * **超過要說**（`overflow`），跟方向的上限同一條規則（R6）。
 */
export const MAX_CANDIDATES_PER_DIRECTION = 8;

/** 各欄的長度上限。**匯出的理由是它們要進 schema**（`research-prompts.ts`）。 */
export const MAX_CANDIDATE_URL_CHARS = 2048;
export const MAX_CANDIDATE_TITLE_CHARS = 200;
export const MAX_CANDIDATE_WHY_CHARS = 200;
export const MAX_CANDIDATE_AUTHORS_CHARS = 160;
export const MAX_CANDIDATE_VENUE_CHARS = 120;
/** 年份那一欄收得下「(2024) 年」這種寫法就夠了 —— 收下來之後只留四位數。 */
export const MAX_CANDIDATE_YEAR_CHARS = 16;

/** 搜尋結果上看得到的書目欄位。**沒有就是空字串**，不是 `null`，也不是猜的。 */
export interface Bibliography {
  readonly authors: string;
  /** 四位數的年份，或空字串 */
  readonly year: string;
  /** 期刊、會議、出版社、網站名 */
  readonly venue: string;
}

export const EMPTY_BIBLIOGRAPHY: Bibliography = { authors: '', year: '', venue: '' };

export interface CandidateDraft {
  readonly url: string;
  /** 搜尋結果上的標題。**模型沒給就是空字串** —— 畫面退回網址，不替它編一個 */
  readonly title: string;
  /** 為什麼跟這條方向有關（繁中一句）。只給人看，不進任何規則 */
  readonly why: string;
  readonly bib: Bibliography;
}

export interface CandidateBatch {
  readonly candidates: readonly CandidateDraft[];
  /** 模型給的超過上限。**畫面照實說**，不靜默截掉 */
  readonly overflow: boolean;
}

type Raw = Record<string, unknown>;

/** 同 `plan.ts` 的 `text()`：刻意各留一份（那一支跟規劃走，這一支跟蒐集走）。 */
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * 年份：**一個像年份的四位數，否則空字串**。
 *
 * 「2024」「2024 年」「(2024)」都收成 2024；「近年」「2024–2025」「24」不收 ——
 * 範圍與縮寫要人看，不是我們替它選一個。
 */
function yearOf(value: unknown): string {
  const raw = text(value, MAX_CANDIDATE_YEAR_CHARS);
  const match = /^\(?((?:1[5-9]|20)\d{2})\)?\s*年?$/.exec(raw);
  return match?.[1] ?? '';
}

export function normalizeBibliography(raw: unknown): Bibliography {
  if (typeof raw !== 'object' || raw === null) return EMPTY_BIBLIOGRAPHY;
  const row = raw as Raw;
  return {
    authors: text(row['authors'], MAX_CANDIDATE_AUTHORS_CHARS),
    year: yearOf(row['year']),
    venue: text(row['venue'], MAX_CANDIDATE_VENUE_CHARS),
  };
}

/**
 * 整理一條方向交回來的候選。**不丟例外** —— 垃圾進來回一份空的清單。
 *
 * 書目欄位在模型那一份裡跟網址放在同一層（schema 比較好寫），在這裡收成 `bib`。
 */
export function normalizeResearchCandidates(raw: unknown): CandidateBatch {
  const list = Array.isArray(raw) ? raw : [];
  const out: CandidateDraft[] = [];
  const seen = new Set<string>();
  let overflow = false;

  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Raw;
    const url = text(row['url'], MAX_CANDIDATE_URL_CHARS);
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    if (seen.has(url)) continue;
    // **上限之後不是 break** —— 要知道多出來的那幾條是真的網址才算 overflow（同 `normalizePlan`）。
    if (out.length >= MAX_CANDIDATES_PER_DIRECTION) {
      overflow = true;
      continue;
    }
    seen.add(url);
    out.push({
      url,
      title: text(row['title'], MAX_CANDIDATE_TITLE_CHARS),
      why: text(row['why'], MAX_CANDIDATE_WHY_CHARS),
      bib: normalizeBibliography(row),
    });
  }
  return { candidates: out, overflow };
}
