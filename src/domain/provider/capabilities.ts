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
  /**
   * 輸出保證符合給定的 JSON schema。**不是「會不會輸出 JSON」**。
   *
   * v0.18.0 起「保證」有兩種來源，而這一欄對兩者都是 `true`：
   * 端點自己保證（受限解碼），或 provider 這一層事後驗證 —— 形狀不對就回錯誤，
   * **不交出一份沒被限制過的輸出**。對任務來說兩者的約定一樣：
   * 拿到的要嘛符合 schema、要嘛是一個錯誤。
   *
   * **差別不藏起來**：是哪一種由 `JsonMode` 說出來，設定頁與作業紀錄都看得到。
   */
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

/**
 * 「輸出符合 schema」這件事**由誰保證**。
 *
 * | 值 | 意思 |
 * |---|---|
 * | `schema` | 端點保證 —— Ollama 的 `format`、OpenAI 相容端點的 `response_format: json_schema` |
 * | `object` | 端點只保證「是一份 JSON」，**形狀由這一側事後驗證**（`conformsTo`）|
 * | `none` | 兩者都不保證 —— 需要 `json_schema` 的任務在這個端點上跑不了 |
 * | `unchecked` | 還沒量過。**第一次真的跑任務時會量**，結果寫進作業紀錄 |
 *
 * ## 為什麼是量的，不是宣告的
 *
 * 2026-09-11 之前 `chat-ollama.ts` 的檔頭寫著「OpenAI 相容那條路的 `response_format`
 * 只到 `json_object`」。重量一次：Ollama 0.33.2 的 `/v1` **支援 `json_schema` 而且真的套用**
 * （6/6 符合，對照組 0/6 是 JSON）。**一句沒有日期的量測結果，會在對方升版之後變成假話** ——
 * 所以這個值每個端點、每個模型各量一次，而且帶著量的時間。
 * （`docs/research/openai-compat-json-schema.md`）
 */
export type JsonMode = 'schema' | 'object' | 'none' | 'unchecked';

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
 * 依一條子問題去找候選來源。
 *
 * **需要 `browse`** —— 這是唯一真的需要上網的一步。
 * 而 agent **找到 URL 之後不自己抓**，一律交回擷取管線（ADR-0006 第 5 條）。
 */
export const TASK_FIND_SOURCES: TaskRequirement = {
  needs: ['browse'],
};

/**
 * 規劃對話：跟人來回談出這次研究的蒐集方向（Stage 19，ADR-0033 D5）。
 *
 * **需要 `json_schema`，不需要 `browse`** —— 兩個都是刻意的。
 *
 * 每一輪的輸出同時要給人看（`reply`）與給程式用（方向清單），而方向清單會變成
 * 閘門一之後真的去找的那張表。**靠正則從散文裡撈方向，會在模型換一種寫法時安靜地少撈幾條**
 * —— 那正是這一步最不能發生的事：少的那一條使用者根本不知道它存在過。
 *
 * `browse` 是**有就用**：Claude Code 有（`--tools WebSearch`）、OpenAI 相容 API 量過會搜尋的也有
 * （ADR-0034），本機 Ollama 沒有。沒有它也談得出方向 —— 素材是這個專題裡已經有的東西。
 * **所以它不進 `needs`**：列進去等於把本機那條路關掉，
 * 而畫面上只會說「缺少 browse」，使用者不會知道「其實可以談，只是不會上網查」。
 * 差別由畫面說（ui-workflows §4）。
 *
 * ## context 為什麼是 18000
 *
 * 送出去的是**攤平的整段對話 ＋ 專題摘要**，上限 `MAX_PLAN_PROMPT_CHARS`（8,000 字元，
 * `application/research-prompts.ts`）。最壞的 tokenizer 是 1.2 token／字元
 * （`WORST_TOKENS_PER_CHAR`，2026-09-09 量的），所以輸入 ≈ 9,600。
 *
 * 輸出那一側取 8,000：12 條方向（`MAX_DIRECTIONS`）各帶標題、要找什麼、預期來源、關鍵詞，
 * 加上 `reply`、`relation` 與「刻意不查的範圍」—— 照 `PLAN_SCHEMA` 的上界算滿是約 6,000 字元。
 * **輸出也算在 context 裡**（多數執行環境的 context 是輸入 ＋ 輸出）。
 *
 * 合計 17,600，取 **18,000**。`tests/guards/extract-context.test.ts` 釘著這個關係 ——
 * 兩個數字在不同的層，改一個很容易忘了另一個，而不夠大的下場是**對話前半被安靜截掉**：
 * 模型照樣回一份合法的規劃，只是它忘了你前三輪說過什麼。
 */
