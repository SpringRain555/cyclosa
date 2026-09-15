/**
 * 執行中的作業。**匯入與擴展共用這一份。**
 *
 * ## 為什麼要抽出來
 *
 * v0.2.0 的時候只有匯入，所以這張表就放在 `ingest-service.ts` 裡。
 * v0.5.0 加了擴展，而它要走**同一個**取消端點
 * （`POST …/runs/:runId/cancel`，api-contract 上只有這一支）。
 *
 * 兩份各自維護一張表的話，取消端點就得問兩次、而且要記得問第二次 ——
 * **那是一個「加第三種 run 的時候會被漏掉」的形狀。**
 *
 * ## 為什麼放記憶體裡
 *
 * 它本來就不該持久化：程式結束時執行中的作業就是結束了，
 * 而**已經寫進資料庫的東西留著** —— 那正是「取消時已寫入的保留」的同一條原則。
 * 單一實例、單一使用者（ADR-0020），所以一個 Map 就夠。
 */
import type { RunEndedReason } from '../domain/ingest/state.js';
import { RunChannel, type RunEvent } from './run-events.js';

export interface Cancellable {
  /** 停止送出新請求。匯入是停爬蟲，擴展是 abort 子程序與 HTTP */
  stop(): void;
}

export interface ActiveRun {
  readonly runId: string;
  readonly channel: RunChannel;
  /**
   * **刻意可寫。** 註冊要在「開始」那一刻發生（否則使用者按取消時
   * 這個 run 還不在表上），而能停下來的那個東西
   * （爬蟲、子程序）要晚一步才建得出來。
   */
  cancellable: Cancellable | null;
  cancelled: boolean;
  /**
   * **誰按的取消。** `null` ＝ 使用者自己按的，那是絕大多數。
   *
   * 迴圈收尾時把它寫進 `run.ended_reason`，於是畫面分得出
   * 「你按了取消」與「關閉程式時一起停的」—— 兩者的 `status` 都是 `已取消`。
   */
  cancelReason: RunEndedReason | null;
  /**
   * 暫停中。
   *
   * ## 為什麼**不**寫進 `run.status`
   *
   * 「暫停」的意思是「等一下會接著跑」，而那個承諾**只有這個行程活著才成立** ——
   * 佇列在記憶體裡。把 `paused` 寫進資料庫的話，程式關掉再打開會看到
   * 一個標著「暫停中」、而且永遠不會恢復的作業。
   *
   * **一個做不到的承諾比沒有承諾糟。** 所以它只活在這張表上，
   * 跟 `live` 一樣是「執行時的事實」。
   */
  paused: boolean;
  /**
   * 迴圈在每一項之間呼叫它。**沒有暫停時它立刻返回**，
   * 暫停時它停在這裡直到被續跑或取消。
   */
  gate(): Promise<void>;
}

const active = new Map<string, ActiveRun>();

/** 每個 run 一組在等的人。**取消也要把它們放走**，否則暫停中的作業取消不掉。 */
const waiters = new Map<string, (() => void)[]>();

function release(runId: string): void {
  for (const wake of waiters.get(runId) ?? []) wake();
  waiters.set(runId, []);
}

export function register(runId: string): ActiveRun {
  const state: ActiveRun = {
    runId,
    channel: new RunChannel(),
    cancellable: null,
    cancelled: false,
    cancelReason: null,
    paused: false,
    gate: async () => {
      // `while` 不是 `if`：被叫醒之後如果又被暫停了，要再等一次。
      while (state.paused && !state.cancelled) {
        await new Promise<void>((resolve) => {
          const list = waiters.get(runId) ?? [];
          list.push(resolve);
          waiters.set(runId, list);
        });
      }
    },
  };
  active.set(runId, state);
  waiters.set(runId, []);
  return state;
}

export function unregister(runId: string): void {
  release(runId);
  active.delete(runId);
  waiters.delete(runId);
}

/**
 * 暫停與續跑。**回 `false` 代表那個 run 不在執行中**（跟 `cancel` 同一個約定）。
 *
 * **暫停不停爬蟲、不殺子程序** —— 它只是讓迴圈在下一項之前停下來。
 * 正在進行的那一項會做完：中途砍掉它會留下一個抓了一半的快照，
 * 而那正是「取消時已寫入的保留」在保護的東西。
 */
export function pause(runId: string): boolean {
  const state = active.get(runId);
  if (state === undefined || state.cancelled) return false;
  state.paused = true;
  return true;
}

export function resume(runId: string): boolean {
  const state = active.get(runId);
  if (state === undefined || !state.paused) return false;
  state.paused = false;
  release(runId);
  return true;
}

/** 現在有幾個作業在跑。**「要不要二次確認」問的就是這個數字。** */
export function activeCount(): number {
  return active.size;
}

export function isPaused(runId: string): boolean {
  return active.get(runId)?.paused ?? false;
}

export function channelOf(runId: string): RunChannel | null {
  return active.get(runId)?.channel ?? null;
}

export function isActive(runId: string): boolean {
  return active.has(runId);
}

export function replayOf(runId: string): readonly RunEvent[] {
  return active.get(runId)?.channel.replay ?? [];
}

/**
 * 取消。**回 `false` 代表那個 run 根本不在執行中** ——
 * 呼叫端負責把它變成一個有碼的錯誤（這一層不認得錯誤碼）。
 */
export function cancel(runId: string, reason: RunEndedReason | null = null): boolean {
  const state = active.get(runId);
  if (state === undefined) return false;
  state.cancelled = true;
  state.cancelReason = reason;
  state.paused = false;
  // **暫停中的作業也要取消得掉。** 不放走等在 gate 上的那個，
  // 迴圈永遠不會回到「檢查 cancelled」那一行。
  release(runId);
  state.cancellable?.stop();
  return true;
}

/**
 * 全部取消。**關閉程式走這一支。**
 *
 * 「關掉程式」與「使用者按取消」對一個正在跑的作業是同一件事：
 * 不再往下做，已經寫進去的留著（ADR-0023）。差別只在**誰按的**，
 * 而那件事記在 `run.ended_reason`（schema v8），不是一個新狀態。
 *
 * **回傳的是「叫了幾個停下來」，不是「幾個已經停好了」** ——
 * 迴圈要跑到下一個項與項之間才看得到 `cancelled`，而正在抓的那一項會做完。
 * 呼叫端要自己等（有上限地等），等不到的那些由下一次啟動的孤兒掃描接住。
 */
export function cancelAll(): number {
  let stopped = 0;
  for (const runId of [...active.keys()]) if (cancel(runId, 'shutdown')) stopped += 1;
  return stopped;
}
