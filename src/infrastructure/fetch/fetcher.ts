/**
 * 真正送出請求的地方。**擷取管線的唯一出口**（ADR-0006）。
 *
 * 節流、robots、雜湊、manifest 只存在於這一層 ——
 * 開第二條路等於讓它們全部失效，所以 `agent` 找到的 URL 也一律回到這裡。
 */
import { USER_AGENT_TOKEN } from '../../domain/ingest/robots.js';
import { normalizeUrl } from '../../domain/ingest/url.js';
import { isBackOffSignal, parseRetryAfter } from '../../domain/ingest/throttle.js';
import {
  classifyChallenge,
  vendorChallengeHeader,
  MARKER_SCAN_CHARS,
  type FetchExpect,
} from '../../domain/ingest/challenge.js';
import type { ErrorCode } from '../../domain/errors/codes.js';

/** 單一資源的大小上限。超過就是 `FETCH_TOO_LARGE`，不是把記憶體吃光。 */
export const MAX_BYTES = 25 * 1024 * 1024;

/** 單一請求的逾時。 */
export const TIMEOUT_MS = 20_000;

/** 跟隨轉址的上限。**手動跟，因為每一跳都要重查 robots 與節流。** */
export const MAX_REDIRECTS = 5;

export const USER_AGENT = `${USER_AGENT_TOKEN}/0.1 (+local research tool; single user)`;

export interface FetchHop {
  readonly url: string;
  readonly host: string;
  readonly status: number;
}

export type FetchOutcome =
  | {
      readonly kind: 'ok';
      readonly bytes: Uint8Array;
      readonly contentType: string | null;
      readonly finalUrl: string;
      readonly status: number;
      readonly hops: readonly FetchHop[];
    }
  | {
      readonly kind: 'error';
      readonly code: ErrorCode;
      readonly detail: Record<string, unknown>;
      /**
       * **對方在說慢一點**（429／503）。這一層只回報，**退避與重試由 `Crawler` 決定**
       * （`domain/ingest/throttle.ts` 的 `backOffDelayMs`）；`detail.retryAfterMs` 是對方說的。
       */
      readonly backOff: boolean;
    };

/**
 * 這一次抓取要的是什麼。
 *
 * **只有探測會用 `data`** —— 內建清單裡有探針的每一列都是 API，
 * 而一支 API 回 HTML 就是「這不是我要的東西」，不必認得任何反爬蟲產品
 * （`domain/ingest/challenge.ts` 第一層）。
 */
export interface FetchOptions {
  readonly expect?: FetchExpect;
}

/** 每一跳之前要做的事（節流 ＋ robots）。回 `null` 代表可以送。 */
export type HopGate = (
  url: string,
  host: string,
) => Promise<{ readonly code: ErrorCode; readonly detail: Record<string, unknown> } | null>;

function classifyNetworkError(e: unknown): { code: ErrorCode; detail: Record<string, unknown> } {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  const causeCode = err.cause?.code ?? '';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return { code: 'FETCH_TIMEOUT', detail: { after: TIMEOUT_MS } };
  }
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
    return { code: 'FETCH_DNS', detail: { cause: causeCode } };
  }
  if (
    causeCode.startsWith('ERR_TLS') ||
    causeCode.startsWith('CERT_') ||
    causeCode === 'ERR_SSL_WRONG_VERSION_NUMBER'
  ) {
    return { code: 'FETCH_TLS', detail: { cause: causeCode } };
  }
  return { code: 'FETCH_UNEXPECTED', detail: { reason: String(err.message ?? e) } };
}

/**
 * 標頭攤平成小寫鍵的物件，給 `domain/ingest/challenge.ts` 用。
 *
 * `Headers` 迭代出來的鍵本來就是小寫；**同名多筆會被合併成一個字串**
 * （`set-cookie` 除外，那一個在這裡用不到）。
 */
function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** 掃標記用的內文開頭。**不是文字型別就不解碼** —— PDF 解出來是亂碼。 */
function headTextOf(bytes: Uint8Array, contentType: string | null): string {
  const type = (contentType ?? '').toLowerCase();
  const textual =
    type.includes('text/') ||
    type.includes('json') ||
    type.includes('xml') ||
    type.includes('javascript');
  if (!textual) return '';
  const head = bytes.subarray(0, MARKER_SCAN_CHARS);
  return new TextDecoder('utf-8', { fatal: false }).decode(head);
}

/** 把回應內容讀進記憶體，超過上限就中止。 */
async function readCapped(res: Response): Promise<Uint8Array | 'too-large'> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BYTES) return 'too-large';

  const body = res.body;
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return 'too-large';
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * 抓一個 URL。
 *
 * **轉址手動跟**：`fetch` 內建的 `redirect: 'follow'` 會直接跳到終點，
 * 而那樣的話中途換到另一個網域時**沒有查那個網域的 `robots.txt`，
 * 也沒有對它節流**。一個 `bit.ly` 短網址可以把整條紀律繞過去。
 */
