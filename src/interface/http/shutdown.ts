/** App-specific Fastify adapter around the shared bounded shutdown sequence. */
import { shutdownSequence as runShutdownSequence } from '@local-app/lifecycle/shutdown';
import type { ShutdownBudget, ShutdownClock } from '@local-app/lifecycle/shutdown';
import { activeCount, cancelAll } from '../../application/run-registry.js';

export type { ShutdownBudget, ShutdownClock };

export interface ShutdownTarget {
  readonly cancelAll: () => number;
  readonly activeCount: () => number;
  readonly destroyConnections: () => void;
  readonly close: () => Promise<void>;
}

export interface ShutdownOutcome {
  readonly cancelled: number;
  readonly settled: boolean;
  readonly closed: boolean;
}

export const DEFAULT_BUDGET: ShutdownBudget = { flushMs: 100, graceMs: 1_500, closeMs: 2_000 };

export const systemClock: ShutdownClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
  now: () => Date.now(),
};

export function shutdownSequence(
  target: ShutdownTarget,
  budget: ShutdownBudget = DEFAULT_BUDGET,
  clock: ShutdownClock = systemClock,
): Promise<ShutdownOutcome> {
  return runShutdownSequence(target, budget, clock).then(({ cancelled, settled, closed }) => ({
    cancelled: cancelled ?? 0,
    settled,
    closed,
  }));
}

/**
 * From a Fastify instance, create the application-specific callbacks.
 *
 * `release` 在收掉伺服器之前跑：卸載本機模型（2026-10-28 試用回饋 13 —— 結束 Cyclosa 之後模型還佔著記憶體）。
 * **它失敗不擋關閉**，而且由呼叫端傳進來：測試不該因為一個關閉序列去碰真的 Ollama。
 */
export function targetOf(
  app: {
    server: { closeAllConnections: () => void };
    close: () => Promise<void>;
  },
  release?: () => Promise<void>,
): ShutdownTarget {
  return {
    cancelAll,
    activeCount,
    destroyConnections: () => app.server.closeAllConnections(),
    close: async () => {
      if (release !== undefined) await release().catch(() => undefined);
      await app.close();
    },
  };
}
