/**
 * 取得並快取每個 origin 的 `robots.txt`。解析在 `domain/ingest/robots.ts`。
 *
 * **抓 `robots.txt` 本身也算一次請求，所以它也要節流。**
 * 這會讓第一次抓某個網域慢一倍 —— 那是對的代價：
 * 「先問過再抓」如果可以插隊，那條規則就只是一個註解。
 */
import {
  ALLOW_ALL,
  DISALLOW_ALL,
  parseRobots,
  type RobotsPolicy,
} from '../../domain/ingest/robots.js';
import { isBackOffSignal } from '../../domain/ingest/throttle.js';
import { USER_AGENT } from './fetcher.js';

export interface RobotsResult {
  readonly policy: RobotsPolicy;
  /** 對方回 429／503 —— 整批要立即停。 */
  readonly backOff: boolean;
  /** 這一份是怎麼來的，寫進日誌用。 */
  readonly source: 'fetched' | 'absent' | 'unreachable' | 'cached';
}

const ROBOTS_TIMEOUT_MS = 8_000;
/** `robots.txt` 大得離譜的話只取前面這一段 —— RFC 9309 建議至少處理 500 KiB。 */
const MAX_ROBOTS_BYTES = 512 * 1024;

export class RobotsCache {
  private readonly cache = new Map<string, RobotsResult>();

  /** 已經知道的政策（不觸發網路）。 */
  peek(origin: string): RobotsResult | null {
    return this.cache.get(origin) ?? null;
  }

  async policyFor(origin: string, beforeRequest: () => Promise<void>): Promise<RobotsResult> {
    const cached = this.cache.get(origin);
    if (cached !== undefined) return { ...cached, source: 'cached' };

    await beforeRequest();

    let result: RobotsResult;
    try {
      const res = await fetch(new URL('/robots.txt', origin).toString(), {
        redirect: 'follow',
        signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT, accept: 'text/plain,*/*;q=0.5' },
      });

      if (isBackOffSignal(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        result = { policy: DISALLOW_ALL, backOff: true, source: 'unreachable' };
      } else if (res.status >= 400 && res.status < 500) {
        // **4xx ＝ 沒有規則 ＝ 可以抓**（RFC 9309 §2.3.1.3）
        await res.body?.cancel().catch(() => undefined);
        result = { policy: ALLOW_ALL, backOff: false, source: 'absent' };
      } else if (!res.ok) {
        // **5xx ＝ 拿不到 ＝ 當成全部不准**（§2.3.1.4）。
        // 這與上面那條**方向相反**，而它們很容易被寫成同一條。
        await res.body?.cancel().catch(() => undefined);
        result = { policy: DISALLOW_ALL, backOff: false, source: 'unreachable' };
      } else {
        const text = (await res.text()).slice(0, MAX_ROBOTS_BYTES);
        result = { policy: parseRobots(text), backOff: false, source: 'fetched' };
      }
    } catch {
      result = { policy: DISALLOW_ALL, backOff: false, source: 'unreachable' };
    }

    this.cache.set(origin, result);
    return result;
  }
}

export function originOf(url: string): string {
  return new URL(url).origin;
}
