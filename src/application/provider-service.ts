/**
 * provider 的讀取、設定與「儲存並測試」。
 *
 * ## 「檢查」與「測試」是兩件事，而且分開得很刻意
 *
 * 打開設定頁**不該產生費用**。所以 `listProviders` 對 CLI 只跑 `--version`
 * （確認它在不在），對 HTTP 連線只列模型清單（本機、免費；線上端點的 `/models` 不計費）。
 * 設定頁每一塊「模型服務」的「儲存並檢查」走的也是這兩件事。
 *
 * 「儲存並測試」（`testProvider`，逐任務）是使用者按的按鈕，而它對 CLI **是真的會花錢的** ——
 * 2026-09-06 量到一次只回兩個 token 的呼叫花了 0.18 美元
 * （幾乎全部來自 cache creation）。所以畫面上那個按鈕底下要先講這件事。
 *
 * ## v2：逐任務（ADR-0032）
 *
 * 每個任務各自走一條連線，所以測試也是逐任務的：測的是**那個任務實際會跑的
 * 那一支**，不是某個角色的預設。`listModelsFor` 則**不存檔就列** ——
 * 使用者填了位址與金鑰變數之後要先看得到「這個端點有哪些模型」，才選得了模型；
 * 存了才列的話，畫面上會先出現一個空的下拉選單（v0.24.1 起設定頁改了就存，按之前會先存）。
 *
 * ## v0.24.2：找來源走 OpenAI 相容 API 的時候，測的是「會不會上網搜尋」（ADR-0034）
 */
import { mkdir } from 'node:fs/promises';

