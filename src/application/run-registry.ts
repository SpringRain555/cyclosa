/**
 * 執行中的作業。**匯入與擴展共用這一份。**
 *
 * ## 為什麼要抽出來
 *
 * Stage 6 的時候只有匯入，所以這張表就放在 `ingest-service.ts` 裡。
 * Stage 9 加了擴展，而它要走**同一個**取消端點
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
}

const active = new Map<string, ActiveRun>();

export function register(runId: string): ActiveRun {
  const state: ActiveRun = {
    runId,
    channel: new RunChannel(),
    cancellable: null,
    cancelled: false,
  };
  active.set(runId, state);
  return state;
}

export function unregister(runId: string): void {
  active.delete(runId);
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
export function cancel(runId: string): boolean {
  const state = active.get(runId);
  if (state === undefined) return false;
  state.cancelled = true;
  state.cancellable?.stop();
  return true;
}
