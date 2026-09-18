/**
 * 擷取管線的組裝：節流 ＋ `robots.txt` ＋ 真的送出去 ＋ **被限流時的退避與重試**。
 *
 * **這是唯一出口。** 量測腳本、匯入、日後的 agent 擴展全部走這一支 ——
 * 如果量測走另一條路，那量到的就不是使用者會遇到的東西。
 *
 * ## 被限流了怎麼辦（2026-09-13 起）
 *
 * 對方回 429／503 → 看 `Retry-After`（沒有就用預設退避）→ 等 → 同一個 URL 再試，
 * 最多 `MAX_RATE_LIMIT_RETRIES` 次；還是不行就**這一輪不再碰這個 host**
 * （`limitedHosts`），排在後面的同 host 項目直接記成 `FETCH_RATE_LIMITED`、不送請求，
 * **其他 host 照跑**。數字與理由在 `domain/ingest/throttle.ts` 與 `docs/architecture/fetch-policy.md`。
 *
 * 之前是「整批立即停、不重試、`Retry-After` 不看」。那條規則保護的是那一台伺服器，
 * 而一批 URL 常常跨很多台 —— `source-service.ts` 2026-09-08 實際踩到：Semantic Scholar 回 429，
 * 排在後面的 Europe PMC、PubMed、Unpaywall 一個都沒被檢查。
 *
 * **`stop()` 現在只有一個意思：使用者取消。** 它不再被限流觸發。
 */
import { isAllowed, robotsPathOf } from '../../domain/ingest/robots.js';
import { backOffDelayMs, effectiveIntervalMs } from '../../domain/ingest/throttle.js';
import { normalizeUrl } from '../../domain/ingest/url.js';
import type { ErrorCode } from '../../domain/errors/codes.js';
import { fetchOnce, type FetchOptions, type FetchOutcome } from './fetcher.js';
import { HostThrottle } from './host-throttle.js';
import { RobotsCache, originOf } from './robots-cache.js';

export interface CrawlEvent {
  readonly url: string;
  readonly host: string;
  /** 為了節流實際等了多久（毫秒）。**REQ-0003 的「可量測」就是它。** */
  readonly waitedMs: number;
  readonly robotsSource: string;
}

/** 被限流之後正在退避。畫面上「正在等 {host}」用的就是這個。 */
export interface BackOffEvent {
  readonly host: string;
  readonly status: number;
  /** 這一次要等多久（毫秒）。 */
  readonly delayMs: number;
  /** 第幾次重試（1 起算）。 */
  readonly attempt: number;
}

export interface CrawlerOptions {
  /** 同網域間隔。**只能調長不能調短** —— `clampInterval` 會夾住它。 */
  readonly intervalMs: number;
  readonly onEvent?: (e: CrawlEvent) => void;
  readonly onBackOff?: (e: BackOffEvent) => void;
}