import {
  missingFor,
  requirementOfTask,
  MODEL_TASKS,
  type ChatTask,
  type MatchResult,
  type ModelTask,
} from '../domain/provider/index.js';
import {
  authOf,
  describeProviders,
  loadProviders,
  type AuthState,
  type ProvidersView,
  type TaskStatus,
} from '../infrastructure/providers/registry.js';
import { listOllamaModels } from '../infrastructure/providers/chat-ollama.js';
import { listOpenAiModels } from '../infrastructure/providers/chat-openai.js';
import type { BrowseReport, JsonModeReport } from '../infrastructure/providers/types.js';
import {
  apiKeyEnvOf,
  parseConfig,
  writeProvidersConfig,
  type ConnectionKind,
} from '../infrastructure/providers/config.js';
import { tmpDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';

/**
 * 一個任務現在跑不跑得動，以及**缺哪幾樣**。
 *
 * ADR-0006 第 3 條要求畫面說出「這個任務需要 X，目前設定的模型沒有 X」——
 * 那句話要有地方拿到 X，而這裡就是那個地方。
 * **設定頁上先看得到，比按下擴展才撞到牆好。**
 */
export interface TaskReadiness extends TaskStatus {
  readonly ok: boolean;
  readonly missing: readonly string[];
}

export interface ProvidersPayload extends Omit<ProvidersView, 'tasks'> {
  readonly tasks: readonly TaskReadiness[];
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
   * 逐任務各自接連線之後，沒有任何「角色層」可以代表它們 ——
   * 一個覆寫成小 context 模型的抽取，只有對著那個模型算才會顯示「缺 context」。
   *
   * **沒設定的時候不列「缺哪幾樣」。** 一個完全沒設定的任務，能力宣告當然是全空的，
   * 所以配對一定回「缺 X」—— 而畫面上那句話是「這個任務需要 X，**而目前設定的模型沒有**」。
   * 那句話對一個沒有模型的任務是錯的：問題不是模型不夠好，是還沒選。
   */
  const tasks: TaskReadiness[] = view.tasks.map((row) => {
    const missing =
      row.state === 'not-configured'
        ? []
        : missingNames([missingFor(requirementOfTask(row.task), row.capabilities)]);
    return { ...row, ok: row.state === 'ready' && missing.length === 0, missing };
  });
  return ok({ connections: view.connections, config: view.config, tasks }, cid);
}

/**
 * 存設定。**收 v1 或 v2 的形狀都行** —— 讀檔與收請求走同一支解析（`parseConfig`），
 * 舊的呼叫端送 v1 會被原地升版，存進去的永遠是 v2。
 *
 * 金鑰欄位存的是環境變數的名字，不是金鑰。形狀不對的一律當成沒設定，
 * 所以一把不小心貼進來的金鑰不會被寫進設定檔（`apiKeyEnvOf`）。
 */
export async function saveProviders(input: unknown): Promise<Result<ProvidersPayload>> {
  const cid = correlationId();
  const config = parseConfig(input);
  try {
    await writeProvidersConfig(config);
  } catch (e) {
    return err('IO_UNEXPECTED', cid, { reason: String((e as Error).message) });
  }
  return await listProviders();
}

export interface ModelsListing {
  readonly kind: ConnectionKind;
  /** `null` ＝ 列不出來（連不上、被拒）。 */
  readonly models: readonly string[] | null;
  readonly auth: AuthState;
}

/**
 * 「儲存並檢查」列模型那一步：**這一支不存檔，只列。**
 *
 * 使用者填了位址（與金鑰變數）之後按這顆，畫面就能把這個端點的模型列成下拉選單 ——
 * 這是 Open WebUI 也用的順序：填位址與金鑰 → 打 `/models` 驗證 → 才選模型。
 * 存了才列的話，畫面上會先出現一個空的下拉選單，而使用者不知道要先按儲存。
 *
 * 只有 HTTP 的兩種連線有這件事；CLI 不吐模型清單。
 */
export async function listModelsFor(kind: string, input: unknown): Promise<Result<ModelsListing>> {
  const cid = correlationId();
  if (kind !== 'ollama' && kind !== 'openai') {
    return err('PROVIDER_NOT_CONFIGURED', cid, { field: 'kind', reason: 'ollama 或 openai' });
  }
  const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const baseUrl = String(raw['baseUrl'] ?? '').trim();
  if (baseUrl.length === 0) return err('PROVIDER_NOT_CONFIGURED', cid, { field: 'baseUrl' });
  const apiKeyEnv = apiKeyEnvOf(raw['apiKeyEnv']);
  const models =
    kind === 'openai'
      ? await listOpenAiModels(baseUrl, apiKeyEnv, process.env)
      : await listOllamaModels(baseUrl);
  return ok({ kind, models, auth: authOf(apiKeyEnv, process.env) }, cid);
}

export interface ProviderTest {
  readonly task: ModelTask;
  readonly ok: boolean;
  readonly code: string | null;
  /** provider 回報的實際花費。**`null` ＝ 它沒回報，不是 0** */
  readonly costUsd: number | null;
  readonly elapsedMs: number;
  /**
   * 對話任務的「符合 schema」由誰保證。線上端點按這顆按鈕**會重量一次**，
   * 所以這一格是剛量出來的結果；其餘任務是 `null`。
   */
  readonly jsonMode: JsonModeReport | null;
  /**
   * 找來源走 OpenAI 相容 API 的時候，這顆按鈕量的是「會不會上網搜尋」（一個帶搜尋的小請求），
   * 這一格是剛量出來的結果；其餘任務是 `null`（v0.24.2，ADR-0034）。
   */
  readonly browse: BrowseReport | null;
}

/**
 * 真的打一次（「儲存並測試」逐任務叫它）。**這是使用者按的按鈕，不是頁面載入時跑的東西。**
 *
 * 測的是**這個任務實際會跑的那一支** —— 逐任務各自接連線之後，
 * 「測 chat」這句話沒有對象。CLI 那一邊會真的花錢，所以問的是**最小的一個問題**，
 * 而且要求它回一個空的候選清單 —— 不搜尋、不上網。
 */
export async function testProvider(
  dataRoot: string | null,
  task: string,
): Promise<Result<ProviderTest>> {
  const cid = correlationId();
  const entry = MODEL_TASKS.find((t) => t.task === task);
  if (entry === undefined) {
    return err('PROVIDER_NOT_CONFIGURED', cid, {
      field: 'task',
      reason: MODEL_TASKS.map((t) => t.task).join(', '),
    });
  }
  const providers = await loadProviders();

  /**
   * **嵌入也打得動了（v0.11.0）。** 模型在不在清單上是設定頁載入時就看得到的事，
   * 而「它真的吐得出向量嗎」不是 —— 一個拉了一半的模型、一個記憶體不夠載入的模型，
   * 兩者都在清單上。它走的是**查詢那一側**（帶前綴），因為那是使用者實際會觸發的路徑。
   */
  if (entry.role === 'embed') {
    if (providers.embed === null) return err('PROVIDER_NOT_CONFIGURED', cid, { task });
    const call = await providers.embed.embedQuery('測試');
    return ok(
      {
        task: entry.task,
        ok: call.kind === 'ok',
        code: call.kind === 'ok' ? null : call.code,
        costUsd: call.cost.costUsd,
        elapsedMs: call.cost.elapsedMs,
        jsonMode: null,
        browse: null,
      },
      cid,
    );
  }

  if (entry.role === 'chat') {
    const chat = providers.chatFor(entry.task as ChatTask);
    if (chat === null) return err('PROVIDER_NOT_CONFIGURED', cid, { task });

    /**
     * **線上端點：先重量一次格式支援。** 這顆按鈕因此同時是「重新檢查」——
     * 量測結果帶著時間存下來，而「多久算舊」沒有誠實的數字，
     * 所以讓人自己決定什麼時候再量（`json-checks.ts` 檔頭）。
     *
     * 量不出來（被拒、限流、連不上）就停在那裡回報，不接著打測試 ——
     * 同一個原因會讓測試那一次也失敗，而先失敗的那一個訊息比較準。
     */
    let measured: JsonModeReport | null = null;
    let measureMs = 0;
    if (chat.checkJson !== undefined) {
      const check = await chat.checkJson();
      measureMs = check.cost.elapsedMs;
      if (check.kind === 'error') {
        return ok(
          {
            task: entry.task,
            ok: false,
            code: check.code,
            costUsd: check.cost.costUsd,
            elapsedMs: measureMs,
            jsonMode: null,
            browse: null,
          },
          cid,
        );
      }
      measured = check.value;
    }

    const call = await chat.json({
      system: '只回 JSON。',
      user: '回一個 ok 欄位是 true 的物件。',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    });
    return ok(
      {
        task: entry.task,
        ok: call.kind === 'ok',
        code: call.kind === 'ok' ? null : call.code,
        costUsd: call.cost.costUsd,
        elapsedMs: measureMs + call.cost.elapsedMs,
        jsonMode: measured ?? (await chat.jsonMode()),
        browse: null,
      },
      cid,
    );
  }

  const request = {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    systemPrompt: '只回 JSON，不要用任何工具。',
    maxCostUsd: null,
  };
  /**
   * **規劃對話走的是它自己那一條服務**（ADR-0033 D5：三個服務都可以），
   * 而 `agentFor` 問的是找來源那一條。用錯的話這顆按鈕會測另一個任務的設定，
   * 而畫面上那一列會寫著「可以用」—— 那是最糟的一種錯：它說的是另一件事的結果。
   */
  const agent = entry.task === 'plan' ? providers.planFor(request) : providers.agentFor(request);
  if (agent === null) return err('PROVIDER_NOT_CONFIGURED', cid, { task });

  /**
   * 走 OpenAI 相容 API 的找來源：測的就是「會不會上網搜尋」—— 量一次、記下來（ADR-0034）。
   * 這一支的 `run()` 一律要求搜尋，拿它回一個 `{"ok":true}` 沒有意義，而且會多搜一次。
   *
   * **規劃對話不量搜尋**：它是「有就用」，沒有也談得成 —— 為它量一次等於多付一次錢
   * 去確認一件不影響這個任務跑不跑得動的事。
   */
  if (entry.task !== 'plan' && agent.checkBrowse !== undefined) {
    const check = await agent.checkBrowse();
    if (check.kind === 'error') {
      return ok(
        {
          task: entry.task,
          ok: false,
          code: check.code,
          costUsd: check.cost.costUsd,
          elapsedMs: check.cost.elapsedMs,
          jsonMode: null,
          browse: null,
        },
        cid,
      );
    }
    return ok(
      {
        task: entry.task,
        ok: check.value.state === 'yes',
        code: check.value.state === 'yes' ? null : 'PROVIDER_CAPABILITY_MISSING',
        costUsd: check.cost.costUsd,
        elapsedMs: check.cost.elapsedMs,
        jsonMode: null,
        browse: check.value,
      },
      cid,
    );
  }
  if (dataRoot === null) return err('IO_DATA_ROOT_MISSING', cid, { task });

  // **測試也要在一個目錄裡跑**，而那個目錄不是任何專題的沙箱 ——
  // 它跟哪一個專題都沒有關係，所以放資料根的 `tmp\`。
  const cwd = tmpDir(dataRoot);
  await mkdir(cwd, { recursive: true });
  const call = await agent.run({ prompt: '回 {"ok":true}', cwd, timeoutMs: 120_000 });
  return ok(
    {
      task: entry.task,
      ok: call.kind === 'ok',
      code: call.kind === 'ok' ? null : call.code,
      costUsd: call.cost.costUsd,
      elapsedMs: call.cost.elapsedMs,
      jsonMode: null,
      browse: null,
    },
    cid,
  );
}
