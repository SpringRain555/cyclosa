/**
 * 能力宣告與任務需求的配對（ADR-0006）。
 *
 * **這一層不知道 provider 長什麼樣子，也不知道任務怎麼跑。**
 * 它只回答一個問題：**「這個 provider 缺哪幾樣？」**
 *
 * ## 為什麼是「缺哪幾樣」而不是「行不行」
 *
 * 回布林的話，UI 只能說「跑不了」。而 ADR-0006 要求說出
 * **「這個任務需要 X，目前設定的 provider 沒有 X」** ——
 * 那個 X 必須從這裡帶出去，否則使用者不知道要去改什麼。
 *
 * ## 為什麼不是模型名稱白名單
 *
 * 名單會漂（新模型天天出），而且同一個名稱在不同 provider 上能力不同。
 * 能力宣告的代價是**它要人工維護，而不準的宣告比沒有宣告更糟** ——
 * 所以 `infrastructure/providers/` 那一層盡量**去問 provider 自己**
 * （Ollama 的 `/api/tags` 每個模型帶一個 `capabilities` 陣列），
 * 問不到的才由我們填。
 */

/** LLM 在這個工具裡的三種角色。**來源異質**，所以介面也不同。 */
export const PROVIDER_ROLES = ['agent', 'chat', 'embed'] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

/**
 * 布林能力欄位。**`context_tokens` 不在這裡** —— 它是數量不是有無，
 * 而「缺哪幾樣」這個回答對數量沒有意義（缺 3000 個 token 不是一個能力）。
 */
export const CAPABILITY_FLAGS = ['browse', 'tools', 'json_schema', 'vision'] as const;
export type CapabilityFlag = (typeof CAPABILITY_FLAGS)[number];

export interface ProviderCapabilities {
  /** 自己上得了網。**agent 才可能有** —— chat 端點沒有這種東西 */
  readonly browse: boolean;
  readonly tools: boolean;
  /** 輸出保證符合給定的 JSON schema。**不是「會不會輸出 JSON」** */
  readonly json_schema: boolean;
  readonly vision: boolean;
  /** 0 表示不知道。**不知道與很小是兩件事**，見 `missingFor` */
  readonly context_tokens: number;
}

export interface TaskRequirement {
  /** 這個任務**必須**有的布林能力。沒有列到的一律不管 */
  readonly needs: readonly CapabilityFlag[];
  /** 需要多大的 context。0 表示不在乎 */
  readonly minContextTokens?: number;
}

export type MatchResult =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'missing';
      readonly flags: readonly CapabilityFlag[];
      /** 有值就是 context 不夠：`[需要, 宣告有的]` */
      readonly context: readonly [number, number] | null;
    };

/**
 * 配對。**缺就回缺哪幾樣，不回一個布林。**
 *
 * `context_tokens` 是 0 的時候**當成不知道而放行**，不當成「只有 0 個」。
 * 理由是宣告不準時的兩種錯法代價不對稱：
 * **擋掉一個其實跑得動的 provider，使用者無從得知要去改什麼**
 * （能力宣告是我們寫的，不是他改得到的）；
 * 而放行一個其實不夠大的，會在真的跑的時候拿到一個**來自 provider 自己**
 * 的明確錯誤。**後者的訊息比前者好。**
 */
export function missingFor(task: TaskRequirement, have: ProviderCapabilities): MatchResult {
  const flags = task.needs.filter((flag) => !have[flag]);
  const need = task.minContextTokens ?? 0;
  const context =
    need > 0 && have.context_tokens > 0 && have.context_tokens < need
      ? ([need, have.context_tokens] as const)
      : null;
  if (flags.length === 0 && context === null) return { kind: 'ok' };
  return { kind: 'missing', flags, context };
}

/** 全都沒有的宣告。**沒設定 provider 時用它**，而不是用 `null` 到處判。 */
export const NO_CAPABILITIES: ProviderCapabilities = {
  browse: false,
  tools: false,
  json_schema: false,
  vision: false,
  context_tokens: 0,
};

// ── 這個工具裡的兩個任務 ──────────────────────────────────

/**
 * 產生多視角子問題。
 *
 * **不需要 `browse`** —— 視角是從**這個專題裡已經有的東西**歸納出來的
 * （STORM 的 Perspective-Guided Question Asking，`market-scan.md` 發現 ⑥）。
 * 一個要上網才想得出角度的擴展，跟「叫 LLM 隨便發散」沒有差別。
 *
 * **需要 `json_schema`** —— 回來的東西要當成清單顯示給人勾選。
 * 靠正則從散文裡撈問句，會在模型換一種寫法時安靜地少撈幾條。
 */
export const TASK_ANGLES: TaskRequirement = {
  needs: ['json_schema'],
  minContextTokens: 8000,
};

/**
 * 依一條子問題去找候選來源。
 *
 * **需要 `browse`** —— 這是唯一真的需要上網的一步。
 * 而 agent **找到 URL 之後不自己抓**，一律交回擷取管線（ADR-0006 第 5 條）。
 */
export const TASK_FIND_SOURCES: TaskRequirement = {
  needs: ['browse'],
};
