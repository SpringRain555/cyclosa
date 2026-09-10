/**
 * 關閉序列。
 *
 * ## 為什麼這是一個獨立的、可測的函式
 *
 * 2026-09-10 實測發現：**畫面上那顆「結束 Cyclosa」在你正看著一個執行中的
 * 作業時按下去，程式不會結束。**
 *
 * 進度通道走 `reply.hijack()`，連線在作業結束前一直開著。而 Fastify 的
 * `forceCloseConnections` 預設是 `'idle'` —— 它收得掉閒置連線，
 * **收不掉進行中的請求**。用本專案自己的 fastify 量的兩個對照：
 *
 * | 情形 | `app.close()` |
 * |---|---|
 * | 閒置的 keep-alive 連線 | 1 ms resolve |
 * | 開著的 hijack SSE | 3000 ms 還沒 resolve |
 *
 * 於是 `app.close().then(() => process.exit(0))` 的 `then` 永遠不跑，
 * 而畫面已經顯示「Cyclosa 已經關掉了」。**一個關不掉的結束鍵比沒有結束鍵糟。**
 *
 * 測試抓不到是有原因的：`app.inject` 不開真的 socket，而 `force: true`
 * 那條路一條測試都沒有 —— 它會 `process.exit`。所以序列本身要能離開
 * process 單獨測，那就是這個檔案存在的理由。
 *
 * ## 四步，順序是有理由的
 *
 * 1. **先叫作業停** —— 它們要跑到下一個項與項之間才看得到，所以越早越好
 * 2. **等回應送出去**（`flushMs`）—— 直接關掉 socket 的話，畫面看到的是
 *    連線中斷，而不是一句「已經關掉了」
 * 3. **有上限地等作業收尾**（`graceMs`）—— 等不到的由下一次啟動的孤兒掃描接住
 * 4. **收掉連線再 close**，而且 close 也有上限（`closeMs`）——
 *    **逾時就直接離開**。關不掉的時候，一個沒有反應的程式比一個粗魯結束的程式糟
 */
import { activeCount, cancelAll } from '../../application/run-registry.js';

export interface ShutdownTarget {
  /** 叫所有還在跑的作業停下來，回「叫停了幾個」。 */
  readonly cancelAll: () => number;
  /** 現在還有幾個沒停好。 */
  readonly activeCount: () => number;
  /** 把還開著的連線收掉 —— **含進行中的請求**，那正是預設收不掉的那些。 */
  readonly destroyConnections: () => void;
  readonly close: () => Promise<void>;
}

export interface ShutdownClock {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface ShutdownBudget {
  /** 留給回應送出去的時間。訊號觸發的關閉沒有回應要送，給 0。 */
  readonly flushMs: number;
  /** 等作業自己收尾的上限。 */
  readonly graceMs: number;
  /** 等 `close()` 的上限。**逾時就離開。** */
  readonly closeMs: number;
}

export interface ShutdownOutcome {
  /** 叫停了幾個作業。 */
  readonly cancelled: number;
  /** 它們有沒有在 `graceMs` 之內收尾好。**沒有不是錯誤** —— 孤兒掃描會接住。 */
  readonly settled: boolean;
  /** `close()` 有沒有在 `closeMs` 之內完成。 */
  readonly closed: boolean;
}

export const DEFAULT_BUDGET: ShutdownBudget = { flushMs: 100, graceMs: 1_500, closeMs: 2_000 };

const POLL_MS = 50;

export const systemClock: ShutdownClock = {
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref();
    }),
  now: () => Date.now(),
};

export async function shutdownSequence(
  target: ShutdownTarget,
  budget: ShutdownBudget = DEFAULT_BUDGET,
  clock: ShutdownClock = systemClock,
): Promise<ShutdownOutcome> {
  const cancelled = target.cancelAll();

  if (budget.flushMs > 0) await clock.sleep(budget.flushMs);

  let settled = target.activeCount() === 0;
  if (!settled) {
    const deadline = clock.now() + budget.graceMs;
    while (clock.now() < deadline) {
      await clock.sleep(POLL_MS);
      if (target.activeCount() === 0) {
        settled = true;
        break;
      }
    }
  }

  target.destroyConnections();

  let closed = false;
  await Promise.race([
    target.close().then(
      () => {
        closed = true;
      },
      // close 自己失敗不該讓我們卡在這裡 —— 結果一樣是「該走了」。
      () => {
        closed = false;
      },
    ),
    clock.sleep(budget.closeMs),
  ]);

  return { cancelled, settled, closed };
}

/** 從一個 Fastify 實例做出 `ShutdownTarget`。**這一層才認得 Fastify。** */
export function targetOf(app: {
  server: { closeAllConnections: () => void };
  close: () => Promise<void>;
}): ShutdownTarget {
  return {
    cancelAll,
    activeCount,
    destroyConnections: () => {
      app.server.closeAllConnections();
    },
    close: () => app.close(),
  };
}
