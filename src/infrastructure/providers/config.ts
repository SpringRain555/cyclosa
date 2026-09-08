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

import { pointerFilePath } from '../fs/paths.js';

export interface ChatConfig {
  /** OpenAI 相容端點的根位址，例如 `http://127.0.0.1:11434` */
  readonly baseUrl: string;
  readonly model: string;
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
   * 接在 `command` 後面、我們自己那些旗標**前面**的參數。
   *
   * 存在的理由是包裝：`npx claude`、`wsl claude`、或者測試裡的
   * 「用 node 跑一支假的 CLI」都是 `command ＋ 前綴參數` 這個形狀。
   * **沒有它的話，那幾種情況只能靠 shell 字串拼接**，而那在 Windows 上
   * 是引號地獄，也是一條把使用者輸入送進 shell 的路。
   */
  readonly args: readonly string[];
}

export interface ProvidersConfig {
  readonly version: 1;
  readonly chat: ChatConfig | null;
  readonly agent: AgentConfig | null;
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
  chat: { baseUrl: 'http://127.0.0.1:11434', model: '', apiKeyEnv: null },
  agent: null,
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
            baseUrl: str((chatRaw as Record<string, unknown>)['baseUrl']),
            model: str((chatRaw as Record<string, unknown>)['model']),
            apiKeyEnv: apiKeyEnvOf((chatRaw as Record<string, unknown>)['apiKeyEnv']),
          }
        : null;
    const agentArgs = (agentRaw as Record<string, unknown> | null)?.['args'];
    const agent =
      typeof agentRaw === 'object' && agentRaw !== null
        ? {
            command: str((agentRaw as Record<string, unknown>)['command']),
            args: Array.isArray(agentArgs) ? agentArgs.map((a) => String(a)) : [],
          }
        : null;
    return {
      version: 1,
      chat: chat === null || chat.baseUrl.length === 0 ? DEFAULT_CONFIG.chat : chat,
      agent: agent === null || agent.command.length === 0 ? null : agent,
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
