/**
 * 擷取管線的組裝：節流 ＋ `robots.txt` ＋ 真的送出去。
 *
 * **這是唯一出口。** 量測腳本、匯入、日後的 agent 擴展全部走這一支 ——
 * 如果量測走另一條路，那量到的就不是使用者會遇到的東西。
 */
import { isAllowed, robotsPathOf } from '../../domain/ingest/robots.js';
import { effectiveIntervalMs } from '../../domain/ingest/throttle.js';
import { normalizeUrl } from '../../domain/ingest/url.js';
import type { ErrorCode } from '../../domain/errors/codes.js';
import { fetchOnce, type FetchOutcome } from './fetcher.js';
import { HostThrottle } from './host-throttle.js';
import { RobotsCache, originOf } from './robots-cache.js';

export interface CrawlEvent {
  readonly url: string;
  readonly host: string;
  /** 為了節流實際等了多久（毫秒）。**REQ-0003 的「可量測」就是它。** */
  readonly waitedMs: number;
  readonly robotsSource: string;
}

export interface CrawlerOptions {
  /** 同網域間隔。**只能調長不能調短** —— `clampInterval` 會夾住它。 */
  readonly intervalMs: number;
  readonly onEvent?: (e: CrawlEvent) => void;
}

export interface CrawlResult {
  readonly outcome: FetchOutcome;
  /** 對方回 429／503。**整批立即停，不重試。** */
  readonly backOff: boolean;
  /**
   * 這一次為了節流總共等了多久（毫秒，含轉址的每一跳）。
   *
   * **它會被寫進 `run_item.waited_ms`** —— REQ-0003 的驗收條件是
   * 「同網域請求間隔 ≥ 3–5 秒，**可量測**」，而可量測要有一個量得到的地方。
   */
  readonly waitedMs: number;
}

export class Crawler {
  private readonly throttle = new HostThrottle();
  private readonly robots = new RobotsCache();
  private stopped = false;

  constructor(private readonly options: CrawlerOptions) {}

  /** 收到 429／503 之後整台停下來。**已經寫入的保留**，但不再送新請求。 */
  get isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
  }

  async fetch(url: string): Promise<CrawlResult> {
    if (this.stopped) {
      return {
        outcome: {
          kind: 'error',
          code: 'FETCH_RATE_LIMITED',
          detail: { why: 'already-stopped' },
          backOff: true,
        },
        backOff: true,
        waitedMs: 0,
      };
    }

    let backOff = false;
    let waitedMs = 0;

    const outcome = await fetchOnce(url, async (hopUrl, host) => {
      const origin = originOf(hopUrl);

      // 1. **先問 robots，而問它本身也要排隊** —— 「先問過再抓」如果可以插隊，
      //    那條規則就只是一個註解。
      const robots = await this.robots.policyFor(origin, async () => {
        await this.throttle.acquire(host, this.options.intervalMs);
      });
      if (robots.backOff) {
        backOff = true;
        this.stopped = true;
        return { code: 'FETCH_RATE_LIMITED' as ErrorCode, detail: { at: 'robots', host } };
      }

      const decision = isAllowed(robots.policy, robotsPathOf(hopUrl));
      if (!decision.allowed) {
        // **記錄原因，不是靜默跳過**（REQ-0003）。
        return {
          code: 'FETCH_ROBOTS_DISALLOWED' as ErrorCode,
          detail: { host, rule: decision.rule, source: robots.source },
        };
      }

      // 2. 排這個 host 的下一個位置
      const interval = effectiveIntervalMs(
        this.options.intervalMs,
        robots.policy.crawlDelaySeconds,
      );
      const waited = await this.throttle.acquire(host, interval);
      waitedMs += waited;
      this.options.onEvent?.({ url: hopUrl, host, waitedMs: waited, robotsSource: robots.source });
      return null;
    });

    if (outcome.kind === 'error' && outcome.backOff) {
      backOff = true;
      this.stopped = true;
    }

    return { outcome, backOff, waitedMs };
  }

  /** 只做正規化與 scheme 檢查，不送出任何請求。 */
  static precheck(url: string): ReturnType<typeof normalizeUrl> {
    return normalizeUrl(url);
  }
}
