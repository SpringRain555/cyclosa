/**
 * 一次模型呼叫的紀錄 —— **「這個模型當時看到什麼、回了什麼」**。
 *
 * ## 為什麼需要它
 *
 * 到 v0.21.0 為止，三條路（Ollama、OpenAI 相容、`claude -p`）都是
 * **解析完就丟**。留下來的只有結果：角度的題目、實體與關聯、錯誤碼。
 *
 * 那些足以發現「這一次失敗了」，**不足以回答「這條關聯為什麼是錯的」** ——
 * 引文找得到不代表關係是對的，而我們手上沒有模型當時看到的那份輸入。
 * 使用者遇到的壞例子因此**沒辦法重現**：評測腳本能重跑，但重跑的是評測的題目，
 * 不是使用者剛剛那一次。
 *
 * ## 三條規矩
 *
 * 1. **預設關著。** 它會長很快（抽取的提示詞裡是整份正文），
 *    而多數作業沒有人會回頭看。開關在畫面上而不是設定檔裡 ——
 *    **遇到壞例子的當下才是唯一能打開它的時機**。
 * 2. **存進那個專題自己的資料夾。** 裡面有來源正文，它跟專題內容同級，
 *    所以跟著專題一起備份、一起刪掉。不進 `logs\`（那一份刻意不寫內容）。
 * 3. **金鑰永遠不在裡面。** 記的是端點的 host 與環境變數的名字，不是值 ——
 *    跟 `providers.json` 同一條理由：這種檔會被整份貼出來求助。
 *
 * ⚠️ 純資料與純函式，零依賴。寫檔在 `infrastructure/fs/model-log.ts`。
 */
import type { ModelTask } from './capabilities.js';

/**
 * 哪些任務要記。
 *
 * | 任務 | 記？ | 為什麼 |
 * |---|:--:|---|
 * | `extract` | ✅ | **圖上長出什麼由它決定。** 它的失敗是最難查的那一種：引文是真的、關係是編的 —— 只有原始輸入與輸出對得起來時才看得出來 |
 * | `angles` | ✅ | 題目本身已經進 `run_angle`（含沒被勾的），**但提示詞沒有** —— 「它為什麼問這一條」要看當時給了哪幾份種子 |
 * | `find-sources` | ✅ | agent 的回覆是原始文字（`CallOutcome<string>`），裡面有它自己的推理。候選品質從來沒有量過，這是第一份素材 |
 * | `digest` | ✅ | **初讀**（v0.25.0，Stage 21）。它的判斷會變成確認畫面上「進圖」的預設值 —— 一份被判成「沒關」的資料，要回頭看得到當時送了哪一段正文、模型怎麼說 |
 * | `plan` | ✅ | **規劃對話的每一輪**（v0.25.0，REQ-0009 R29）。這一步決定了這次研究去查什麼，而它的輸入是攤平的整段對話 —— 「模型為什麼漏了那個面向」只有連著當時的對話看才答得出來 |
 * | `embed` | ❌ | **輸入是已經存著的正文，輸出是一串 2560 個浮點數。** 當文字看它又大又不可讀；當 XAI 素材看，單一向量離開了它的向量空間沒有意義。它真正該記的（模型、維度、筆數、耗時）已經在資料庫裡 |
 *
 * **探測與「測試這個模型」也不記** —— 它們沒有內容，而且會把紀錄洗掉。
 */
export const LOGGED_MODEL_TASKS: readonly ModelTask[] = [
  'plan',
  'find-sources',
  'digest',
  'angles',
  'extract',
];

export function isLoggedTask(task: ModelTask): boolean {
  return LOGGED_MODEL_TASKS.includes(task);
}

/**
 * 一次呼叫。**每個欄位都要能在沒有這個工具的機器上讀懂**
 * （專題資料夾的那條標準，`storage-layout.md`）。
 */
export interface ModelCallRecord {
  /** UTC ISO-8601。**機器欄位不帶時區偏移**，跟 `manifest.jsonl` 一致。 */
  readonly at: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly task: ModelTask;
  readonly role: 'chat' | 'agent';
  /**
   * **實際跑的那一個模型**，不是預設那一個。
   *
   * 逐任務覆寫（`chat.taskModels`）的整個重點就是這一欄：
   * 同一個專題裡角度與抽取可以跑在不同模型上，而**換了模型之後的比較
   * 只有在每一列都記著自己是誰跑的時候才做得了**。
   */
  readonly model: string;
  /** `ollama` / `openai` / `claude-cli`。 */
  readonly transport: string;
  /** 端點的 host（含埠）。**不含路徑、不含金鑰、不含環境變數的值。** */
  readonly endpoint: string | null;
  /** 這一次在處理哪一份資料（抽取才有）。 */
  readonly itemId?: string;
  /** 送出去的東西。**原樣**，不截斷 —— 截斷過的提示詞沒辦法重現那一次。 */
  readonly request: {
    readonly system: string;
    readonly user: string;
  };
  /**
   * 回來的東西。
   *
   * **`json` 是解析後的值再序列化一次，不是模型吐出來的原始位元組** ——
   * `ChatProvider.json()` 現在只回解析後的值。差別在「JSON 以外的雜訊」
   * （有些模型會在前後多寫幾句話），那一段這裡看不到。
   * agent 那一條沒有這個問題：它的回覆本來就是原始文字。
   */
  readonly response: {
    readonly text: string | null;
    readonly errorDetail: string | null;
  };
  readonly outcome: {
    readonly ok: boolean;
    readonly code: string | null;
    readonly elapsedMs: number;
    /** **沒回報就是 `null`，不要填 0**（`CallCost` 同一條規矩）。 */
    readonly costUsd: number | null;
  };
}

/** 一行一個 JSON。**沒有換行、沒有縮排** —— 它要能被逐行讀。 */
export function toJsonl(record: ModelCallRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * 從 `baseUrl` 取出可以記的部分。
 *
 * **只留 host 與埠。** 路徑可能帶查詢參數，而有些端點把金鑰放在那裡 ——
 * 這個工具不那樣用，但這一支不該假設呼叫端永遠不會。
 */
export function endpointOf(baseUrl: string | null): string | null {
  if (baseUrl === null || baseUrl.trim().length === 0) return null;
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}
