/**
 * 記一次模型呼叫（v0.22.0 的診斷開關；研究的規劃與蒐集用這一支）。
 *
 * **開關預設是關的**（`providers.json` 的 `diagnostics`）。放在用例層而不是 provider 裡，
 * provider 不知道自己正在做哪一個任務、哪一個專題，
 * 而**該記哪些任務是一個判斷**（`domain/provider/call-record.ts` 那張表）。
 *
 * 寫失敗不會讓作業失敗（`appendModelCall` 自己吞）。
 */
import { endpointOf, type ModelCallRecord } from '../domain/provider/call-record.js';
import { appendModelCall } from '../infrastructure/fs/model-log.js';
import type { Providers } from '../infrastructure/providers/registry.js';

export async function recordModelCall(
  providers: Providers,
  caseFolder: string,
  call: {
    readonly task: ModelCallRecord['task'];
    readonly role: ModelCallRecord['role'];
    readonly model: string;
    /** 紀錄寫進 `model-calls\<這個>.jsonl`：作業的 id，或規劃對話那一次研究的 id */
    readonly runId: string;
    readonly correlationId: string;
    readonly itemId?: string;
    readonly system: string;
    readonly user: string;
    readonly text: string | null;
    readonly errorDetail: string | null;
    readonly ok: boolean;
    readonly code: string | null;
    readonly elapsedMs: number;
    readonly costUsd: number | null;
  },
): Promise<void> {
  if (!providers.config.diagnostics.logModelCalls) return;
  const connection = providers.connectionOf(call.task);
  await appendModelCall(caseFolder, {
    at: new Date().toISOString(),
    runId: call.runId,
    correlationId: call.correlationId,
    task: call.task,
    role: call.role,
    model: call.model,
    // **逐任務**：每個任務各自走一條連線（v0.24.0），所以打到哪要問這個任務，不是問角色。
    transport: connection.via === 'cli' ? 'claude-cli' : connection.via,
    endpoint: endpointOf(connection.baseUrl),
    ...(call.itemId === undefined ? {} : { itemId: call.itemId }),
    request: { system: call.system, user: call.user },
    response: { text: call.text, errorDetail: call.errorDetail },
    outcome: {
      ok: call.ok,
      code: call.code,
      elapsedMs: call.elapsedMs,
      costUsd: call.costUsd,
    },
  });
}
