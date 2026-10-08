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

/** From a Fastify instance, create the application-specific callbacks. */
export function targetOf(app: {
  server: { closeAllConnections: () => void };
  close: () => Promise<void>;
}): ShutdownTarget {
  return {
    cancelAll,
    activeCount,
    destroyConnections: () => app.server.closeAllConnections(),
    close: () => app.close(),
  };
}
