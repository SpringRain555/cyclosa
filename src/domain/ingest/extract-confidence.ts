/**
 * 抽取信心：**布林標記，不是 0–1 的分數**（REQ-0003、open-questions Q2）。
 * **純函式，零 I/O** —— 訊號是誰算出來的在 `infrastructure/extract/`。
 *
 * > **為什麼不是分數。** 把幾個訊號湊成一個 0.73 很容易，
 * > 而那個 0.73 沒有任何東西支撐它 —— 使用者看到小數會以為它可以比較大小。
 * > 這與 ADR-0017 對「關聯可信度」的結論是同一條：
 * > **連續分數只用於排序與粗略的視覺通道，不顯示成小數給人看。**
 *
 * **每一條門檻都對得上 2026-09-07 那次量測的一列**（34 個真實頁面，
 * 走的是正式的擷取管線）。量測表與逐頁的人工判讀在
 * `docs/research/extraction-confidence.md`。
 * **改門檻要回去改那份量測，不是在這裡調一個數字。**
 */

export interface ExtractSignals {
  /** 抽出來的正文長度（字元）。 */
  readonly textLength: number;
  /** 原始 HTML 長度（字元）。 */
  readonly htmlLength: number;
  /** 抽出來的段落數。 */
  readonly paragraphCount: number;
  /** 正文裡連結文字佔的比例（0–1）。 */
  readonly linkDensity: number;
  /** 原始文件裡有沒有 `<article>`。 */
  readonly hasArticleTag: boolean;
  /** Readability 直接放棄（回 `null`）。 */
  readonly readabilityFailed: boolean;
}

/**
 * 門檻。括號裡是量測中**最接近這條線的兩頁**（一好一壞）——
 * 那個距離就是這條線的餘裕，寫下來是為了讓下一個想調它的人先看到代價。
 */
export const THRESHOLDS = {
  /** 正文長度。壞：`example.com` 111、SPA 頁 69；好：`mozilla.org/about` 820。 */
  minTextLength: 250,
  /** 連結密度。好：日文維基 0.28；壞：wikinews 0.64。**餘裕很寬，取保守端。** */
  maxLinkDensity: 0.5,
  /** 正文長度 ÷ 原始 HTML。壞：教育部首頁 0.0062；好：Wikidata Q42 0.0091。**這條最緊。** */
  minTextToHtmlRatio: 0.008,
} as const;

/** 判定的理由。**要顯示給人看，所以不能只回一個布林。** */
export type LowConfidenceReason =
  'readability-failed' | 'too-short' | 'link-heavy' | 'thin-vs-html';

export const ALL_LOW_CONFIDENCE_REASONS: readonly LowConfidenceReason[] = [
  'readability-failed',
  'too-short',
  'link-heavy',
  'thin-vs-html',
];

export interface ConfidenceVerdict {
  readonly lowConfidence: boolean;
  /** 命中的理由，可能不只一個。空陣列代表沒有疑慮。 */
  readonly reasons: readonly LowConfidenceReason[];
}

export function assessExtraction(signals: ExtractSignals): ConfidenceVerdict {
  const reasons: LowConfidenceReason[] = [];

  if (signals.readabilityFailed) reasons.push('readability-failed');
  if (signals.textLength < THRESHOLDS.minTextLength) reasons.push('too-short');
  if (signals.linkDensity > THRESHOLDS.maxLinkDensity) reasons.push('link-heavy');

  // **這一條要求「沒有 `<article>`」**：量測裡有 `<article>` 的頁面即使比例低
  // 也都是好正文（長頁面的 HTML 本來就大）。少了這個條件會把好正文標成低信心，
  // 而**誤報會讓標記本身失去意義**。
  const ratio = signals.htmlLength > 0 ? signals.textLength / signals.htmlLength : 0;
  if (!signals.hasArticleTag && ratio < THRESHOLDS.minTextToHtmlRatio) reasons.push('thin-vs-html');

  return { lowConfidence: reasons.length > 0, reasons };
}

/**
 * **「段落數太少」這條規則被量測刪掉了。**
 *
 * 它在 34 頁裡命中 5 頁，其中 4 頁已經被「連結密度」或「太短」抓到，
 * 而剩下那一頁（`httpbin.org/html`，一整段 Moby-Dick）**是好正文** ——
 * 也就是說它**唯一的獨立貢獻是那次量測中唯一的誤報**。
 *
 * 拿掉之後：命中 11 頁，誤報 0，漏報 2。
 * 這個常數留在這裡是為了讓下一個想「補上段落數判斷」的人先看到這段。
 */
export const PARAGRAPH_COUNT_WAS_TESTED_AND_REJECTED = true;

/** 完全沒有正文 —— 這不是「低信心」，是 `PARSE_EMPTY_CONTENT`。 */
export function isEmptyContent(signals: ExtractSignals): boolean {
  return signals.textLength < 40;
}

/**
 * 靜態抓不到內容的頁面（要 JS 才渲染）。
 *
 * REQ-0003 要求「**靜態抓不到內容時明確標示**，而不是交出一份空正文
 * 並讓它看起來像『這頁本來就沒東西』」。
 *
 * ## 原本的做法是錯的，而量測證明了它是錯的
 *
 * 第一版靠一張單頁應用骨架標記的清單（`__NEXT_DATA__`、`id="root"`、
 * `data-reactroot`、`ng-app`…）。2026-09-07 拿三個實際是 JS 渲染的頁面去比對，
 * **那張清單命中 0 次** —— 現在的框架不再留那些字串（Next.js App Router 用
 * `self.__next_f`、其他的乾脆什麼都不留）。
 *
 * **一張憑印象列的字串清單，看起來像規則，實際命中率是 0。**
 *
 * ## 改成只用量得到的東西
 *
 * `readability` 有跑出東西（所以不是它自己失敗）**但文字幾乎沒有，
 * 而 HTML 很大**。這是一個高精確、低召回的判準：
 * 34 頁裡只命中 1 頁，而那一頁確實是 JS 渲染的。
 *
 * **漏掉的會退回「低信心」標記**，不會變成一份看起來正常的空正文 ——
 * 這一層的失敗方向是安全的。
 */
export function looksJsOnly(signals: ExtractSignals): boolean {
  if (signals.readabilityFailed) return false;
  if (signals.textLength >= THRESHOLDS.minTextLength) return false;
  if (signals.htmlLength < 20_000) return false;
  return signals.textLength / signals.htmlLength < 0.002;
}