export const TASK_PLAN: TaskRequirement = {
  needs: ['json_schema'],
  minContextTokens: 18_000,
};

/**
 * 從抓回來的正文抽出實體與關係。
 *
 * **這一條 2026-09-09 才補上，而在那之前它根本不存在** —— `expand-service.ts`
 * 直接把 `EXTRACT_SCHEMA` 送出去，前面沒有任何配對檢查。角度那一步有、
 * 找來源那一步有，就這一步沒有。ADR-0006 第 3 條寫著「配不上就停手，
 * 不靜默降級」，而**少宣告一個任務，那條規則對它就等於不存在**。
 *
 * **需要 `json_schema`** —— 理由比角度那一步更硬：這一步把**別人網站上的文字**
 * 放進提示詞裡，而 schema 是三層防護的第二層（`expansion-prompts.ts` 檔頭）。
 * 沒有 schema 保證的話，模型能吐出的形狀就不再受限。
 *
 * ## context 為什麼是 24000
 *
 * 送進去的正文上限是 `MAX_TEXT_CHARS` ＝ 12,000 **字元**，
 * 而**字元不等於 token，差多少取決於哪一個 tokenizer**。
 * 拿同一段 12,000 字的中文實測三個家族（2026-09-09，Ollama 0.33.2）：
 *
 * | tokenizer | token 數 | 每字元 |
 * |---|---|---|
 * | Gemma（`translategemma:12b`）| 8,048 | 0.67 |
 * | Nemotron（`nemotron-cascade-2:30b`）| 11,185 | 0.93 |
 * | **OLMo（`olmo-3:32b-think`）** | **14,383** | **1.20** |
 *
 * **同一段字，最多與最少差 1.8 倍。** 2026-09-09 換一份 12,000 字的中文
 * 用 `prompt_eval_count` 直接量（**思考要關掉才準**，見下面那段）：
 *
 * | 模型 | token |
 * |---|---|
 * | `qwen3.5:4b` | 6,320 |
 * | `translategemma:12b` | 6,702 |
 * | `gemma4:31b` | 6,704 |
 * | `granite4.2:3b` | **9,780** |
 *
 * 最大與最小差 **1.55 倍**，跟上表的 1.8 倍同一個量級。
 *
 * > **這幾個數字第一版是錯的。** 當時寫 `gemma4:31b` 是 13,296、
 * > 「同一個血緣差兩倍」—— 而那是**思考開著的時候量的**：
 * > `prompt_eval_count` 在那種情況下把思考的 token 也算進去。
 * > 關掉之後同一份正文是 6,704，跟 `translategemma` 幾乎一樣。
 * > 一個從量測讀出來的「發現」，如果沒有控制住變因，會是一句假話。
 *
 * 所以輸入這一側要抓最壞的：14,400（正文）＋ 約 600（系統提示）≈ **15,000**。
 * 實測最大的 9,780 離它還有距離，那是刻意的 ——
 * **不夠大的下場是安靜截斷**，而這一側沒有第二道防線。
 *
 * ## 輸出那一側 2026-09-09 之前是估的，而估錯了
 *
 * 原本寫「輸出的實體與引文**約 2,000**」，合計取 18,000。實測：
 * `EXTRACT_SCHEMA` 補上 `maxItems` 之後是 **1,289–1,627** 個 token
 * （估得還算準）；**而補之前是 11,474** —— 那份 schema 的陣列沒有上界，
 * 受限解碼只保證形狀，**模型可以一直吐到視窗滿為止**。
 *
 * 兩側的失敗方式不一樣，所以取數字的方法也不該一樣：
 *
 * | | 超過的下場 | 所以怎麼取 |
 * |---|---|---|
 * | 輸入 | **安靜截斷** —— 抽出來的關聯照樣帶引文、照樣進待查證 | 最壞情況 |
 * | 輸出 | 空回應 ＋ `done_reason=length`，**看得見** | 實測 ＋ 餘裕 |
 *
 * 15,000（輸入上界）＋ 8,000（輸出預算，約實測的五倍）＝ 23,000，取 **24,000**。
 *
 * 英文同樣 12,000 字元只有 2,637 token（Gemma）—— 所以這個門檻對英文來源
 * 是過度保守的。**寧可保守**：不夠大的下場是正文被截掉一半而**不會報錯**，
 * 抽出來的關聯照樣帶引文、照樣進待查證，看起來完全正常。
 *
 * `tests/guards/extract-context.test.ts` 釘住 `MAX_TEXT_CHARS` 與這個數字的關係，
 * 因為它們在不同的層、改一個很容易忘了另一個。
 */
