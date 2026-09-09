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
  missingFor,
  TASK_ANGLES,
  TASK_EXTRACT,
  TASK_FIND_SOURCES,
  type ProviderRole,
} from '../domain/provider/index.js';
import {
  describeProviders,
  loadProviders,
  type ProvidersView,
} from '../infrastructure/providers/registry.js';
import {
  apiKeyEnvOf,
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
}

export async function listProviders(): Promise<Result<ProvidersPayload>> {
  const cid = correlationId();
  const view = await describeProviders();
  const readiness = view.statuses.map((status) => {
    if (status.role === 'embed') {
      /**
       * **`ok` 的意思是「模型選好了，而且它真的在 Ollama 上」** ——
       * 不是「語意檢索可以用了」。那一半還沒接（Stage 12 後半）。
       *
       * 2026-09-09 之前這裡永遠回 `false`，因為模型還沒選。現在選好了
       * （`qwen3-embedding:4b`，量測見 `docs/research/embedding-choice.md`），
       * 所以這一格改成反映設定的實際狀態 —— 但**畫面上要講清楚它還沒接上**，
       * 否則一個綠勾會被讀成「搜尋已經有語意了」。
       */
      return {
        role: status.role,
        ok: status.state === 'ready',
        missing: [] as readonly string[],
      };
    }
    /**
     * **`chat` 要對兩個任務都過。**
     *
     * 2026-09-09 之前這裡只看 `TASK_ANGLES`，於是設定頁上顯示的「可以用」
     * 只代表「歸納角度跑得動」—— 而 `chat` 底下還有一個抽取實體與關係，
     * 它要吃 12,000 字的外部正文，context 需求高得多（`TASK_EXTRACT`）。
     * 一個剛好 8000 context 的模型會在這一頁被標成綠的，然後在抽取時
     * **把正文截掉一半而不報錯**。
     */
    const tasks = status.role === 'agent' ? [TASK_FIND_SOURCES] : [TASK_ANGLES, TASK_EXTRACT];
    const matches = tasks.map((task) => missingFor(task, status.capabilities));
    const missing = [
      ...new Set(
        matches.flatMap((m) => {
          if (m.kind === 'ok') return [];
          // context 不夠也是一種「缺」，而它原本完全不會出現在這個清單裡 ——
          // 於是畫面上會顯示「缺少：（空白）」。
          return m.context === null
            ? [...m.flags]
            : [...m.flags, `context ${m.context[1]} < ${m.context[0]}`];
        }),
      ),
    ];
    return {
      role: status.role,
      ok: status.state === 'ready' && missing.length === 0,
      missing,
    };
  });
  return ok({ ...view, readiness }, cid);
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

  if (role === 'embed') return err('PROVIDER_NOT_CONFIGURED', cid, { role });

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
