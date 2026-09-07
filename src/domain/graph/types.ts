/**
 * 圖模型的型別。
 *
 * ⚠️ **`domain/graph` 零依賴**（ADR-0014）：這個資料夾底下**一個 import 都不能有** ——
 * 不 import 其他層、不 import 任何 npm 套件，**也不 import `domain/` 的其他資料夾**。
 *
 * 最後那一條看起來過頭，但零依賴是「以後可以抽成套件」的**前置條件**，
 * 而現在維持它的成本幾乎是零。抽套件的觸發條件寫在 ADR-0014：
 * **兩邊的複本已經分岔，而那個分岔造成了一個 bug** —— 不是「兩個專案都用到」。
 *
 * 由 tests/guards/domain-graph-deps.test.ts 守著。
 */

/** 圖上有兩種節點。`node` 這個字不單獨用 —— 見 glossary 的「不可以叫什麼」。 */
export type NodeKind = 'item' | 'entity';

/** 資料節點的子型別。 */
export type ItemKind = 'web' | 'pdf' | 'image' | 'text' | 'paper' | 'note';

/**
 * 實體型別。**刻意只有六個。**
 * followthemoney 有 70 個 schema，但那是為投查記者的結構化資料設計的
 * （BankAccount、Passport、ContractAward…），而這個工具的來源是一般文件。
 * 要加之前先問「使用者會用它來篩選嗎」。
 */
export type EntityType = 'person' | 'org' | 'place' | 'event' | 'work' | 'concept';

/**
 * 關聯的四層（ADR-0015）。**只有 `named` 進人工裁決佇列。**
 *
 * 另外三層是**可重算的計算結果** —— 把可驗證的東西送去人工裁決，
 * 會讓人開始不看內容就按確認，然後真正需要判斷的那些也一起被亂按。
 */
export type EdgeLayer =
  /** 轉載、翻譯、鏡像。機器可驗（雜湊／URL／重疊率）。**獨立來源數靠它算** */
  | 'derived'
  /** 世界上的主張。要引文、要人工裁決 */
  | 'named'
  /** 低於投影門檻的實體攤平成的線 */
  | 'comention'
  /** 算出來的分數，不是主張 */
  | 'similarity';

export const EDGE_LAYERS: readonly EdgeLayer[] = ['derived', 'named', 'comention', 'similarity'];

/** 只有這一層需要人裁決。 */
export function requiresAdjudication(layer: EdgeLayer): boolean {
  return layer === 'named';
}

/** 這三層可以整批重算 —— 重算不算「覆寫人工判定」。 */
export function isRecomputable(layer: EdgeLayer): boolean {
  return layer !== 'named';
}

export type EdgeStatus = 'pending' | 'confirmed' | 'rejected';

/**
 * `origin` 與 `status` **分開存**。
 * 寫入路徑對 `origin === 'human'` 的列**只能新增不能改**。
 */
export type EdgeOrigin = 'machine' | 'human';

/** 可信度只給三段，不給小數（ADR-0017）。 */
export type ConfidenceTier = 'weak' | 'medium' | 'strong';

export interface EdgeRef {
  readonly source: string;
  readonly target: string;
  readonly rel: string;
}

export interface Edge extends EdgeRef {
  readonly id: string;
  readonly layer: EdgeLayer;
  readonly origin: EdgeOrigin;
  readonly status: EdgeStatus;
  /** 連續分數。**只用於排序與線寬，永遠不顯示成小數。** */
  readonly confidence: number;
  /** 這條組合曾經被否決過又帶著新出處回來（ADR-0016）。 */
  readonly previouslyRejected: boolean;
}

export interface Evidence {
  readonly id: string;
  readonly edgeId: string;
  /** 引文出自哪個 `item`。**獨立來源數是靠這個欄位分群的。** */
  readonly itemId: string;
  readonly quote: string;
  readonly charStart: number;
  readonly charEnd: number;
}
