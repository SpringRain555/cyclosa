/**
 * provider 設定檔：`%LOCALAPPDATA%\Cyclosa\providers.json`。
 *
 * ## 為什麼不放在資料根裡
 *
 * 資料根的規矩是**「整個複製走，在另一台機器上打得開」**（REQ-0001）。
 * 而這一份裡面裝的是**這台機器**的事實：CLI 在不在路徑上、
 * Ollama 綁在哪個埠、本機拉了哪個模型。
 * 跟著資料搬到另一台機器上，每一條都是錯的。
 *
 * ## 為什麼不放進指標檔
 *
 * `storage-layout.md`：**指標檔只有一個工作 —— 告訴程式資料在哪。**
 * 「不放設定、不放狀態、不放快取」是那一份明寫的。
 * 所以這裡是**同一個資料夾裡的另一個檔**，不是塞進去。
 *
 * ## 檔案不存在是正常狀態
 *
 * 沒有這個檔就是「三個角色都沒設定」，那不是錯誤 ——
 * 這個工具的其餘部分（匯入、閱讀器、圖、裁決、全文檢索）**完全不需要模型**。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CHAT_TASKS, type ChatTask } from '../../domain/provider/index.js';
import { pointerFilePath } from '../fs/paths.js';

/**
 * `chat` 走哪一種協定。
 *
 * | 值 | 打哪裡 | 用在 |
 * |---|---|---|
 * | `ollama` | `/api/tags`、`/api/chat` | 本機 Ollama。**預設，而且舊的設定檔沒有這一欄時就是它** |
 * | `openai` | `/models`、`/chat/completions` | 任何 OpenAI 相容端點（線上的、或別家本機伺服器）|
 *
 * ## 為什麼本機 Ollama 不改走 OpenAI 相容那條
 *
 * 它現在也支援 `json_schema` 了（2026-09-11 實測，推翻了原本的理由）。
 * **留下原生那條的理由換成一個量得到的數字**：`/v1` 送不了 `think: false`，
 * 同一題 `qwen3.5:4b` 走 `/v1` 是 4.1 秒、2,935 字的思考，
 * 走原生並關掉思考是 **0.45 秒、0 字**（`docs/research/openai-compat-json-schema.md`）。
 * 而 `num_ctx` 也只有原生那條送得出去 —— 少了它，正文會在小 context 的機器上被安靜截斷。
 *
 * **不自動偵測。** 兩種協定 Ollama 都答得出來，「它看起來像哪一種」
 * 猜錯的代價是那兩個量出來的設定安靜地消失。這是使用者選的事實。
 */
export const CHAT_TRANSPORTS = ['ollama', 'openai'] as const;
export type ChatTransport = (typeof CHAT_TRANSPORTS)[number];

export function transportOf(value: unknown): ChatTransport {
  return value === 'openai' ? 'openai' : 'ollama';
}

export interface ChatConfig {
  readonly transport: ChatTransport;
  /**
   * 端點的根位址。**兩種協定的慣例不一樣**：
   * Ollama 是 `http://127.0.0.1:11434`（不含 `/v1`），
   * OpenAI 相容端點照各家文件的寫法**含 `/v1`**（`https://api.example.com/v1`）。
   */
  readonly baseUrl: string;
  readonly model: string;
  /**
   * 逐任務覆寫。**空字串 ＝ 跟著 `model`，不是「沒有模型」** ——
   * 這兩件事在畫面上要分得開，所以這一欄永遠有全部的鍵，
   * 不用「缺鍵」表示「沒覆寫」（缺鍵與空字串會在 JSON 來回一趟之後混在一起）。
   *
   * ## 為什麼覆寫的是模型而不是整份設定
   *
   * `baseUrl` 與 `apiKeyEnv` **刻意不能逐任務覆寫**：它們描述的是「連到哪個端點」，
   * 而兩個任務跑在不同端點上會讓「本機模型不花錢」這件事按任務而異 ——
   * 成本上限、逾時、金鑰偵測全部要跟著分岔。
   * 而真正量出差別的是模型本身（`CHAT_TASKS` 的註解），不是端點。
   */
  readonly taskModels: Readonly<Record<ChatTask, string>>;
  /**
   * 帶金鑰的話，**金鑰在哪個環境變數裡** —— 不是金鑰本身。
   *
   * 這是 2026-09-08 定的：接雲端端點需要一把金鑰，
   * 而**這個設定檔會被備份、會被同步、會在求助的時候被整份貼出來**。
   * 所以這裡存的是名字，值只在送出請求的那一刻從環境讀一次。
   *
   * `null` ＝ 不帶授權標頭（本機 Ollama 就是這樣）。
   */
  readonly apiKeyEnv: string | null;
}

