/**
 * 整理的第一片：**把還沒抽過的資料抽進圖**（ADR-0033 D13 操作表的「抽這幾份」，S24-1）。
 *
 * ## 「還沒抽過」是一個事實，不是模型的意見
 *
 * 完整的整理（D13）由模型讀專題的摘要、交出一張操作清單；這一片不需要那一步 ——
 * 哪幾份還沒抽過，資料庫數得出來。所以這裡沒有規劃、也沒有模型呼叫，清單直接列給人勾（Q10：預設不勾）。
 *
 * ## 為什麼不能只看 `extracted_at`
 *
 * 那一欄是 schema v12（Stage 22）才有的，**只有研究建圖寫它**。在那之前抽過的資料
 * （舊的擴展、手動抽取、範例專題）那一欄是空的，卻已經有機器建的關聯拿它當出處。
 * 只看那一欄的話，清單上會出現一堆其實抽過的資料，勾下去就是重抽一次。
 * 「抽過但 0 條」與「沒抽過」對舊資料仍然分不出來（D11 寫過）—— 那一種照樣列出來，讓人決定要不要再試。
 */

/** 判斷一份資料能不能出現在「還沒抽過」清單上所需要的事實。 */
export interface ExtractionFacts {
  readonly kind: string;
  readonly status: string;
  readonly extractedAt: number | null;
  /** 有幾筆**機器建的**關聯拿它當出處。人建的不算 —— 你手動連一條線不等於它被抽過。 */
  readonly machineEvidence: number;
  /** 衍生正文有沒有字。圖片與掃描件沒有（這一版不做 OCR），抽不了。 */
  readonly hasBody: boolean;
}

/** 書目節點沒有正文；筆記是點註，不是資料（D14）。 */
const NOT_SOURCES: readonly string[] = ['reference', 'note'];

/** 匯入完成的資料停在 `included`；`parsed` 是中間態。排除的、失敗的、還沒抓的都不算。 */
const USABLE: readonly string[] = ['parsed', 'included'];

/** 這一份還沒抽過，而且抽得了。 */
export function isUnextracted(facts: ExtractionFacts): boolean {
  if (NOT_SOURCES.includes(facts.kind)) return false;
  if (!USABLE.includes(facts.status)) return false;
  if (facts.extractedAt !== null) return false;
  if (facts.machineEvidence > 0) return false;
  return facts.hasBody;
}

/**
 * 復原一筆作業之後，那一份的「抽過了」要不要清回去。
 *
 * **只清這一筆作業寫的那一個。** 作業結束之後又被別的作業抽過一次（時間在這一筆的區間之外）的，
 * 那個標記是後來那一次的，不是這一筆的。
 */
export function extractedByRun(
  extractedAt: number | null,
  run: { readonly startedAt: number | null; readonly endedAt: number | null },
  now: number,
): boolean {
  if (extractedAt === null || run.startedAt === null) return false;
  return extractedAt >= run.startedAt && extractedAt <= (run.endedAt ?? now);
}
