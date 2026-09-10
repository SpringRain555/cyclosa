/**
 * 關閉序列。**這一份釘住的是一個 2026-09-10 實測到的、真的關不掉的缺陷。**
 *
 * ## 缺陷長什麼樣
 *
 * 舊的關閉是 `setTimeout(100) → app.close() → process.exit(0)`。
 * 而進度通道走 `reply.hijack()`，Fastify 的 `forceCloseConnections` 預設
 * 是 `'idle'` —— **收得掉閒置連線，收不掉進行中的請求**。
 * 於是「正在看一個執行中的作業」的時候按下結束，`.then` 永遠不跑，
 * 畫面卻已經顯示「Cyclosa 已經關掉了」。
 *
 * ## 為什麼底下有一條開真的 socket 的測試
 *
 * 這個缺陷**用 `app.inject` 測不出來** —— 它根本不開 socket。
 * 而 `force: true` 那條路在這之前一條測試都沒有，因為它會 `process.exit`。
 * 所以序列被抽成一個不碰 process 的函式，而它要用真的連線驗一次。
 */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  shutdownSequence,
  targetOf,
  type ShutdownClock,
  type ShutdownTarget,
} from '../../src/interface/http/shutdown.js';

const NO_WAIT = { flushMs: 0, graceMs: 300, closeMs: 300 };

/** 假時鐘：`sleep` 不真的等，只把時間往前推。**測試不該花 1.5 秒等一個上限。** */
function fakeClock(): ShutdownClock {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

interface Spy {
  readonly target: ShutdownTarget;
  readonly order: string[];
}

/**
 * **記錄呼叫順序的外殼包在覆寫的外面**，不是跟覆寫並列。
 *
 * 並列的話，任何一個覆寫都會把「記一筆」那段換掉 ——
 * 於是順序斷言看到的是一個少了一步的清單，而那個少不是真的。
 */
function spyTarget(overrides: Partial<ShutdownTarget> = {}): Spy {
  const order: string[] = [];
  const base: ShutdownTarget = {
    cancelAll: () => 0,
    activeCount: () => 0,
    destroyConnections: () => {},
    close: async () => {},
    ...overrides,
  };
  const target: ShutdownTarget = {
    cancelAll: () => {
      order.push('cancelAll');
      return base.cancelAll();
    },
    activeCount: () => base.activeCount(),
    destroyConnections: () => {
      order.push('destroyConnections');
      base.destroyConnections();
    },
    close: () => {
      order.push('close');
      return base.close();
    },
  };
  return { target, order };
}

describe('關閉序列的順序與上限', () => {
  it('先叫作業停，再收連線，最後才 close', async () => {
    const spy = spyTarget();
    await shutdownSequence(spy.target, NO_WAIT, fakeClock());
    expect(spy.order).toEqual(['cancelAll', 'destroyConnections', 'close']);
  });

  it('作業收尾了就不再等 —— 回報 settled', async () => {
    let remaining = 2;
    const spy = spyTarget({
      cancelAll: () => 2,
      // 第一次問還有 2 個，之後就收好了
      activeCount: () => {
        const now = remaining;
        remaining = 0;
        return now;
      },
    });
    const outcome = await shutdownSequence(spy.target, NO_WAIT, fakeClock());
    expect(outcome.cancelled).toBe(2);
    expect(outcome.settled).toBe(true);
  });

  it('作業一直不收尾也照樣往下走 —— 那些由下一次啟動的孤兒掃描接住', async () => {
    const spy = spyTarget({ cancelAll: () => 1, activeCount: () => 1 });
    const outcome = await shutdownSequence(spy.target, NO_WAIT, fakeClock());
    expect(outcome.settled).toBe(false);
    // **等不到不是理由。** 連線還是要收、close 還是要叫。
    expect(spy.order).toEqual(['cancelAll', 'destroyConnections', 'close']);
  });

  it('`close()` 永遠不 resolve 的時候，序列自己會回來', async () => {
    // 這是整個檔案最重要的一條：**舊的寫法在這裡會永遠停住**，
    // 而 `process.exit(0)` 掛在它的 `.then` 上。
    const spy = spyTarget({ close: () => new Promise<void>(() => {}) });
    const outcome = await shutdownSequence(spy.target, NO_WAIT, fakeClock());
    expect(outcome.closed).toBe(false);
  });

  it('`close()` 丟例外不會變成沒有人接的 rejection', async () => {
    const spy = spyTarget({ close: () => Promise.reject(new Error('壞掉了')) });
    const outcome = await shutdownSequence(spy.target, NO_WAIT, fakeClock());
    expect(outcome.closed).toBe(false);
  });
});

describe('真的開一條 SSE 連線', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close().catch(() => {});
  });

  it('有一條 hijack 出去的連線開著時，序列仍然在期限內完成', async () => {
    app = Fastify({ logger: false });
    // 跟 `routes.ts` 的進度通道同一個形狀：hijack、寫一筆、**不結束**。
    app.get('/events', (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      reply.raw.write('data: {}\n\n');
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;

    await new Promise<void>((resolve) => {
      get(`http://127.0.0.1:${port}/events`, (res) => {
        res.on('data', () => {});
        resolve();
      });
    });

    const outcome = await shutdownSequence(targetOf(app), {
      flushMs: 0,
      graceMs: 0,
      closeMs: 3_000,
    });

    // **關鍵斷言。** 沒有 `destroyConnections()` 的話這裡會是 false ——
    // 那正是實測到的行為（3000 ms 之後 `close()` 還沒 resolve）。
    expect(outcome.closed).toBe(true);
  });
});
