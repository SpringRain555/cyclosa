/**
 * provider 的讀取、設定與「實際打一次」。
 *
 * ## 「列出來」與「實際打一次」是兩件事，而且分開得很刻意
 *
 * 打開設定頁**不該產生費用**。所以 `listProviders` 對 agent 只跑 `--version`
 * （確認 CLI 在不在），對 chat 只讀 `/api/tags`（本機、免費）。
 *
 * 「實際打一次」是使用者按的按鈕，而它對 agent **是真的會花錢的** ——
 * 2026-09-06 量到一次只回兩個 token 的呼叫花了 0.18 美元
 * （幾乎全部來自 cache creation）。所以畫面上那個按鈕要先講這件事。
 */
import { mkdir } from 'node:fs/promises';

import {
  CHAT_TASK_REQUIREMENTS,
  missingFor,
  TASK_FIND_SOURCES,
  type ChatTask,
  type MatchResult,
  type ProviderRole,
} from '../domain/provider/index.js';
import {
  describeProviders,
  loadProviders,
  type ProvidersView,
} from '../infrastructure/providers/registry.js';
import {
  apiKeyEnvOf,
  taskModelsOf,
  writeProvidersConfig,
  type ProvidersConfig,
} from '../infrastructure/providers/config.js';
import { tmpDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';

export interface ProvidersPayload extends ProvidersView {
  /**
   * 每個角色現在跑不跑得動它要跑的任務，以及**缺哪幾樣**。
   *
   * ADR-0006 第 3 條要求畫面說出「這個任務需要 X，目前設定的 provider 沒有 X」——
   * 那句話要有地方拿到 X，而這裡就是那個地方。
   * **設定頁上先看得到，比按下擴展才撞到牆好。**
   */
  readonly readiness: readonly {
    readonly role: ProviderRole;
    readonly ok: boolean;
    readonly missing: readonly string[];
  }[];
  /**
   * **`chat` 底下逐任務的同一件事。**
   *
   * 角色層那一格算的是「兩個任務都過得了嗎」，而使用者要修的時候需要知道
   * **是哪一個任務、跑在哪個模型上、缺什麼**。合成一格的話，
   * 一個覆寫成小 context 模型的抽取，會顯示成「chat 缺 context」——
   * 而設定頁上那個模型欄位裡寫的是預設模型的名字，看起來完全沒問題。
   */
  readonly chatReadiness: readonly {
    readonly task: ChatTask;
    readonly model: string;
    readonly overridden: boolean;
    readonly ok: boolean;
    readonly missing: readonly string[];
  }[];
}

/** 配對結果攤成畫面上那一行字要的東西。**context 不夠也是一種「缺」。** */
function missingNames(matches: readonly MatchResult[]): readonly string[] {
  return [
    ...new Set(
      matches.flatMap((m) => {
        if (m.kind === 'ok') return [];
        // context 不夠原本完全不會出現在這個清單裡 —— 於是畫面上顯示「缺少：（空白）」。
        return m.context === null
          ? [...m.flags]
          : [...m.flags, `context ${m.context[1]} < ${m.context[0]}`];
      }),
    ),
  ];
}

export async function listProviders(): Promise<Result<ProvidersPayload>> {
  const cid = correlationId();
  const view = await describeProviders();

  /**
   * **每個任務對著它自己那個模型算一次。**
   *
   * 2026-09-10 之前 `chat` 只有一個模型，所以角色層算一次就夠了。
   * 逐任務覆寫之後那個假設不成立 —— 而它失效的方式是**看起來沒事**：
   * 角色層那一格顯示的是預設模型，覆寫的那一個從來不會被檢查。
   */
  const chatReadiness = view.chatTasks.map((row) => {
    const missing = missingNames([missingFor(CHAT_TASK_REQUIREMENTS[row.task], row.capabilities)]);
    return {
      task: row.task,
      model: row.model,
      overridden: row.overridden,
      ok: row.state === 'ready' && missing.length === 0,
      missing,
    };
  });

  const readiness = view.statuses.map((status) => {
    if (status.role === 'embed') {
      /**
       * **`ok` 的意思是「模型選好了，而且它真的在 Ollama 上」。**
       *
       * v0.11.0 之後語意檢索真的會用到它，所以這一格終於等於
       * 「語意查得動」—— **但只等於一半**：向量是**逐專題**的，
       * 一個沒有按過「建立語意索引」的專題，這裡是綠的而搜尋仍然找不到東西。
       * 那個數字在搜尋面板上（它是逐專題的，這一頁不是）。
       *
       * 2026-09-09 之前這裡永遠回 `false`，因為模型還沒選。現在選好了
       * （`qwen3-embedding:4b`，量測見 `docs/research/embedding-choice.md`），
       * 所以這一格反映的是設定的實際狀態，而**畫面上要講清楚它只是一半** ——
       * 否則一個綠勾會被讀成「這個專題的搜尋已經有語意了」。
       */
      return {
        role: status.role,
        ok: status.state === 'ready',
        missing: [] as readonly string[],
      };
    }
    /**
     * **`chat` 要對兩個任務都過，而且是對各自的模型。**
     *
     * 2026-09-09 之前這裡只看 `TASK_ANGLES`，於是設定頁上顯示的「可以用」
     * 只代表「歸納角度跑得動」—— 而 `chat` 底下還有一個抽取實體與關係，
     * 它要吃 12,000 字的外部正文，context 需求高得多（`TASK_EXTRACT`）。
     * 一個剛好 8000 context 的模型會在這一頁被標成綠的，然後在抽取時
     * **把正文截掉一半而不報錯**。
     *
     * 2026-09-10 逐任務覆寫之後，這一格改成**上面那一輪的合併結果** ——
     * 它不能再自己拿 `status.capabilities` 算，因為那是預設模型的能力。
     */
    if (status.role === 'chat') {
      return {
        role: status.role,
        ok: chatReadiness.every((row) => row.ok),
        missing: [...new Set(chatReadiness.flatMap((row) => row.missing))],
      };
    }
    const missing = missingNames([missingFor(TASK_FIND_SOURCES, status.capabilities)]);
    return {
      role: status.role,
      ok: status.state === 'ready' && missing.length === 0,
      missing,
    };
  });
  return ok({ ...view, readiness, chatReadiness }, cid);
}

export async function saveProviders(input: unknown): Promise<Result<ProvidersPayload>> {
  const cid = correlationId();
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};

  const chatRaw = raw['chat'];
  const agentRaw = raw['agent'];
  const chat =
    typeof chatRaw === 'object' && chatRaw !== null
      ? {
          baseUrl: String((chatRaw as Record<string, unknown>)['baseUrl'] ?? '').trim(),
          model: String((chatRaw as Record<string, unknown>)['model'] ?? '').trim(),
          // **存的是環境變數的名字，不是金鑰。** 形狀不對的一律當成沒設定，
          // 所以一把不小心貼進來的金鑰不會被寫進設定檔。
          apiKeyEnv: apiKeyEnvOf((chatRaw as Record<string, unknown>)['apiKeyEnv']),
          // 逐任務覆寫。**不認得的鍵在這裡就被丟掉**，不會被寫進設定檔 ——
          // 一個拼錯的任務名留在檔案裡，下次讀出來還是沒有作用，
          // 而它看起來像是設過了。
          taskModels: taskModelsOf((chatRaw as Record<string, unknown>)['taskModels']),
        }
      : null;
  const agentCommand = String(
    (typeof agentRaw === 'object' && agentRaw !== null
      ? (agentRaw as Record<string, unknown>)['command']
      : '') ?? '',
  ).trim();
  const agentArgsRaw =
    typeof agentRaw === 'object' && agentRaw !== null
      ? (agentRaw as Record<string, unknown>)['args']
      : undefined;

  const embedRaw = raw['embed'];
  const embed =
    typeof embedRaw === 'object' && embedRaw !== null
      ? {
          baseUrl: String((embedRaw as Record<string, unknown>)['baseUrl'] ?? '').trim(),
          model: String((embedRaw as Record<string, unknown>)['model'] ?? '').trim(),
        }
      : null;

  const config: ProvidersConfig = {
    version: 1,
    chat: chat === null || chat.baseUrl.length === 0 ? null : chat,
    agent:
      agentCommand.length === 0
        ? null
        : {
            command: agentCommand,
            args: Array.isArray(agentArgsRaw) ? agentArgsRaw.map((a) => String(a)) : [],
          },
    embed: embed === null || embed.baseUrl.length === 0 ? null : embed,
  };

  try {
    await writeProvidersConfig(config);
  } catch (e) {
    return err('IO_UNEXPECTED', cid, { reason: String((e as Error).message) });
  }
  return await listProviders();
}