export interface AgentConfig {
  /** CLI 的名字或完整路徑。**預設 `claude`，靠 PATH 找** */
  readonly command: string;
  /**
   * 交給 CLI 的 `--model`。**空字串 ＝ 不帶，用 CLI 自己的預設。**
   *
   * 2026-09-10 補上。在那之前「找來源」這個任務**完全沒有模型欄位** ——
   * 而設定頁上那張逐任務的表少了一列，使用者只能去改 CLI 自己的設定。
   *
   * 這一欄與 `chat.taskModels` 不同形狀，是因為 `agent` 底下只有一個任務
   * （`MODEL_TASKS`）。多了第二個任務的那一天再改成一張表。
   */
  readonly model: string;
  /**
   * 接在 `command` 後面、我們自己那些旗標**前面**的參數。
   *
   * 存在的理由是包裝：`npx claude`、`wsl claude`、或者測試裡的
   * 「用 node 跑一支假的 CLI」都是 `command ＋ 前綴參數` 這個形狀。
   * **沒有它的話，那幾種情況只能靠 shell 字串拼接**，而那在 Windows 上
   * 是引號地獄，也是一條把使用者輸入送進 shell 的路。
   */
  readonly args: readonly string[];
}

/**
 * 嵌入模型（2026-09-09，v0.10.2 補上）。
 *
 * **沒有 `apiKeyEnv`，那是刻意的。** 向量會被寫進資料庫並長期保存，
 * 而換模型要把全部重算 —— 一個雲端端點隨時可能換掉背後的權重、
 * 停用某個版本、或者調整它的正規化方式，而**那些變化不會報錯，
 * 只會讓比對安靜地變爛**（ADR-0009）。所以這一欄只接本機端點。
 *
 * 預設模型是量出來的：`qwen3-embedding:4b`（2026-09-09，七個候選、
 * 1955 段語料、50 條查詢，見 `docs/research/embedding-choice.md`）。
 * 小機器的替代選項是 `qwen3-embedding:0.6b`。
 */
export interface EmbedConfig {
  readonly baseUrl: string;
  readonly model: string;
}

/** 量測選出來的預設。**設定頁把它當建議值顯示，不會自己寫進設定檔。** */
export const RECOMMENDED_EMBED_MODEL = 'qwen3-embedding:4b';

/**
 * `chat` 的建議模型。**量出來的**（`docs/research/chat-choice.md`，2026-09-09）。
 *
 * 八個本機模型、兩個任務、每個任務三次而且每次換一份文件。
 * `qwen3.5:4b` 抽取六次全過、引文命中 **98%**、平均 **5 秒**（第二名 17 秒），
 * 而它只有 3.4 GB —— **比三個 30B 與第一輪評測（v0.10.3）的最佳都好。**
 *
 * **這個建議有一半在別的地方**：`chat-ollama.ts` 必須送 `think: false`。
 * 沒有那一欄的話同一個模型是 4/6、63 秒。
 *
 * 角度那一題它只回四條（上限六條），`granite4.2:8b` 回六條 ——
 * 逐任務覆寫的依據就是這個差距，而那個欄位還沒有做。
 */
export const RECOMMENDED_CHAT_MODEL = 'qwen3.5:4b';

