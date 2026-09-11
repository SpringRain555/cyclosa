/**
 * provider 的介面 —— **三個角色三種形狀，刻意不統一。**
 *
 * `agent` 是子程序、`chat` 是 HTTP、`embed` 是本地優先（Stage 12）。
 * 硬塞進同一個介面的話，最後會得到一個只剩最小交集的抽象：
 * `agent` 的取消（殺子程序）與 `chat` 的取消（abort 一個 fetch）
 * 差別大到不該用同一個型別假裝一樣。
 *
 * **統一的只有兩件事**：能力宣告的形狀，與「一次呼叫回報了什麼成本」。
 * 那兩件是 `domain/provider` 要用的，而它們確實一樣。
 */
import type { JsonMode, ProviderCapabilities } from '../../domain/provider/index.js';
import type { ErrorCode } from '../../domain/errors/codes.js';

/** 一次呼叫的計費事實。**沒回報就是 `null`，不要填 0。** */
export interface CallCost {
  readonly costUsd: number | null;
  readonly elapsedMs: number;
}

export type CallOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T; readonly cost: CallCost }
  | {
      readonly kind: 'error';
      readonly code: ErrorCode;
      readonly detail: string;
      readonly cost: CallCost;
    };

/** provider 目前的狀態。**「沒設定」與「設定了但連不上」要分得開。** */
export type ProbeResult =
  | {
      readonly kind: 'ready';
      readonly model: string;
      /**
       * 版本。**跟模型名分開的欄位**，因為兩個角色的答案形狀不同：
       * agent 是 CLI 的版本號，chat 是那個模型的參數量與量化格式。
       *
       * 之前 agent 把版本塞進 `model`，於是設定頁上兩個角色的同一欄
       * 一個顯示模型名、一個顯示版本號 —— **同一欄兩種意思。**
       */
      readonly version: string | null;
      readonly capabilities: ProviderCapabilities;
    }
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'unreachable'; readonly detail: string };

/**
 * 產生結構化 JSON 的一次對話。
 *
 * **`schema` 是必要參數不是選項** —— 這個工具對 chat 的每一種用法
 * 都要一份可以直接當清單顯示的東西，而「請你回 JSON」這種請求
 * 在模型換一種寫法時會安靜地少撈幾條（`TASK_ANGLES` 要求 `json_schema`）。
 */
export interface ChatProvider {
  readonly name: string;
  probe(signal?: AbortSignal): Promise<ProbeResult>;
  json(
    input: {
      readonly system: string;
      readonly user: string;
      readonly schema: Readonly<Record<string, unknown>>;
    },
    signal?: AbortSignal,
  ): Promise<CallOutcome<unknown>>;
  /**
   * 「符合 schema」由誰保證（Stage 16）。**不打網路** —— 只讀已經知道的事實，
   * 所以設定頁一打開就可以問，不會產生費用。
   */
  jsonMode(): Promise<JsonModeReport>;
  /**
   * **量一次並記下來。會送出真的請求**，線上端點可能計費。
   *
   * 沒有這一支的 provider（本機 Ollama）不需要量：它的保證是協定的定義。
   */
  checkJson?(signal?: AbortSignal): Promise<CallOutcome<JsonModeReport>>;
}

export interface JsonModeReport {
  readonly mode: JsonMode;
  /** 量的時間（epoch 毫秒）。**`null` ＝ 不是量出來的**（協定保證，或還沒量）*/
  readonly checkedAt: number | null;
  /** 給人看的一句話：保證從哪來，或為什麼是這個結果 */
  readonly detail: string;
}

/**
 * 一次 agent 子程序。
 *
 * **`cwd` 是沙箱**（ADR-0006 第 4 條）。呼叫端負責建它、跑完檢查它，
 * 而這一層負責**確實把子程序的工作目錄設成它** —— 那是唯一真正在執行的約束。
 */
export interface AgentProvider {
  readonly name: string;
  probe(signal?: AbortSignal): Promise<ProbeResult>;
  run(
    input: {
      readonly prompt: string;
      readonly cwd: string;
      readonly timeoutMs: number;
    },
    signal?: AbortSignal,
  ): Promise<CallOutcome<string>>;
}
