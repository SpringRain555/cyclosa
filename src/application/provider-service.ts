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
  TASK_FIND_SOURCES,
  type ProviderRole,
} from '../domain/provider/index.js';
import {
  describeProviders,
  loadProviders,
  type ProvidersView,
} from '../infrastructure/providers/registry.js';
import { writeProvidersConfig, type ProvidersConfig } from '../infrastructure/providers/config.js';
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
      // Stage 12。**列出來但誠實說它還沒有** —— 少列一個角色，
      // 使用者會以為這個工具只有兩種模型。
      return { role: status.role, ok: false, missing: [] as readonly string[] };
    }
    const task = status.role === 'agent' ? TASK_FIND_SOURCES : TASK_ANGLES;
    const match = missingFor(task, status.capabilities);
    return {
      role: status.role,
      ok: status.state === 'ready' && match.kind === 'ok',
      missing: match.kind === 'missing' ? match.flags : [],
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
