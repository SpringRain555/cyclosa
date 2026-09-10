/**
 * 依設定建出 provider，並回報它們現在的狀態。
 *
 * **這一層不做配對判斷** —— 配對是 `domain/provider` 的純函式。
 * 這裡只負責「把設定變成一個能打的東西」與「去問它現在還在不在」。
 *
 * ## 為什麼每次都重新建
 *
 * provider 的狀態會在程式沒有參與的情況下改變：Ollama 被關掉、
 * 模型被 `ollama rm` 掉、`claude` 被移出 PATH。
 * **快取一個「它是好的」會在最需要準確的時候是錯的**，
 * 而建一個物件的成本是零 —— 真正的成本在 `probe()`，那一支本來就要打出去問。
 */
import type { ChatTask, ProviderRole } from '../../domain/provider/index.js';
import {
  CHAT_TASKS,
  NO_CAPABILITIES,
  type ProviderCapabilities,
} from '../../domain/provider/index.js';
import { chatModelFor, readProvidersConfig, type ProvidersConfig } from './config.js';
import { createClaudeAgent } from './agent-claude.js';
import { createOllamaChat, listOllamaModels } from './chat-ollama.js';
import { createOllamaEmbed, type EmbedProvider } from './embed-ollama.js';
import type { AgentProvider, ChatProvider, ProbeResult } from './types.js';

export interface ProviderStatus {
  readonly role: ProviderRole;
  /** 設定裡寫的是什麼。**空字串代表沒設定** */
  readonly configured: string;
  readonly state: 'ready' | 'not-configured' | 'unreachable';
  readonly detail: string;
  /** 版本。agent 是 CLI 的版本號，chat 是參數量與量化格式。**問不到就是 `null`。** */
  readonly version: string | null;
  /**
   * 授權來自哪裡。**畫面上要說出來** ——
   * 「沒設定金鑰」與「設了一個環境變數但那個變數是空的」是兩種完全不同的處境，
   * 而它們的症狀（打不通）一模一樣。
   */
  readonly auth: 'none' | 'env-set' | 'env-missing';
  readonly capabilities: ProviderCapabilities;
}

function authOf(apiKeyEnv: string | null, env: NodeJS.ProcessEnv): ProviderStatus['auth'] {
  if (apiKeyEnv === null || apiKeyEnv.length === 0) return 'none';
  const value = env[apiKeyEnv];
  return typeof value === 'string' && value.trim().length > 0 ? 'env-set' : 'env-missing';
}

function statusOf(
  role: ProviderRole,
  configured: string,
  probe: ProbeResult,
  auth: ProviderStatus['auth'] = 'none',
): ProviderStatus {
  if (probe.kind === 'ready') {
    return {
      role,
      configured,
      state: 'ready',
      detail: probe.model,
      version: probe.version,
      auth,
      capabilities: probe.capabilities,
    };
  }
  if (probe.kind === 'unreachable') {
    return {
      role,
      configured,
      state: 'unreachable',
      detail: probe.detail,
      version: null,
      auth,
      capabilities: NO_CAPABILITIES,
    };
  }
  return {
    role,
    configured,
    state: 'not-configured',
    detail: '',
    version: null,
    auth,
    capabilities: NO_CAPABILITIES,
  };
}

/**
 * agent 的 schema 與系統提示是**每次呼叫都不一樣的**（找來源 vs 抽關聯），
 * 所以 `createClaudeAgent` 要它們當參數 —— 這一支負責把設定那一半補上。
 */
export interface AgentRequest {
  readonly schema: Readonly<Record<string, unknown>>;
  readonly systemPrompt: string;
  readonly maxCostUsd: number | null;
}

