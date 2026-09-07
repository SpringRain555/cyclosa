/**
 * 同網域節流的執行端。政策（下限、`crawl-delay` 取大）在
 * `domain/ingest/throttle.ts` —— 這裡只負責真的等下去。
 *
 * **每個 host 一條序列。** 兩個請求同時要打同一台機器時，
 * 第二個排在第一個後面，而不是各自算「距離上次多久」——
 * 後者在並行下會同時通過檢查，然後同時送出去。
 * **這是節流最典型的失效方式，而且它在單執行緒測試裡看不出來。**
 */
import { waitMs } from '../../domain/ingest/throttle.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class HostThrottle {
  private readonly lastAt = new Map<string, number>();
  private readonly tail = new Map<string, Promise<void>>();

  /** 上一次對這個 host 送出請求的時間（`null` = 沒送過）。 */
  lastRequestAt(host: string): number | null {
    return this.lastAt.get(host) ?? null;
  }

  /**
   * 排到這個 host 的下一個位置，等到可以送出為止。
   *
   * 回傳的是「等了多久」—— 作業紀錄的節流狀態列要顯示它，
   * 而 REQ-0003 的驗收條件是「**可量測**：日誌的時間戳序列」。
   */
  async acquire(host: string, intervalMs: number, now: () => number = Date.now): Promise<number> {
    const previous = this.tail.get(host) ?? Promise.resolve();

    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail.set(
      host,
      previous.then(() => mine),
    );

    await previous;
    const waited = waitMs(this.lastAt.get(host) ?? null, now(), intervalMs);
    if (waited > 0) await sleep(waited);
    this.lastAt.set(host, now());
    release();
    return waited;
  }
}
