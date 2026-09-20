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
 *
 * ## v2：以任務為主鍵（ADR-0032）
 *
 * 每個任務各自說「走哪一條連線、用哪個模型」（`config.ts`）。
 * 所以這裡沒有「預設的 chat」—— **跑任務一律 `chatFor(task)`**，而狀態也是逐任務回報：
 * 一份「連線」的清單（連得上嗎、有哪些模型）＋ 一份「任務」的清單（這個任務的模型在不在、
 * 能力夠不夠、格式保證是哪一種）。設定頁上那張表就是後者。
 */
import type { ChatTask, ModelTask, ProviderRole } from '../../domain/provider/index.js';
import {
  MODEL_TASKS,
  NO_CAPABILITIES,
  type ProviderCapabilities,
} from '../../domain/provider/index.js';
import {
  httpConnectionFor,
  readProvidersConfig,
  type ConnectionKind,
  type HttpConnection,
  type ProvidersConfig,
} from './config.js';
import { createChatAgent } from './agent-chat.js';
import { createClaudeAgent } from './agent-claude.js';
import { createOpenAiAgent } from './agent-openai.js';
import { createOllamaChat, listOllamaModels } from './chat-ollama.js';
import { createOpenAiChat, listOpenAiModels } from './chat-openai.js';
import { createOllamaEmbed, type EmbedProvider } from './embed-ollama.js';
import type {
  AgentProvider,
  BrowseReport,
  ChatProvider,
  JsonModeReport,
  ProbeResult,
} from './types.js';

export type ProviderState = 'ready' | 'not-configured' | 'unreachable';
export type AuthState = 'none' | 'env-set' | 'env-missing';

/**
 * 授權來自哪裡。**畫面上要說出來** ——
 * 「沒設定金鑰」與「設了一個環境變數但那個變數是空的」是兩種完全不同的處境，
 * 而它們的症狀（打不通）一模一樣。
 */
export function authOf(apiKeyEnv: string | null, env: NodeJS.ProcessEnv): AuthState {
  if (apiKeyEnv === null || apiKeyEnv.length === 0) return 'none';
  const value = env[apiKeyEnv];
  return typeof value === 'string' && value.trim().length > 0 ? 'env-set' : 'env-missing';
}

/** 一條連線現在的狀態。**每一條各自問一次**，不管有沒有任務走它。 */
export interface ConnectionStatus {
  readonly kind: ConnectionKind;
  /** 設定裡有沒有這一條。`ollama` 永遠是 true（位址有預設）。 */
  readonly configured: boolean;
  readonly state: ProviderState;
  /** 連不上的時候是原因；CLI 連得上的時候是空字串（版本在 `version`）。 */
  readonly detail: string;
  /** CLI 的版本號。HTTP 連線問不到，是 `null`。 */
  readonly version: string | null;
  readonly auth: AuthState;
  /**
   * 這條連線上真的有的模型。**`null` 代表列不出來**，不是「一個都沒有」。
   * Ollama 問 `/api/tags`，OpenAI 相容端點問 `/models`，CLI 不吐清單（永遠 `null`）。
   */
  readonly models: readonly string[] | null;
}

/**
 * 一個任務現在跑不跑得動。**逐任務，因為每個任務可以走不同的連線、不同的模型** ——
 * 少了這一層的話，畫面會出現「連線是綠的、按下擴展卻停手」：綠的是連線，停手的是那個模型。
 */