export interface Providers {
  readonly config: ProvidersConfig;
  /**
   * **預設模型那一支。** 設定頁的「實際打一次」用它。
   *
   * **跑任務不要用這一個** —— 用 `chatFor(task)`，否則逐任務覆寫會被繞過去，
   * 而繞過去的症狀是「設了沒有生效」：畫面上完全看不出來。
   */
  readonly chat: ChatProvider | null;
  /** 這個任務實際會跑在哪一支上。**覆寫是空的就是預設那一支。** */
  chatFor(task: ChatTask): ChatProvider | null;
  /**
   * 嵌入。**`null` ＝ 沒設定模型**，而那不是錯誤 ——
   * 匯入、閱讀器、圖、裁決、全文檢索完全不需要它（`config.ts` 檔頭）。
   */
  readonly embed: EmbedProvider | null;
  agentFor(request: AgentRequest): AgentProvider | null;
}

export async function loadProviders(env: NodeJS.ProcessEnv = process.env): Promise<Providers> {
  const config = await readProvidersConfig(env);
  /**
   * 同一個模型只建一支。
   *
   * 建物件的成本是零（這個檔頭寫過），但**兩支同名的 provider 會各自 probe 一次**，
   * 而設定頁一打開就會全部 probe —— 兩個任務用同一個模型是最常見的設定，
   * 沒有理由為它多打一次 `/api/tags`。
   */
  const built = new Map<string, ChatProvider>();
  const chatOf = (model: string): ChatProvider | null => {
    if (config.chat === null || model.length === 0) return null;
    const existing = built.get(model);
    if (existing !== undefined) return existing;
    const made = createOllamaChat(config.chat.baseUrl, model, config.chat.apiKeyEnv, env);
    built.set(model, made);
    return made;
  };
  const agentCommand = config.agent?.command ?? '';
  const agentArgs = config.agent?.args ?? [];
  const agentModel = config.agent?.model.trim() ?? '';
  const embedModel = config.embed?.model.trim() ?? '';
  return {
    config,
    chat: chatOf(config.chat?.model.trim() ?? ''),
    chatFor: (task) => chatOf(chatModelFor(config.chat, task)),
    embed:
      config.embed === null || embedModel.length === 0
        ? null
        : createOllamaEmbed(config.embed.baseUrl, embedModel),
    agentFor: (request) =>
      agentCommand.length === 0
        ? null
        : createClaudeAgent({
            command: agentCommand,
            args: agentArgs,
            model: agentModel,
            ...request,
          }),
  };
}

/**
 * `chat` 底下每一個任務**實際會跑在哪個模型上，以及那個模型現在的狀態**。
 *
 * 角色層的那一格（`statuses` 裡的 `chat`）講的是預設模型 ——
 * **覆寫之後那一格就不再等於實際會跑的東西**，所以這裡要分開講。
 * 少了這一層的話，畫面會出現「角色是綠的、按下擴展卻停手」：
 * 綠的是預設模型，停手的是覆寫的那一個。
 */
export interface ChatTaskStatus {
  readonly task: ChatTask;
  /** 實際會跑的模型。**空字串 ＝ 這個任務沒有模型可用** */
  readonly model: string;
  /** 是覆寫來的，還是跟著預設。**畫面上要分得開** */
  readonly overridden: boolean;
  readonly state: ProviderStatus['state'];
  readonly capabilities: ProviderCapabilities;
}

export interface ProvidersView {
  readonly statuses: readonly ProviderStatus[];
  /** Ollama 上真的有的模型。**`null` 代表連不上**，不是「一個都沒有」 */
  readonly chatModels: readonly string[] | null;
  readonly chatTasks: readonly ChatTaskStatus[];
  readonly config: ProvidersConfig;
}

/**
 * 設定頁要的東西。
 *
 * `embed` 也列出來，而且**永遠是「沒設定」** —— 它是 Stage 12 的事。
 * 列出來的理由是 ui-workflows 寫的「三個角色各自設定」：
 * **少列一個角色，使用者會以為這個工具只有兩種模型。**
 */
