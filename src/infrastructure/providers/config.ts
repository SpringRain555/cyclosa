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
 * 沒有這個檔就是「一個任務都沒設定」，那不是錯誤 ——
 * 這個工具的其餘部分（匯入、閱讀器、圖、裁決、全文檢索）**完全不需要模型**。
 *
 * ## v2：任務 → 連線 ＋ 模型（2026-09-19，ADR-0032）
 *
 * v1 的形狀是三個「角色」（agent／chat／embed），每個角色一條連線、一個預設模型，
 * `chat` 底下再逐任務覆寫**模型**。它有一條明寫的限制：**`baseUrl` 與 `apiKeyEnv`
 * 刻意不能逐任務覆寫** —— 兩個任務跑在不同端點上，「本機模型不花錢」這件事就按任務而異。
 *
 * 2026-09-18 使用者第一次真的用，要的正是那個被排除的形狀：歸納角度留在本機 Ollama，
 * 抽取走線上端點（額度大得多）。而設定頁上「可調用模型」與「各任務模型」兩張表講的是
 * 同一件事的兩半，使用者問「這兩個是不是重複」。
 *
 * 所以 v2 的主鍵是**任務**：每一個任務各自說「走哪一條連線、用哪個模型」；
 * 連線只定義一次（CLI、本機 Ollama、OpenAI 相容端點各一條）。
 * 「不花錢」那件事改成逐任務說（設定頁與作業紀錄都寫得出每一次呼叫走的是哪一條）。
 *
 * **舊檔案讀到就原地升版**（`upgradeV1`），不用使用者做任何事；下一次存檔就是 v2。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  MODEL_TASKS,
  roleOfTask,
  type ChatTask,
  type ModelTask,
} from '../../domain/provider/index.js';
import { pointerFilePath } from '../fs/paths.js';

/**
 * 三種連線。**這組字串也是設定檔裡 `via` 欄位的值**，web 那一邊抄了一份
 * （`tests/guards/chat-tasks.test.ts` 釘著一致）。
 *
 * | 值 | 是什麼 | 打哪裡 |
 * |---|---|---|
 * | `cli` | Claude Code CLI（`claude -p`）| 子程序 |
 * | `ollama` | 本機 Ollama，原生協定 | `/api/tags`、`/api/chat`、`/api/embed` |
 * | `openai` | 任何 OpenAI 相容端點（線上的、或別家本機伺服器）| `/models`、`/chat/completions` |
 *
 * ## 為什麼本機 Ollama 不改走 OpenAI 相容那條
 *
 * 它現在也支援 `json_schema` 了（2026-09-11 實測）。
 * **留下原生那條的理由是一個量得到的數字**：`/v1` 送不了 `think: false`，
 * 同一題 `qwen3.5:4b` 走 `/v1` 是 4.1 秒、2,935 字的思考，
 * 走原生並關掉思考是 **0.45 秒、0 字**（`docs/research/openai-compat-json-schema.md`）。
 * 而 `num_ctx` 也只有原生那條送得出去 —— 少了它，正文會在小 context 的機器上被安靜截斷。
 *
 * **不自動偵測。** 兩種協定 Ollama 都答得出來，「它看起來像哪一種」
 * 猜錯的代價是那兩個量出來的設定安靜地消失。這是使用者選的事實。
 */
export const CONNECTION_KINDS = ['cli', 'ollama', 'openai'] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** v1 的 `chat.transport` —— 兩種 HTTP 連線。留著給 registry 與 web 的型別用。 */
export const CHAT_TRANSPORTS = ['ollama', 'openai'] as const;
export type ChatTransport = (typeof CHAT_TRANSPORTS)[number];

export function transportOf(value: unknown): ChatTransport {
  return value === 'openai' ? 'openai' : 'ollama';
}

