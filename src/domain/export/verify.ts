/**
 * 匯出時**重新驗一次**每一條引文。
 *
 * ## 為什麼不是直接把 `edge_evidence` 抄出來
 *
 * 那三欄（`quote`、`char_start`、`char_end`）是**寫進去那一刻**的事實，
 * 而 `derived/` 是可以整批重算的（`POST …/rebuild`）。
 * 重算之後正文的字元位移會變 —— 抽取器改了一行、多留一個換行，
 * 整份文件後面每一個位移就全部平移。
 *
 * 所以直接抄出來的證據包會有一種特別糟的錯：
 * **每一條看起來都完整（有引文、有 id、有區間），而區間指到別的地方。**
 * 而證據包正是拿去給別人驗的東西 —— 它是這個工具裡最不能靠運氣的一份輸出。
 *
 * 同一個判準在這個專案裡出現第三次：
 * v0.5.0 不採信模型給的位置、v0.6.0 不採信前端送來的引文，
 * 而這裡不採信自己資料庫裡存的位置。
 * **三次的理由相同：一個指錯位置的引用比沒有引用更糟，因為它看起來已經驗過了。**
 *
 * ## 三種結果，而第三種也要匯出
 *
 * | 結果 | 意思 |
 * |---|---|
 * | `verified` | 那一段字現在就在記著的位置上 |
 * | `shifted` | 引文還在正文裡，但位置變了（`derived/` 重算過）|
 * | `missing` | 正文裡找不到，或者那一份的 `derived/` 不在了 |
 *
 * `missing` 的那幾條**照樣寫進匯出的檔案並標明**，不靜默省略
 * （`error-codes.md` 的 `EXPORT_EVIDENCE_MISSING` 早就這樣寫著）。
 * 省略它們會讓證據包看起來比實際上乾淨 —— 而那是這個工具最不該做的事。
 *
 * ## 這一支不寫回資料庫
 *
 * 位置變了也不去更新 `edge_evidence`。**匯出是唯讀的動作**，
 * 而一個會在你按下匯出時偷偷改掉紀錄的工具，它的紀錄就不再是紀錄。
 * 重算之後要把位置對回去是 `rebuild` 的事，不是匯出的事。
 */
import { findFirst } from '../text/offsets.js';

export type QuoteStatus = 'verified' | 'shifted' | 'missing';

export interface QuoteCheck {
  readonly status: QuoteStatus;
  /** 現在的位置。`missing` 時退回紀錄裡的那一組（**不是 0**）。 */
  readonly start: number;
  readonly end: number;
}

/**
 * 比對一條引文。
 *
 * `text` 是 `null` 代表那一份的 `derived/` 讀不到 —— 那不是「引文不對」，
 * 是**沒有東西可以對**，而兩者對使用者的意思一樣：這一條回溯不到。
 */
export function checkQuote(
  text: string | null,
  quote: string,
  recordedStart: number,
  recordedEnd: number,
): QuoteCheck {
  if (text === null || quote.length === 0) {
    return { status: 'missing', start: recordedStart, end: recordedEnd };
  }

  if (
    recordedStart >= 0 &&
    recordedEnd <= text.length &&
    text.slice(recordedStart, recordedEnd) === quote
  ) {
    return { status: 'verified', start: recordedStart, end: recordedEnd };
  }

  // 位置對不上，但那一段字可能只是搬家了。
  // **比對本身用的是跟 v0.5.0／v0.6.0 同一支** —— 空白視為等價，回原文座標。
  const span = findFirst(text, quote);
  if (span === null) return { status: 'missing', start: recordedStart, end: recordedEnd };
  return { status: 'shifted', start: span.start, end: span.end };
}

/** 一批引文裡回溯不到的有幾條。**匯出的摘要要說出這個數字。** */
export function countMissing(checks: readonly QuoteCheck[]): number {
  return checks.filter((c) => c.status === 'missing').length;
}