export interface TaskStatus {
  readonly task: ModelTask;
  readonly role: ProviderRole;
  readonly via: ConnectionKind;
  /** 這個任務的模型。**空字串 ＝ 還沒選**（CLI 例外：空 ＝ 用 CLI 自己的預設）。 */
  readonly model: string;
  readonly state: ProviderState;
  /** 連不上或找不到模型的原因。 */
  readonly detail: string;
  /** 模型的版本：Ollama 是參數量與量化格式，CLI 是版本號。**問不到就是 `null`。** */
  readonly version: string | null;
  readonly capabilities: ProviderCapabilities;
  /** 「符合 schema」由誰保證。**只有對話任務有**，其餘是 `null`（ADR-0030）。 */
  readonly jsonMode: JsonModeReport | null;
  /**
   * 「會不會上網搜尋」。**只有找來源那一列有**，其餘是 `null`（v0.24.2，ADR-0034）。
   * 走 CLI 的時候 `checkedAt` 是 `null`：那是我們給它的參數（`--tools WebSearch`），不是量的；
   * 走 OpenAI 相容 API 的時候是量出來的，或還沒量。
   */
  readonly browse: BrowseReport | null;
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
   * 這個任務實際會跑在哪一支上。**`null` ＝ 這個任務還沒選模型，或它的連線沒設定。**
   * 跑任務只有這一條路 —— 沒有「預設的 chat」可以繞。
   */
  chatFor(task: ChatTask): ChatProvider | null;
  /**
   * 嵌入。**`null` ＝ 沒設定模型**，而那不是錯誤 ——
   * 匯入、閱讀器、圖、裁決、全文檢索完全不需要它（`config.ts` 檔頭）。
   */
  readonly embed: EmbedProvider | null;
  agentFor(request: AgentRequest): AgentProvider | null;
  /**
   * 規劃對話（ADR-0033 D5）。**三個服務都可以，而且能力不同** ——
   * Claude Code 與量過會搜尋的 OpenAI 相容 API 邊查邊談，本機 Ollama 只能談。
   *
   * 回的是 agent 的形狀（送一段字、拿一份 JSON），本機那條由 `createChatAgent` 包過來。
   * `null` ＝ 這個任務的服務沒設定，或它需要模型而還沒選。
   */
  planFor(request: AgentRequest): AgentProvider | null;
  /**
   * 規劃對話走**本機 Ollama** 時的那一支對話 provider；走其他服務時是 `null`。
   *
   * 存在的理由只有一個：設定頁要說得出那一格的「格式保證是哪一種」（ADR-0030），
   * 而那個問題只有 `ChatProvider` 答得出來 —— `planFor` 回的是 agent 的形狀，沒有這一支。
   */
  planChat(): ChatProvider | null;
  /** 這個任務走的連線與端點 —— 作業紀錄要寫「這一次呼叫打到哪」。 */
  connectionOf(task: ModelTask): { readonly via: ConnectionKind; readonly baseUrl: string | null };
}

function chatProviderOf(
  connection: HttpConnection,
  via: ConnectionKind,
  model: string,
  env: NodeJS.ProcessEnv,
): ChatProvider {
  return via === 'openai'
    ? createOpenAiChat(connection.baseUrl, model, connection.apiKeyEnv, env)
    : createOllamaChat(connection.baseUrl, model, connection.apiKeyEnv, env);
}

export async function loadProviders(env: NodeJS.ProcessEnv = process.env): Promise<Providers> {
  const config = await readProvidersConfig(env);
  /**
   * 同一條連線上的同一個模型只建一支。
   *
   * 建物件的成本是零（這個檔頭寫過），但**兩支同名的 provider 會各自 probe 一次**，
   * 而設定頁一打開就會全部 probe —— 兩個任務用同一個模型是最常見的設定。
   */
  const built = new Map<string, ChatProvider>();
  /**
   * 任意任務的對話 provider。**`chatFor` 是它對外的那一半** ——
   * 規劃對話走本機 Ollama 的時候也要走這裡（它不是 `ChatTask`，但它確實是一次對話）。
   */
  const chatOf = (task: ModelTask): ChatProvider | null => {
    const setting = config.tasks[task];
    const connection = httpConnectionFor(config, task);
    const model = setting.model.trim();
    if (connection === null || model.length === 0) return null;
    const key = `${setting.via}::${model}`;
    const existing = built.get(key);
    if (existing !== undefined) return existing;
    const made = chatProviderOf(connection, setting.via, model, env);
    built.set(key, made);
    return made;
  };
  const chatFor = (task: ChatTask): ChatProvider | null => chatOf(task);
  const cli = config.connections.cli;
  const agentSetting = config.tasks['find-sources'];
  const agentModel = agentSetting.model.trim();
  const embedModel = config.tasks.embed.model.trim();
  /**
   * 找來源走哪一支（v0.24.2）：CLI 是子程序，OpenAI 相容 API 是帶搜尋工具的 HTTP 請求。
   * **後者要有模型名**（空字串在 CLI 那邊是「用它自己的預設」，在這邊是「還沒選」）。
   */
  const agentFor = (request: AgentRequest): AgentProvider | null => {
    if (agentSetting.via === 'openai') {
      const openai = config.connections.openai;
      if (openai === null || agentModel.length === 0) return null;
      return createOpenAiAgent({
        baseUrl: openai.baseUrl,
        model: agentModel,
        apiKeyEnv: openai.apiKeyEnv,
        schema: request.schema,
        systemPrompt: request.systemPrompt,
        env,
      });
    }
    if (cli === null) return null;
    return createClaudeAgent({
      command: cli.command,
      args: cli.args,
      model: agentModel,
      ...request,
    });
  };
  /**
   * 規劃對話走哪一支（ADR-0033 D5）。三條路的差別只有一個地方看得到：**會不會上網查**。
   * OpenAI 相容 API 那一條用 `search: 'optional'` —— 談方向不強迫每一輪都搜尋
   * （找來源那一支才是 `required`）。
   */
  const planSetting = config.tasks.plan;
  const planModel = planSetting.model.trim();
  const planFor = (request: AgentRequest): AgentProvider | null => {
    if (planSetting.via === 'openai') {
      const openai = config.connections.openai;
      if (openai === null || planModel.length === 0) return null;
      return createOpenAiAgent({
        baseUrl: openai.baseUrl,
        model: planModel,
        apiKeyEnv: openai.apiKeyEnv,
        schema: request.schema,
        systemPrompt: request.systemPrompt,
        search: 'optional',
        env,
      });
    }
    if (planSetting.via === 'ollama') {
      const chat = chatOf('plan');
      return chat === null
        ? null
        : createChatAgent({ chat, systemPrompt: request.systemPrompt, schema: request.schema });
    }
    if (cli === null) return null;
    return createClaudeAgent({
      command: cli.command,
      args: cli.args,
      model: planModel,
      ...request,
    });
  };
  return {
    config,
    chatFor,
    planFor,
    planChat: () => (planSetting.via === 'ollama' ? chatOf('plan') : null),
    embed:
      embedModel.length === 0
        ? null
        : createOllamaEmbed(config.connections.ollama.baseUrl, embedModel),
    agentFor,
    connectionOf: (task) => ({
      via: config.tasks[task].via,
      baseUrl: httpConnectionFor(config, task)?.baseUrl ?? null,
    }),
  };
}

