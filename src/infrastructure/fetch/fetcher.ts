/**
 * 真正送出請求的地方。**擷取管線的唯一出口**（ADR-0006）。
 *
 * 節流、robots、雜湊、manifest 只存在於這一層 ——
 * 開第二條路等於讓它們全部失效，所以 `agent` 找到的 URL 也一律回到這裡。
 */
import { USER_AGENT_TOKEN } from '../../domain/ingest/robots.js';
import { normalizeUrl } from '../../domain/ingest/url.js';
import { isBackOffSignal } from '../../domain/ingest/throttle.js';
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
      /** **對方在說慢一點**（429／503）。整批立即停止且不重試。 */
      readonly backOff: boolean;
    };

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
export async function fetchOnce(startUrl: string, gate: HopGate): Promise<FetchOutcome> {
  const hops: FetchHop[] = [];
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
      await res.body?.cancel().catch(() => undefined);
      // **立即停，不重試。** `Retry-After` 我們不看 —— 看了就會想「等一下再試」，
      // 而那正是這條規則要擋住的行為。
      return {
        kind: 'error',
        code: 'FETCH_RATE_LIMITED',
        detail: { status: res.status, host: parsed.host },
        backOff: true,
      };
    }

    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      // **不繞過。** 這是不可違反的規則之一，不是一個可以「想辦法」的失敗。
      return {
        kind: 'error',
        code: 'FETCH_LOGIN_REQUIRED',
        detail: { status: res.status },
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

    return {
      kind: 'ok',
      bytes,
      contentType: res.headers.get('content-type'),
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