export interface ProviderTest {
  readonly role: ProviderRole;
  readonly ok: boolean;
  readonly code: string | null;
  /** provider 回報的實際花費。**`null` ＝ 它沒回報，不是 0** */
  readonly costUsd: number | null;
  readonly elapsedMs: number;
}

/**
 * 實際打一次。**這是使用者按的按鈕，不是頁面載入時跑的東西。**
 *
 * agent 那一邊會真的花錢，所以問的是**最小的一個問題**，
 * 而且要求它回一個空的候選清單 —— 不搜尋、不上網。
 */
export async function testProvider(
  dataRoot: string | null,
  role: ProviderRole,
): Promise<Result<ProviderTest>> {
  const cid = correlationId();
  const providers = await loadProviders();

  /**
   * **嵌入也打得動了（v0.11.0）。**
   *
   * 在那之前這裡無條件回「沒設定」，因為那個角色還沒有實作。
   * 現在它是三個角色裡**最該按這顆按鈕**的一個：模型在不在 `/api/tags` 上
   * 是設定頁載入時就看得到的事，而「它真的吐得出向量嗎」不是 ——
   * 一個拉了一半的模型、一個記憶體不夠載入的模型，兩者都在清單上。
   *
   * 它走的是**查詢那一側**（帶前綴），因為那是使用者實際會觸發的路徑。
   */
  if (role === 'embed') {
    if (providers.embed === null) return err('PROVIDER_NOT_CONFIGURED', cid, { role });
    const call = await providers.embed.embedQuery('測試');
    return ok(
      {
        role,
        ok: call.kind === 'ok',
        code: call.kind === 'ok' ? null : call.code,
        costUsd: call.cost.costUsd,
        elapsedMs: call.cost.elapsedMs,
      },
      cid,
    );
  }

  if (role === 'chat') {
    if (providers.chat === null) return err('PROVIDER_NOT_CONFIGURED', cid, { role });
    const call = await providers.chat.json({
      system: '只回 JSON。',
      user: '回一個 ok 欄位是 true 的物件。',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    });
    return ok(
      {
        role,
        ok: call.kind === 'ok',
        code: call.kind === 'ok' ? null : call.code,
        costUsd: call.cost.costUsd,
        elapsedMs: call.cost.elapsedMs,
      },
      cid,
    );
  }

  const agent = providers.agentFor({
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    systemPrompt: '只回 JSON，不要用任何工具。',
    maxCostUsd: null,
  });
  if (agent === null) return err('PROVIDER_NOT_CONFIGURED', cid, { role });
  if (dataRoot === null) return err('IO_DATA_ROOT_MISSING', cid, { role });

  // **測試也要在一個目錄裡跑**，而那個目錄不是任何專題的沙箱 ——
  // 它跟哪一個專題都沒有關係，所以放資料根的 `tmp\`。
  const cwd = tmpDir(dataRoot);
  await mkdir(cwd, { recursive: true });
  const call = await agent.run({ prompt: '回 {"ok":true}', cwd, timeoutMs: 120_000 });
  return ok(
    {
      role,
      ok: call.kind === 'ok',
      code: call.kind === 'ok' ? null : call.code,
      costUsd: call.cost.costUsd,
      elapsedMs: call.cost.elapsedMs,
    },
    cid,
  );
}