export const TASK_EXTRACT: TaskRequirement = {
  needs: ['json_schema'],
  minContextTokens: 24_000,
};

/**
 * 初讀：一份抓回來（或上傳）的候選讀一次 —— 跟這次研究有沒有關、繁中標題、兩三句繁中摘要
 * （Stage 21，ADR-0033 D9、REQ-0009 R14–R16）。
 *
 * **需要 `json_schema`**，理由跟抽取一樣兩個：回來的判斷會變成確認畫面上的預設值（D10）、
 * 摘要會出現在閱讀器與節點面板上 —— 從散文裡撈會在模型換一種寫法時安靜地讀錯；
 * 而且**別人網站上的文字進了提示詞**，schema 是三層防護的第二層（`expansion-prompts.ts` 檔頭）。
 *
 * ## context 為什麼是 12000
 *
 * 送出去的正文上限是 `DIGEST_TEXT_CHARS`（6,000 字元，只讀開頭 —— `digest.ts`），
 * 最壞 1.2 token／字元（`WORST_TOKENS_PER_CHAR`）→ 7,200。
 * 提示詞其餘部分各自有上限（系統提示、主題、跟專題的關係、12 條方向的標題、標題、網址），
 * 加起來約 2,300 字元 → 約 2,700。輸出照 `DIGEST_SCHEMA` 的上界是 680 字元，留到 2,000。
 * 合計 11,900，取 **12,000**。`tests/guards/extract-context.test.ts` 用真的常數把這個關係算一次。
 */
export const TASK_DIGEST: TaskRequirement = {
  needs: ['json_schema'],
  minContextTokens: 12_000,
};