export interface ProvidersView {
  readonly connections: readonly ConnectionStatus[];
  readonly tasks: readonly TaskStatus[];
  readonly config: ProvidersConfig;
}

/**
 * 設定頁要的東西：三條連線 ＋ 四個任務，每一格各自探一次。
 *
 * **打開設定頁不該產生費用**，所以這裡對 CLI 只跑 `--version`、對 HTTP 連線只列模型清單，
 * 對每個任務的模型只問「在不在、能力宣告是什麼」（Ollama 的 `/api/show`）。
 * 「儲存並測試」是使用者按的按鈕（`provider-service.ts`）。
 */
export async function describeProviders(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProvidersView> {
  const providers = await loadProviders(env);
  const { config } = providers;

  // ── 連線 ──
  const cli = config.connections.cli;
  const [cliProbe, ollamaModels, openaiModels] = await Promise.all([
    // 連線那一列問的是「CLI 在不在」，跟找來源現在走哪一條無關 —— 所以直接建 CLI 那一支來探。
    cli === null
      ? Promise.resolve<ProbeResult>({ kind: 'not-configured' })
      : createClaudeAgent({
          command: cli.command,
          args: cli.args,
          model: '',
          schema: {},
          systemPrompt: '',
          maxCostUsd: null,
        }).probe(),
    listOllamaModels(config.connections.ollama.baseUrl),
    config.connections.openai === null
      ? Promise.resolve<readonly string[] | null>(null)
      : listOpenAiModels(
          config.connections.openai.baseUrl,
          config.connections.openai.apiKeyEnv,
          env,
        ),
  ]);
  const modelsByKind: Record<ConnectionKind, readonly string[] | null> = {
    cli: null,
    ollama: ollamaModels,
    openai: openaiModels,
  };
  const connections: ConnectionStatus[] = [
    {
      kind: 'cli',
      configured: cli !== null,
      state: cliProbe.kind,
      detail: cliProbe.kind === 'unreachable' ? cliProbe.detail : '',
      version: cliProbe.kind === 'ready' ? cliProbe.version : null,
      auth: 'none',
      models: null,
    },
    {
      kind: 'ollama',
      configured: true,
      state: ollamaModels === null ? 'unreachable' : 'ready',
      detail: ollamaModels === null ? 'Ollama 沒有回應' : '',
      version: null,
      auth: authOf(config.connections.ollama.apiKeyEnv, env),
      models: ollamaModels,
    },
    {
      kind: 'openai',
      configured: config.connections.openai !== null,
      state:
        config.connections.openai === null
          ? 'not-configured'
          : openaiModels === null
            ? 'unreachable'
            : 'ready',
      detail: config.connections.openai !== null && openaiModels === null ? '列不出模型' : '',
      version: null,
      auth: authOf(config.connections.openai?.apiKeyEnv ?? null, env),
      models: openaiModels,
    },
  ];

  // ── 任務 ──
  // 同一條連線上的同一個模型只探一次（兩個任務用同一個模型是最常見的設定）。
  const probed = new Map<string, Promise<{ probe: ProbeResult; json: JsonModeReport }>>();
  const probeChat = (task: ModelTask): Promise<{ probe: ProbeResult; json: JsonModeReport }> => {
    // 規劃對話不是 `ChatTask`（它的服務有三種），但走本機 Ollama 的時候它確實是一次對話。
    const provider = task === 'plan' ? providers.planChat() : providers.chatFor(task as ChatTask);
    if (provider === null) {
      return Promise.resolve({
        probe: { kind: 'not-configured' },
        json: { mode: 'unchecked', checkedAt: null, detail: '', protocol: null },
      });
    }
    const key = `${config.tasks[task].via}::${config.tasks[task].model}`;
    let pending = probed.get(key);
    if (pending === undefined) {
      pending = (async () => ({
        probe: await provider.probe(),
        json: await provider.jsonMode(),
      }))();
      probed.set(key, pending);
    }
    return pending;
  };

  const tasks: TaskStatus[] = await Promise.all(
    MODEL_TASKS.map(async ({ task, role }): Promise<TaskStatus> => {
      const setting = config.tasks[task];
      const common = { task, role, via: setting.via, model: setting.model, browse: null };
      /**
       * 規劃對話自己一條路：**它的服務有三種，而畫面要說得出「這一條會不會上網查」**。
       * 走本機 Ollama 的時候談得成、只是不會查 —— 那是宣告的（`checkedAt` 是 `null`），
       * 跟 CLI 的搜尋一樣不是量出來的。
       */
      if (task === 'plan') {
        if (setting.via === 'ollama') {
          const { probe, json } = await probeChat('plan');
          return {
            ...common,
            ...fromProbe(probe),
            jsonMode: probe.kind === 'ready' ? json : null,
            browse:
              probe.kind === 'ready'
                ? { state: 'no', checkedAt: null, detail: '這個服務不會上網查' }
                : null,
          };
        }
        const planner = providers.planFor({ schema: {}, systemPrompt: '', maxCostUsd: null });
        if (planner === null) {
          return { ...common, ...fromProbe({ kind: 'not-configured' }), jsonMode: null };
        }
        const probe = setting.via === 'cli' ? cliProbe : await planner.probe();
        const browse: BrowseReport | null =
          probe.kind !== 'ready'
            ? null
            : setting.via === 'cli'
              ? { state: 'yes', checkedAt: null, detail: '' }
              : ((await planner.browseReport?.()) ?? null);
        return { ...common, ...fromProbe(probe), jsonMode: null, browse };
      }
      if (role === 'agent') {
        if (setting.via === 'openai') {
          // 走 OpenAI 相容 API 的找來源：模型在不在清單上，以及「會不會搜尋」量過了沒。
          const agent = providers.agentFor({ schema: {}, systemPrompt: '', maxCostUsd: null });
          if (agent === null) {
            return { ...common, ...fromProbe({ kind: 'not-configured' }), jsonMode: null };
          }
          const probe = await agent.probe();
          const browse = probe.kind === 'ready' ? ((await agent.browseReport?.()) ?? null) : null;
          return { ...common, ...fromProbe(probe), jsonMode: null, browse };
        }
        // CLI 的搜尋是我們給它的參數，不是量的 —— `checkedAt` 是 null。
        const browse: BrowseReport | null =
          cliProbe.kind === 'ready' ? { state: 'yes', checkedAt: null, detail: '' } : null;
        return { ...common, ...fromProbe(cliProbe), jsonMode: null, browse };
      }
      if (role === 'embed') {
        return {
          ...common,
          ...fromProbe(embedProbe(setting.model, modelsByKind[setting.via])),
          jsonMode: null,
        };
      }
      const { probe, json } = await probeChat(task as ChatTask);
      return { ...common, ...fromProbe(probe), jsonMode: probe.kind === 'ready' ? json : null };
    }),
  );

  return { connections, tasks, config };
}

function fromProbe(probe: ProbeResult): {
  state: ProviderState;
  detail: string;
  version: string | null;
  capabilities: ProviderCapabilities;
} {
  if (probe.kind === 'ready') {
    return { state: 'ready', detail: '', version: probe.version, capabilities: probe.capabilities };
  }
  if (probe.kind === 'unreachable') {
    return {
      state: 'unreachable',
      detail: probe.detail,
      version: null,
      capabilities: NO_CAPABILITIES,
    };
  }
  return { state: 'not-configured', detail: '', version: null, capabilities: NO_CAPABILITIES };
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