export interface CrawlResult {
  readonly outcome: FetchOutcome;
  /**
   * 這一項因為對方限流而失敗：退避重試過了還是不行，或者這個 host 在這一輪已經被放棄。
   * **可重排** —— 它不是這個 URL 的問題，是時機的問題。
   */
  readonly rateLimited: boolean;
  /**
   * 這一次為了節流與退避總共等了多久（毫秒，含轉址的每一跳與每一次退避）。
   *
   * **它會被寫進 `run_item.waited_ms`** —— REQ-0003 的驗收條件是
   * 「同網域請求間隔**可量測**」，而可量測要有一個量得到的地方。
   */
  readonly waitedMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class Crawler {
  private readonly throttle = new HostThrottle();
  private readonly robots = new RobotsCache();
  private readonly limited = new Map<string, number>();
  private stopped = false;

  constructor(private readonly options: CrawlerOptions) {}

  /** 使用者取消之後整台停下來。**已經寫入的保留**，但不再送新請求。 */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** 這一輪已經放棄的 host（退避重試過仍被限流）→ 最後一次看到的狀態碼。 */
  get limitedHosts(): ReadonlyMap<string, number> {
    return this.limited;
  }

  stop(): void {
    this.stopped = true;
  }

  async fetch(url: string, options: FetchOptions = {}): Promise<CrawlResult> {
    if (this.stopped) {
      return {
        outcome: {
          kind: 'error',
          code: 'FETCH_UNEXPECTED',
          detail: { why: 'crawler-stopped', url },
          backOff: false,
        },
        rateLimited: false,
        waitedMs: 0,
      };
    }

    let waitedMs = 0;
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.fetchGated(
        url,
        (waited) => {
          waitedMs += waited;
        },
        options,
      );
      if (outcome.kind === 'error' && outcome.detail['why'] === 'host-limited') {
        // 這一跳（可能是轉址的中途）要去的 host 在這一輪已經放棄了 —— **沒有送請求**。
        return { outcome: { ...outcome, backOff: true }, rateLimited: true, waitedMs };
      }
      if (outcome.kind !== 'error' || !outcome.backOff) {
        return { outcome, rateLimited: false, waitedMs };
      }

      const host = String(outcome.detail['host'] ?? '');
      const status = Number(outcome.detail['status'] ?? 0);
      const retryAfterMs = outcome.detail['retryAfterMs'];
      const delay = backOffDelayMs(typeof retryAfterMs === 'number' ? retryAfterMs : null, attempt);

      if (delay === 'give-up' || this.stopped) {
        this.limited.set(host, status);
        return { outcome, rateLimited: true, waitedMs };
      }

      this.options.onBackOff?.({ host, status, delayMs: delay, attempt: attempt + 1 });
      waitedMs += await this.sleepUnlessStopped(delay);
      if (this.stopped) {
        this.limited.set(host, status);
        return { outcome, rateLimited: true, waitedMs };
      }
    }
  }

  /** 一次 `fetchOnce`，每一跳之前先過 robots 與節流。 */
  private fetchGated(
    url: string,
    onWaited: (ms: number) => void,
    options: FetchOptions,
  ): Promise<FetchOutcome> {
    return fetchOnce(
      url,
      async (hopUrl, host) => {
        // 0. **這一輪已經放棄的 host 一個請求都不送** —— 連 robots 都不問。
        //    放在 gate 而不是 fetch() 開頭：一個短網址轉址到被放棄的 host，也要在這一跳擋下。
        if (this.limited.has(host)) {
          return {
            code: 'FETCH_RATE_LIMITED' as ErrorCode,
            detail: { why: 'host-limited', host, status: this.limited.get(host) },
          };
        }

        const origin = originOf(hopUrl);

        // 1. **先問 robots，而問它本身也要排隊** —— 「先問過再抓」如果可以插隊，
        //    那條規則就只是一個註解。
        const robots = await this.robots.policyFor(origin, async () => {
          await this.throttle.acquire(host, this.options.intervalMs);
        });
        if (robots.backOff !== null) {
          // robots.txt 本身被限流：跟頁面被限流走同一條退避路，由上面的迴圈處理。
          return {
            code: 'FETCH_RATE_LIMITED' as ErrorCode,
            detail: {
              at: 'robots',
              host,
              status: robots.backOff.status,
              retryAfterMs: robots.backOff.retryAfterMs,
            },
          };
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
        onWaited(waited);
        this.options.onEvent?.({
          url: hopUrl,
          host,
          waitedMs: waited,
          robotsSource: robots.source,
        });
        return null;
      },
      options,
    ).then((outcome) => {
      // gate 擋下來的限流（robots 那一條）沒有 `backOff` 旗標 —— 補上，讓外面的迴圈認得。
      if (
        outcome.kind === 'error' &&
        outcome.code === 'FETCH_RATE_LIMITED' &&
        outcome.detail['at'] === 'robots'
      ) {
        return { ...outcome, backOff: true };
      }
      return outcome;
    });
  }

  /** 退避時也要聽得到取消：每 250 毫秒看一次，不要一覺睡到底。 */
  private async sleepUnlessStopped(ms: number): Promise<number> {
    const started = Date.now();
    const deadline = started + ms;
    while (!this.stopped) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(250, remaining));
    }
    return Date.now() - started;
  }

  /** 只做正規化與 scheme 檢查，不送出任何請求。 */
  static precheck(url: string): ReturnType<typeof normalizeUrl> {
    return normalizeUrl(url);
  }
}