/**
 * **`chat` 這個角色底下有兩個任務，而它們可以跑在不同的模型上。**
 *
 * 這組鍵住在 domain，因為設定檔、設定頁與 `expand-service` 三邊都要用同一組
 * 字串當索引 —— **三份各自寫死的字串會漂**，而漂掉的症狀是「覆寫設了沒有生效」，
 * 那在畫面上完全看不出來（它會安靜地用預設模型跑）。
 *
 * ## 為什麼值得分開跑
 *
 * 2026-09-09 量完八個本機模型之後，兩件事的最好解不是同一個
 * （`docs/research/chat-choice.md` 發現六）：
 *
 * | 任務 | 最好的 | 憑什麼 |
 * |---|---|---|
 * | `angles` | `granite4.2:8b` | 六條角度（其餘多半四條）、彼此相似度 0.712 最低 |
 * | `extract` | `qwen3.5:4b` | 引文命中 98%、平均 5 秒（第二名 17 秒） |
 *
 * 而 `nemotron-cascade-2:30b` 是反過來的證據：它是角度那一題最好的其中之一
 * （六條、`seeds` 100%），**同時是抽取那一題唯一真的捏造引文的**
 * （37 條有 13 條連最寬的比對都找不到）。**一個模型可以在一件事上很好、
 * 在另一件事上不可信**，而只有一個模型欄位的話，那兩件事只能一起換。
 *
 * 這件事做得到的前提也是量出來的：3.4 GB ＋ 5.3 GB ＝ 8.7 GB，
 * **兩個可以同時常駐**，換任務不必把對方擠出顯示記憶體。
 *
 * （上表是 2026-09-09 那一輪。2026-09-29 起建議值只從非中國來源挑，抽取的建議值也是 `granite4.2:8b`
 * —— ADR-0035。）
 *
 * **`digest`（初讀）是第三個**（Stage 21）：它讀的是研究抓回來的每一份，而且每一份都讀，
 * 所以「走哪一條、花不花錢」要能跟抽取分開挑 —— 抽取走線上端點、初讀留在本機是很自然的組合。
 */
export const CHAT_TASKS = ['extract', 'digest'] as const;
export type ChatTask = (typeof CHAT_TASKS)[number];

/**
 * 嵌入。**沒有任何布林能力要求**，那不是漏寫的。
 *
 * `browse`／`tools`／`json_schema`／`vision` 四個旗標描述的是**對話模型**
 * 會不會做某件事，而嵌入端點一件都不做 —— 它吃一段文字、吐一個向量。
 * 「這個模型行不行」在嵌入這一邊是另一個問題（維度對不對、品質好不好），
 * 而那兩個問題**這一層回答不了**：維度是寫進資料庫的硬約束（ADR-0009），
 * 品質要量（`docs/research/embedding-choice.md`）。
 *
 * 所以這裡是一份**誠實的空需求**，而不是把嵌入排除在任務表之外 ——
 * 排除的話，設定頁上那張表就少一列，而使用者要在別的地方找它。
 */
export const TASK_EMBED: TaskRequirement = {
  needs: [],
};

/**
 * **這個工具會用到模型的每一個地方，以及各自跑在哪個角色上。**
 *
 * ## 為什麼要有這一份，而不是讓畫面自己列
 *
 * 2026-09-10 之前，「哪些事會用到模型」這個問題的答案散在三處：
 * `PROVIDER_ROLES`（三個角色）、`CHAT_TASKS`（chat 底下兩個任務）、
 * 以及設定頁上手寫的版面。**三處都不是完整答案** ——
 * 而使用者問的是「我能不能替每一件事各挑一個模型」，那需要一份完整清單。
 *
 * ## 角色與任務是多對一，而且會繼續是
 *
 * `chat` 底下有兩個任務，是因為量出來它們的最好解不同（見 `CHAT_TASKS`）。
 * `agent` 與 `embed` 目前各只有一個 —— **那是現況不是規則**，
 * 所以這份表用「任務」當主鍵，不是用「角色」。
 */
/**
 * 順序就是設定頁「模型分工」那張表的列順序（守門釘著兩邊一樣）。
 * **照流程排**：先談出方向、再找來源、初讀抓回來的、抽取、向量。
 */
export const MODEL_TASKS = [
  { task: 'plan', role: 'agent', requirement: TASK_PLAN },
  { task: 'find-sources', role: 'agent', requirement: TASK_FIND_SOURCES },
  { task: 'digest', role: 'chat', requirement: TASK_DIGEST },
  { task: 'extract', role: 'chat', requirement: TASK_EXTRACT },
  { task: 'embed', role: 'embed', requirement: TASK_EMBED },
] as const satisfies readonly {
  readonly task: string;
  readonly role: ProviderRole;
  readonly requirement: TaskRequirement;
}[];

export type ModelTask = (typeof MODEL_TASKS)[number]['task'];