export async function fetchOnce(
  startUrl: string,
  gate: HopGate,
  options: FetchOptions = {},
): Promise<FetchOutcome> {
  const hops: FetchHop[] = [];
  const expect: FetchExpect = options.expect ?? 'any';
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = normalizeUrl(current);
    if (parsed.kind !== 'ok') {
      return {
        kind: 'error',
        code: 'FETCH_UNEXPECTED',
        detail: { url: current, why: parsed.kind },
        backOff: false,
      };
    }

    const blocked = await gate(parsed.url, parsed.host);
    if (blocked !== null) {
      return { kind: 'error', code: blocked.code, detail: blocked.detail, backOff: false };
    }

    let res: Response;
    try {
      res = await fetch(parsed.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'user-agent': USER_AGENT,
          accept:
            'text/html,application/xhtml+xml,application/pdf,text/plain,image/*;q=0.8,*/*;q=0.5',
          'accept-language': 'zh-TW,zh;q=0.9,en;q=0.8',
        },
      });
    } catch (e) {
      const { code, detail } = classifyNetworkError(e);
      return { kind: 'error', code, detail: { ...detail, url: parsed.url }, backOff: false };
    }

    hops.push({ url: parsed.url, host: parsed.host, status: res.status });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (location === null || location.length === 0) {
        return {
          kind: 'error',
          code: 'FETCH_UNEXPECTED',
          detail: { why: 'redirect-without-location' },
          backOff: false,
        };
      }
      current = new URL(location, parsed.url).toString();
      continue;
    }

    if (isBackOffSignal(res.status)) {
      // `Retry-After` 是對方的意願，讀出來交給 Crawler 決定等多久（RFC 9110 §10.2.3）。
      // 2026-09-13 之前這裡刻意不看它 ——「看了就會想等一下再試」——
      // 而「等一下再試」正是對方在要求的事，不是要擋的行為。
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), Date.now());
      await res.body?.cancel().catch(() => undefined);
      return {
        kind: 'error',
        code: 'FETCH_RATE_LIMITED',
        detail: { status: res.status, host: parsed.host, retryAfterMs },
        backOff: true,
      };
    }

    if (res.status === 401 || res.status === 403) {
      // **這裡有兩種完全不同的事，而它們共用狀態碼。**
      // 一種是「你沒有訂閱」，一種是「你是程式」—— 後者登入也沒有用。
      // 分得開的唯一依據是廠商自己宣告的標頭（Q7 第二層），沒有就不猜。
      const vendor = vendorChallengeHeader(headersOf(res));
      await res.body?.cancel().catch(() => undefined);
      // **不繞過。** 這是不可違反的規則之一，不是一個可以「想辦法」的失敗。
      return vendor === null
        ? {
            kind: 'error',
            code: 'FETCH_LOGIN_REQUIRED',
            detail: { status: res.status },
            backOff: false,
          }
        : {
            kind: 'error',
            code: 'FETCH_BOT_CHALLENGE',
            detail: { status: res.status, basis: 'vendor', vendor },
            backOff: false,
          };
    }

    if (res.status >= 400 && res.status < 500) {
      await res.body?.cancel().catch(() => undefined);
      return {
        kind: 'error',
        code: 'FETCH_HTTP_4XX',
        detail: { status: res.status },
        backOff: false,
      };
    }

    if (res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      return {
        kind: 'error',
        code: 'FETCH_HTTP_5XX',
        detail: { status: res.status },
        backOff: false,
      };
    }

    const bytes = await readCapped(res).catch(() => 'too-large' as const);
    if (bytes === 'too-large') {
      return {
        kind: 'error',
        code: 'FETCH_TOO_LARGE',
        detail: { limit: MAX_BYTES },
        backOff: false,
      };
    }

    // **200 不是「這是內容」的證據**（open-questions Q7）。
    // 一張反爬蟲驗證頁對瀏覽器來說確實成功了 —— 它本來就是要被執行的那一頁。
    // 這個判斷放在這裡而不是抽取那一層，因為**標頭只有這裡看得到**。
    const contentType = res.headers.get('content-type');
    const challenge = classifyChallenge({
      headers: headersOf(res),
      contentType,
      bodySize: bytes.byteLength,
      bodyHead: headTextOf(bytes, contentType),
      expect,
    });
    if (challenge.verdict !== 'content') {
      return {
        kind: 'error',
        code: 'FETCH_BOT_CHALLENGE',
        detail: {
          status: res.status,
          basis: challenge.basis,
          vendor: challenge.vendor,
          contentType,
          // 第三層只到「不確定」。**畫面上要說得出這兩者的差別**，
          // 因為「我們認得這個產品」與「這一頁看起來不像內容」是不同的把握。
          certain: challenge.verdict === 'challenge',
        },
        backOff: false,
      };
    }

    return {
      kind: 'ok',
      bytes,
      contentType,
      finalUrl: parsed.url,
      status: res.status,
      hops,
    };
  }

  return {
    kind: 'error',
    code: 'FETCH_UNEXPECTED',
    detail: { why: 'too-many-redirects', hops: hops.length },
    backOff: false,
  };
}