/** Claude Code CLI。 */
export interface CliConnection {
  /** CLI 的名字或完整路徑。**預設 `claude`，靠 PATH 找** */
  readonly command: string;
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
 * 一條 HTTP 連線（本機 Ollama 或 OpenAI 相容端點）。
 *
 * `baseUrl` 兩種協定的慣例不一樣：Ollama 是 `http://127.0.0.1:11434`（不含 `/v1`），
 * OpenAI 相容端點照各家文件的寫法**含 `/v1`**（`https://api.example.com/v1`）。
 *
 * `apiKeyEnv`：帶金鑰的話，**金鑰在哪個環境變數裡** —— 不是金鑰本身。
 * 這是 2026-09-08 定的：這個設定檔會被備份、會被同步、會在求助的時候被整份貼出來，
 * 所以這裡存的是名字，值只在送出請求的那一刻從環境讀一次。
 * `null` ＝ 不帶授權標頭（本機 Ollama 就是這樣）。
 */
export interface HttpConnection {
  readonly baseUrl: string;
  readonly apiKeyEnv: string | null;
}

export interface Connections {
  /** `null` ＝ 沒設定。跑一個外部 CLI 是有實際後果的動作（它會花錢），**不預設開啟**。 */
  readonly cli: CliConnection | null;
  /** 永遠有一條 —— 位址是 Ollama 自己的慣例（`127.0.0.1:11434`），猜得準。 */
  readonly ollama: HttpConnection;
  /** `null` ＝ 沒設定。位址猜不準，所以沒有預設。 */
  readonly openai: HttpConnection | null;
}

/** 一個任務走哪一條連線、用哪個模型。**`model` 是空字串 ＝ 這個任務還沒選模型**（CLI 例外：空 ＝ 用 CLI 自己的預設）。 */
export interface TaskSetting {
  readonly via: ConnectionKind;
  readonly model: string;
}

/**
 * 每個任務**可以**走哪些連線。**由角色推出來，不另外手寫一份。**
 *
 * - 找來源要 `browse`，只有 CLI 有 —— 所以只能是 `cli`。
 * - 歸納與抽取是對話模型，本機或線上都行。
 * - 嵌入只准本機（ADR-0009）：向量會被寫進資料庫並長期保存，
 *   一個雲端端點隨時可能換掉背後的權重，**而那些變化不會報錯，只會讓比對安靜地變爛**。
 */
export function viaOptionsOf(task: ModelTask): readonly ConnectionKind[] {
  const role = roleOfTask(task);
  if (role === 'agent') return ['cli'];
  if (role === 'embed') return ['ollama'];
  return ['ollama', 'openai'];
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
  readonly version: 2;
  readonly connections: Connections;
  readonly tasks: Readonly<Record<ModelTask, TaskSetting>>;
  readonly diagnostics: DiagnosticsConfig;
}

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';

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
 */
export const RECOMMENDED_CHAT_MODEL = 'qwen3.5:4b';

/**
 * 逐任務的建議值。**同一輪量測的另一半**（`docs/research/chat-choice.md` 發現六）。
 *
 * `angles` 建議 `granite4.2:8b` 而不是 `nemotron-cascade-2:30b`，
 * 雖然後者的 `seeds` 有效率是 100%（前者 83%）。三個理由，按重要性排：
 *
 * 1. **5.3 GB 對 24 GB。** 加上 `qwen3.5:4b` 的 3.4 GB 還是同時常駐得下，
 *    而 24 GB 那一個換任務就要把對方擠出顯示記憶體。
 * 2. **`seeds` 那一欄自己還不可信**（同一份文件的「還沒做」第三條）。
 * 3. 角度彼此的相似度 0.712 是全場最低（`nemotron` 0.735）——
 *    **那一欄才是「多視角有沒有真的多視角」。**
 *
 * `extract` 就是 `RECOMMENDED_CHAT_MODEL` 本身。兩者一致是刻意的：
 * **預設模型要能單獨把兩個任務都跑完**，分開只是可選的加分，不是必要條件。
 *
 * **這些數字是在本機 Ollama 上量的**，所以設定頁只對走 `ollama` 的任務顯示建議。
 */
export const RECOMMENDED_TASK_MODELS: Readonly<Record<ChatTask, string>> = {
  angles: 'granite4.2:8b',
  extract: RECOMMENDED_CHAT_MODEL,
};

/**
 * 預設值：一個任務都還沒選模型。
 *
 * **Ollama 的位址有預設而 CLI 沒有，那是刻意的不對稱**：
 * 位址是 Ollama 自己的慣例，猜得準；但**模型名猜不準**，所以每個任務的 `model` 是空的 ——
 * 空的就等於沒設定，設定頁會把偵測到的清單列出來讓人挑。
 */
export const DEFAULT_CONFIG: ProvidersConfig = {
  version: 2,
  connections: {
    cli: null,
    ollama: { baseUrl: OLLAMA_DEFAULT_URL, apiKeyEnv: null },
    openai: null,
  },
  tasks: {
    'find-sources': { via: 'cli', model: '' },
    angles: { via: 'ollama', model: '' },
    extract: { via: 'ollama', model: '' },
    embed: { via: 'ollama', model: '' },
  },
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

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function httpConnectionOf(raw: unknown): HttpConnection | null {
  const rec = obj(raw);
  if (rec === null) return null;
  const baseUrl = str(rec['baseUrl']);
  return baseUrl.length === 0 ? null : { baseUrl, apiKeyEnv: apiKeyEnvOf(rec['apiKeyEnv']) };
}

function cliConnectionOf(raw: unknown): CliConnection | null {
  const rec = obj(raw);
  if (rec === null) return null;
  const command = str(rec['command']);
  if (command.length === 0) return null;
  const args = rec['args'];
  return { command, args: Array.isArray(args) ? args.map((a) => String(a)) : [] };
}

/**
 * 從任意輸入讀出 v2 的形狀。**讀設定檔與收 HTTP 請求用的是同一支**，那是刻意的：
 * 兩份各自寫的解析會漂，而漂掉的那一種形狀是「存進去的鍵讀不出來」。
 *
 * - 不認得的任務名一律丟掉，**每個任務都有一格**（缺鍵與空字串在 JSON 來回一趟之後會混在一起）。
 * - `via` 不在那個任務准許的清單裡就退回第一個准許的 —— 一個指向不存在連線的任務比沒設定更糟。
 * - `openai` 連線沒位址就是 `null`；`ollama` 沒位址就退回慣例位址。
 */
export function parseConfigV2(raw: Record<string, unknown>): ProvidersConfig {
  const conn = obj(raw['connections']) ?? {};
  const ollama = httpConnectionOf(conn['ollama']) ?? DEFAULT_CONFIG.connections.ollama;
  const tasksRaw = obj(raw['tasks']) ?? {};
  const tasks = Object.fromEntries(
    MODEL_TASKS.map(({ task }) => {
      const rec = obj(tasksRaw[task]) ?? {};
      const allowed = viaOptionsOf(task);
      const via = allowed.includes(rec['via'] as ConnectionKind)
        ? (rec['via'] as ConnectionKind)
        : (allowed[0] as ConnectionKind);
      return [task, { via, model: str(rec['model']) }];
    }),
  ) as Record<ModelTask, TaskSetting>;
  return {
    version: 2,
    connections: {
      cli: cliConnectionOf(conn['cli']),
      ollama,
      openai: httpConnectionOf(conn['openai']),
    },
    tasks,
    diagnostics: { logModelCalls: obj(raw['diagnostics'])?.['logModelCalls'] === true },
  };
}

/**
 * v1 → v2。**原地升版，不用使用者做任何事。**
 *
 * | v1 | v2 |
 * |---|---|
 * | `agent.command/args` | `connections.cli` |
 * | `agent.model` | `tasks['find-sources'].model` |
 * | `chat.transport/baseUrl/apiKeyEnv` | `connections.ollama` 或 `connections.openai`（看 transport）|
 * | `chat.model` ＋ `chat.taskModels[task]`（覆寫優先）| `tasks.angles/extract.model`，`via` ＝ transport |
 * | `embed.baseUrl/model` | `connections.ollama.baseUrl`（chat 不是 ollama 時）＋ `tasks.embed.model` |
 * | `diagnostics` | 原樣 |
 *
 * 唯一有損的一格：v1 的 chat 與 embed 可以指向**兩個不同的 Ollama 位址**，v2 只有一條 Ollama 連線。
 * chat 走 Ollama 的話用 chat 的位址（那一條有金鑰欄位），否則用 embed 的。
 */
export function upgradeV1(raw: Record<string, unknown>): ProvidersConfig {
  const chat = obj(raw['chat']);
  const agent = obj(raw['agent']);
  const embed = obj(raw['embed']);
  const transport = transportOf(chat?.['transport']);
  const chatUrl = str(chat?.['baseUrl']);
  const chatKey = apiKeyEnvOf(chat?.['apiKeyEnv']);
  const embedUrl = str(embed?.['baseUrl']);
  const overrides = obj(chat?.['taskModels']) ?? {};
  const chatModel = str(chat?.['model']);
  const chatTask = (task: ChatTask): TaskSetting => {
    const override = str(overrides[task]);
    return {
      via: chatUrl.length === 0 ? 'ollama' : transport,
      model: override.length > 0 ? override : chatModel,
    };
  };
  const ollamaUrl =
    transport === 'ollama' && chatUrl.length > 0
      ? chatUrl
      : embedUrl.length > 0
        ? embedUrl
        : OLLAMA_DEFAULT_URL;
  return {
    version: 2,
    connections: {
      cli: cliConnectionOf(agent),
      ollama: {
        baseUrl: ollamaUrl,
        apiKeyEnv: transport === 'ollama' ? chatKey : null,
      },
      openai:
        transport === 'openai' && chatUrl.length > 0
          ? { baseUrl: chatUrl, apiKeyEnv: chatKey }
          : null,
    },
    tasks: {
      'find-sources': { via: 'cli', model: str(agent?.['model']) },
      angles: chatTask('angles'),
      extract: chatTask('extract'),
      embed: { via: 'ollama', model: str(embed?.['model']) },
    },
    diagnostics: { logModelCalls: obj(raw['diagnostics'])?.['logModelCalls'] === true },
  };
}

/** 任意輸入 → 設定。**`version: 2` 走 v2，其餘（含沒有 version 的）當 v1 升。** */
export function parseConfig(raw: unknown): ProvidersConfig {
  const rec = obj(raw);
  if (rec === null) return DEFAULT_CONFIG;
  return rec['version'] === 2 ? parseConfigV2(rec) : upgradeV1(rec);
}

/** 這個任務走的那一條連線；`cli` 回 `null`（它不是 HTTP）。 */
export function httpConnectionFor(config: ProvidersConfig, task: ModelTask): HttpConnection | null {
  const via = config.tasks[task].via;
  if (via === 'ollama') return config.connections.ollama;
  if (via === 'openai') return config.connections.openai;
  return null;
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
    return parseConfig(JSON.parse(raw));
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