/** 這個任務跑在哪個角色上。**`undefined` 是不可能的** —— 型別保證它在表裡。 */
export function roleOfTask(task: ModelTask): ProviderRole {
  return (MODEL_TASKS.find((t) => t.task === task) as (typeof MODEL_TASKS)[number]).role;
}

export function requirementOfTask(task: ModelTask): TaskRequirement {
  return (MODEL_TASKS.find((t) => t.task === task) as (typeof MODEL_TASKS)[number]).requirement;
}

/**
 * 每個 chat 任務要求什麼。**這一份是上面那兩個常數的索引，不是第二份定義** ——
 * 兩份需求表會漂，而漂掉的那一份會讓閘門對某個任務放行。
 */
export const CHAT_TASK_REQUIREMENTS: Readonly<Record<ChatTask, TaskRequirement>> = {
  extract: TASK_EXTRACT,
  digest: TASK_DIGEST,
};

/**
 * 中文最壞情況下每個字元要幾個 token。**量出來的**（見 `TASK_EXTRACT`）。
 * 守門測試拿它把 `MAX_TEXT_CHARS` 換算成 token 再跟門檻比。
 */
export const WORST_TOKENS_PER_CHAR = 1.2;

/**
 * 這個工具送出去的請求**最大**需要多少 context。
 *
 * ## 為什麼需要這個數字，而不是只有各任務的門檻
 *
 * `capabilitiesOf` 從 `/api/tags` 讀 `context_length`，那是**模型支援的上限**；
 * 而 Ollama 真的載入時用的是它自己的預設（`OLLAMA_CONTEXT_LENGTH`，
 * 使用者沒設就是內建值）。**那兩個數字不一樣，而閘門看的是前一個。**
 *
 * 2026-09-09 實測 `nemotron-cascade-2:30b`：`/api/tags` 說 **262144**，
 * `ollama ps` 顯示實際載入的是 **32768**。
 *
 * **而更常見的情況比那還糟：那一欄根本不在。** 同一次實測，
 * `gemma4:31b` 與 `translategemma:12b` 的 `details` 裡**沒有
 * `context_length`** —— 於是 `capabilitiesOf` 給 0，而 0 是「不知道」，
 * 閘門直接放行。**閘門對這兩個模型完全沒有意見。**
 *
 * 所以請求要**明確帶 `num_ctx`**：不管對方宣告了什麼、有沒有宣告，
 * 這次要開多大由我們說了算。
 *
 * ## 這個數字比 Ollama 的預設**大**，那是刻意的
 *
 * 這台機器上 `OLLAMA_CONTEXT_LENGTH` 沒設，內建預設是 **32768**。
 * 2026-09-09 第一版把這個常數設成 18,000（＝當時的閘門門檻），
 * 結果是**把視窗從 32768 縮到 18000** —— 配上當時還沒有上界的
 * `EXTRACT_SCHEMA`，模型一路吐到 101% 然後回一份空字串。
 *
 * **門檻與視窗是兩件事**：門檻回答「這個模型夠不夠格」，
 * 視窗回答「這次要配置多大」。把後者設成前者，等於把餘裕設成零。
 * 現在兩個是同一個數字（24,000），但那是因為 24,000 是**從輸入上界
 * 加輸出預算算出來的**，不是因為門檻剛好在那裡。
 *
 * 不取更大是因為 KV 快取隨 context 線性長 —— 開一個用不到的大 context
 * 是在燒顯示記憶體，而這個工具要能在只有一張消費級顯示卡的機器上跑。
 */
export const REQUIRED_CONTEXT_TOKENS = Math.max(
  TASK_EXTRACT.minContextTokens ?? 0,
  // 規劃對話也可以走本機 Ollama（ADR-0033 D5），而它送的是攤平的整段對話 ——
  // 漏掉它的話，`num_ctx` 會比這個任務真正需要的小，而症狀是對話前半被安靜截掉。
  TASK_PLAN.minContextTokens ?? 0,
  TASK_DIGEST.minContextTokens ?? 0,
);