/**
 * 逐任務的建議值。**同一輪量測的另一半**（`docs/research/chat-choice.md` 發現六）。
 *
 * `angles` 建議 `granite4.2:8b` 而不是 `nemotron-cascade-2:30b`，
 * 雖然後者的 `seeds` 有效率是 100%（前者 83%）。三個理由，按重要性排：
 *
 * 1. **5.3 GB 對 24 GB。** 加上 `qwen3.5:4b` 的 3.4 GB 還是同時常駐得下，
 *    而 24 GB 那一個換任務就要把對方擠出顯示記憶體 —— 逐任務覆寫的前提就沒了。
 * 2. **`seeds` 那一欄自己還不可信**（同一份文件的「還沒做」第三條）：
 *    同樣 `think: false` 之下 `qwen3.5` 兩個型號都是 0%，差距大到不像在量同一件事。
 *    拿一個還不可信的欄位去換 19 GB 不划算。
 * 3. 角度彼此的相似度 0.712 是全場最低（`nemotron` 0.735）——
 *    **那一欄才是「多視角有沒有真的多視角」。**
 *
 * `extract` 就是 `RECOMMENDED_CHAT_MODEL` 本身。兩者一致是刻意的：
 * **預設模型要能單獨把兩個任務都跑完**，覆寫是可選的加分，不是必要條件。
 */
export const RECOMMENDED_TASK_MODELS: Readonly<Record<ChatTask, string>> = {
  angles: 'granite4.2:8b',
  extract: RECOMMENDED_CHAT_MODEL,
};

/** 全部沒覆寫的那一份。**每個鍵都在、值是空字串。** */
export function emptyTaskModels(): Record<ChatTask, string> {
  return Object.fromEntries(CHAT_TASKS.map((task) => [task, ''])) as Record<ChatTask, string>;
}

/**
 * **這個任務實際會跑在哪個模型上。**
 *
 * 覆寫是空的就跟著 `model`。回空字串代表「這個任務沒有模型可用」——
 * 呼叫端要當成沒設定，不要當成「用預設的那個」。
 */
export function chatModelFor(chat: ChatConfig | null, task: ChatTask): string {
  if (chat === null) return '';
  const override = chat.taskModels[task]?.trim() ?? '';
  return override.length > 0 ? override : chat.model.trim();
}

/**
 * 從任意輸入讀出逐任務覆寫。**不認得的鍵一律丟掉**，不是原樣留著。
 *
 * 讀設定檔與收 HTTP 請求用的是同一支，那是刻意的：
 * 兩份各自寫的解析會漂，而漂掉的那一種形狀是「存進去的鍵讀不出來」。
 */
export function taskModelsOf(raw: unknown): Record<ChatTask, string> {
  const out = emptyTaskModels();
  if (typeof raw !== 'object' || raw === null) return out;
  const record = raw as Record<string, unknown>;
  for (const task of CHAT_TASKS) out[task] = str(record[task]);
  return out;
}

/**
 * 診斷。**目前只有一個開關，而它預設是關的。**
 *
 * 打開之後，會花模型的那三個任務把「當時送出去什麼、回來什麼」寫進
 * 那個專題的 `model-calls\` 資料夾（`domain/provider/call-record.ts`）。
 *
 * **為什麼它在 provider 設定裡**：它問的是「模型這一塊要不要留紀錄」，
 * 而不是某個專題的屬性 —— 換了模型之後的比較要跨專題成立。
 */
export interface DiagnosticsConfig {
  readonly logModelCalls: boolean;
}

export interface ProvidersConfig {
  readonly version: 1;
  readonly chat: ChatConfig | null;
  readonly agent: AgentConfig | null;
  readonly embed: EmbedConfig | null;
  readonly diagnostics: DiagnosticsConfig;
}

/**
 * 預設值。
 *
 * **`chat` 有預設而 `agent` 沒有，那是刻意的不對稱**：
 * Ollama 的位址是它自己的慣例（`127.0.0.1:11434`），猜得準；
 * 但**模型名猜不準**，所以 `model` 是空的 —— 空的就等於沒設定，
 * 設定頁會把偵測到的清單列出來讓人挑。
 *
 * agent 那一邊「跑一個外部 CLI」是有實際後果的動作
 * （它是使用者權限下的完整程式，而且會花錢），**不預設開啟。**
 */
export const DEFAULT_CONFIG: ProvidersConfig = {
  version: 1,
  chat: {
    transport: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: '',
    apiKeyEnv: null,
    // **預設不覆寫。** 建議值顯示在設定頁上讓人按，不替他寫進設定檔 ——
    // 逐任務覆寫的代價是「同時要有兩個模型在機器上」，那不是我們替他決定的事。
    taskModels: emptyTaskModels(),
  },
  agent: null,
  // `embed` 跟 `chat` 同一個理由：位址猜得準，**模型名不猜**。
  // 空的就等於沒設定，設定頁把量測選出來的那一個標成「建議」讓人自己按。
  embed: { baseUrl: 'http://127.0.0.1:11434', model: '' },
  // **預設關著。** 它長得快（抽取的提示詞裡是整份正文），而多數作業沒有人會回頭看。
  diagnostics: { logModelCalls: false },
};