export async function describeProviders(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProvidersView> {
  const providers = await loadProviders(env);
  const chatConfigured = providers.config.chat?.model.trim() ?? '';
  const agentConfigured = providers.config.agent?.command ?? '';
  const embedConfigured = providers.config.embed?.model ?? '';

  /**
   * 要 probe 哪幾個模型：預設那一個，加上每個任務實際會跑的那一個。
   *
   * **同一個模型只 probe 一次。** 兩個任務跟著預設是最常見的設定，
   * 那種情況下這個 Map 只有一格 —— 逐任務覆寫不該讓打開設定頁變慢三倍。
   */
  const plan = CHAT_TASKS.map((task) => ({
    task,
    model: chatModelFor(providers.config.chat, task),
    overridden: (providers.config.chat?.taskModels[task] ?? '').trim().length > 0,
    provider: providers.chatFor(task),
  }));
  const toProbe = new Map<string, ChatProvider>();
  if (providers.chat !== null) toProbe.set(chatConfigured, providers.chat);
  for (const row of plan) {
    if (row.provider !== null && !toProbe.has(row.model)) toProbe.set(row.model, row.provider);
  }

  const [probed, agentProbe, chatModels] = await Promise.all([
    Promise.all(
      [...toProbe].map(async ([model, provider]) => [model, await provider.probe()] as const),
    ).then((rows) => new Map<string, ProbeResult>(rows)),
    agentConfigured.length === 0
      ? Promise.resolve<ProbeResult>({ kind: 'not-configured' })
      : (
          providers.agentFor({ schema: {}, systemPrompt: '', maxCostUsd: null }) as AgentProvider
        ).probe(),
    providers.config.chat === null
      ? Promise.resolve<readonly string[] | null>(null)
      : listOllamaModels(providers.config.chat.baseUrl),
  ]);

  const notConfigured: ProbeResult = { kind: 'not-configured' };
  const chatProbe = probed.get(chatConfigured) ?? notConfigured;

  return {
    statuses: [
      statusOf('agent', agentConfigured, agentProbe),
      statusOf(
        'chat',
        chatConfigured,
        chatProbe,
        authOf(providers.config.chat?.apiKeyEnv ?? null, env),
      ),
      statusOf('embed', embedConfigured, embedProbe(embedConfigured, chatModels)),
    ],
    chatModels,
    chatTasks: plan.map((row) => {
      const status = statusOf('chat', row.model, probed.get(row.model) ?? notConfigured);
      return {
        task: row.task,
        model: row.model,
        overridden: row.overridden,
        state: status.state,
        capabilities: status.capabilities,
      };
    }),
    config: providers.config,
  };
}

/**
 * `embed` 的「探測」：**看設定的那個模型在不在 Ollama 上**，僅此而已。
 *
 * 沒有真的送一次嵌入請求，理由跟這個檔頭寫的一樣 ——
 * 打開設定頁不該產生工作。而對本機嵌入模型來說「送一次」還有第二個代價：
 * **它會把那個模型載進顯示記憶體**，而 Ollama 一次只常駐一個，
 * 於是光是打開設定頁就會把使用者正在用的 chat 模型擠出去。
 *
 * 能力宣告一律是 `NO_CAPABILITIES`：`browse`／`tools`／`json_schema`／`vision`
 * 對嵌入模型一個都不適用，**而假裝它有比誠實說沒有更糟**。
 * 語意檢索那一半接上去之前，這一格的意義就是「模型選好了、也真的在」。
 */
function embedProbe(model: string, available: readonly string[] | null): ProbeResult {
  if (model.length === 0) return { kind: 'not-configured' };
  // 連不上跟「拉了但沒有這個模型」是兩件事，訊息也該不一樣。
  if (available === null) return { kind: 'unreachable', detail: 'Ollama 沒有回應' };
  if (!available.includes(model)) {
    return { kind: 'unreachable', detail: `Ollama 上找不到 ${model}` };
  }
  return { kind: 'ready', model, version: null, capabilities: NO_CAPABILITIES };
}