/**
 * 環境變數的名字有一個形狀（大寫、底線、數字），而**這裡要擋的不是打錯字**，
 * 是**有人把金鑰本身貼進這一欄**。
 * 真正的金鑰含有 `-`、`.`、小寫或很長 —— 那些一律不通過，
 * 所以它不會被寫進設定檔。
 */
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

export function apiKeyEnvOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return ENV_NAME.test(name) ? name : null;
}

export function providersFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(pointerFilePath(env)), 'providers.json');
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

/**
 * 讀設定。**壞掉的檔案退回預設值，不報錯。**
 *
 * 這跟指標檔壞掉的處理**刻意不同**：指標檔壞掉時使用者的資料在哪
 * 沒有別的辦法知道，所以要停下來問；而 provider 設定壞掉只代表
 * 「擴展這一個功能暫時沒設定」，讓整個程式打不開是不成比例的。
 */
export async function readProvidersConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProvidersConfig> {
  let raw: string;
  try {
    raw = await readFile(providersFilePath(env), 'utf8');
  } catch {
    return DEFAULT_CONFIG;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const chatRaw = parsed['chat'];
    const agentRaw = parsed['agent'];
    const chat =
      typeof chatRaw === 'object' && chatRaw !== null
        ? {
            // **舊的設定檔沒有這一欄** —— 缺就是本機 Ollama，那是 v0.18.0 之前唯一的選項。
            transport: transportOf((chatRaw as Record<string, unknown>)['transport']),
            baseUrl: str((chatRaw as Record<string, unknown>)['baseUrl']),
            model: str((chatRaw as Record<string, unknown>)['model']),
            apiKeyEnv: apiKeyEnvOf((chatRaw as Record<string, unknown>)['apiKeyEnv']),
            // **舊的設定檔沒有這一欄** —— 缺就是全部沒覆寫，而不是壞掉。
            taskModels: taskModelsOf((chatRaw as Record<string, unknown>)['taskModels']),
          }
        : null;
    const agentArgs = (agentRaw as Record<string, unknown> | null)?.['args'];
    const agent =
      typeof agentRaw === 'object' && agentRaw !== null
        ? {
            command: str((agentRaw as Record<string, unknown>)['command']),
            args: Array.isArray(agentArgs) ? agentArgs.map((a) => String(a)) : [],
            // **舊的設定檔沒有這一欄** —— 缺就是空字串（不帶 `--model`），不是壞掉。
            model: str((agentRaw as Record<string, unknown>)['model']),
          }
        : null;
    const embedRaw = parsed['embed'];
    const embed =
      typeof embedRaw === 'object' && embedRaw !== null
        ? {
            baseUrl: str((embedRaw as Record<string, unknown>)['baseUrl']),
            model: str((embedRaw as Record<string, unknown>)['model']),
          }
        : null;
    const diagRaw = parsed['diagnostics'];
    return {
      version: 1,
      chat: chat === null || chat.baseUrl.length === 0 ? DEFAULT_CONFIG.chat : chat,
      agent: agent === null || agent.command.length === 0 ? null : agent,
      // **舊的設定檔沒有這一欄** —— 缺就是關著，而「關著」正是預設。
      diagnostics: {
        logModelCalls:
          typeof diagRaw === 'object' &&
          diagRaw !== null &&
          (diagRaw as Record<string, unknown>)['logModelCalls'] === true,
      },
      // **舊的設定檔沒有這一欄** —— 缺就退回預設（位址有、模型空），
      // 而不是變成 `null`：`null` 會讓設定頁上那一格連位址都是空的。
      embed: embed === null || embed.baseUrl.length === 0 ? DEFAULT_CONFIG.embed : embed,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** 寫設定。**無 BOM 的 UTF-8**（`.json` 不要 BOM，CONVENTIONS §8）。 */
export async function writeProvidersConfig(
  config: ProvidersConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = providersFilePath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
