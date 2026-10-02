/**
 * **只收這個工具自己的頁面送來的請求**（ADR-0036）。
 *
 * server 只綁 `127.0.0.1`（ADR-0002），但「只有本機連得到」不等於「只有 Cyclosa 的頁面連得到」——
 * 使用者瀏覽器裡的**任何一個網頁**都在本機。2026-10-02 查到兩條路：
 *
 * 1. **跨站的「簡單請求」**：`Content-Type: text/plain` 的 POST 不需要預檢，瀏覽器直接送出。
 *    Fastify 預設的 `text/plain` 解析器會把它交給路由 —— `POST /api/providers` 收到一個字串，
 *    解析成預設值，**把使用者的模型設定整份蓋掉**。
 * 2. **DNS rebinding**：攻擊者的網域先解析到自己的伺服器、再改解析到 `127.0.0.1`。
 *    對瀏覽器來說那是同一個來源，什麼請求都送得出去、回應也讀得到 ——
 *    把 `connections.cli.command` 設成任意程式，下一次 `GET /api/providers` 的探針就會執行它。
 *
 * 擋法（每一條各擋一件事）：
 *
 * - **`Host` 的主機名只准本機的三種寫法**：rebinding 的請求帶的是攻擊者的網域。埠不限 ——
 *   測試聽別的埠，開發時 Vite 代理過來的 Host 是 5173。
 * - **會改東西的方法帶了 `Origin`，就必須完全等於 `http://` ＋ 這個請求自己的 Host**：
 *   只比主機名的話，同一台機器上**別的埠**的網頁（另一個開發伺服器、另一個本機工具）也算本機。
 *   Vite 代理不改 Host（字串形式的 target），所以 Origin 與 Host 都是 5173，照樣對得上。
 * - **會改東西的方法帶了 `Sec-Fetch-Site`，就只准 `same-origin` 或 `none`**：
 *   瀏覽器自己填、網頁改不了的那一個標頭。
 * - **`text/plain` 解析器拿掉**（在 `server.ts`）：前端只送 JSON 與 `application/octet-stream`，
 *   兩者都不是「簡單請求」，跨站送就要預檢 —— 而這個 server 不回 CORS 標頭，預檢不會過。
 *
 * **沒有 `Origin` 的請求不擋**：啟動器的 `/healthz`、測試裡的 `app.inject`、終端機的 `curl` 都不帶它，
 * 而瀏覽器替跨站的 POST 一定會帶。
 *
 * **擋不住的**：同一個 Windows 使用者底下跑的程式 —— 它本來就讀得到這台電腦上的每一個檔案。
 */
import type { FastifyInstance } from 'fastify';

/** 本機的三種寫法。`[::1]` 帶方括號，因為 Host 標頭裡的 IPv6 位址就是那樣寫的。 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 會改東西的方法。GET／HEAD／OPTIONS 照規範不該改狀態，而這個 server 也沒有那樣的 GET。 */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type RequestVerdict = 'ok' | 'foreign-host' | 'foreign-origin';

export interface RequestFacts {
  readonly method: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly fetchSite: string | undefined;
}

/** `Host` 標頭的主機名（小寫）；格式不對回 `null`。 */
export function hostnameOf(host: string | undefined): string | null {
  if (host === undefined) return null;
  const m = /^(\[[0-9a-f:.]+\]|[^\s:[\]]+)(?::\d{1,5})?$/i.exec(host.trim());
  return m?.[1] === undefined ? null : m[1].toLowerCase();
}

export function requestVerdict(facts: RequestFacts): RequestVerdict {
  const hostname = hostnameOf(facts.host);
  if (hostname === null || !LOOPBACK_HOSTNAMES.has(hostname)) return 'foreign-host';
  if (!UNSAFE_METHODS.has(facts.method.toUpperCase())) return 'ok';
  if (
    facts.origin !== undefined &&
    facts.origin.toLowerCase() !== `http://${(facts.host ?? '').trim().toLowerCase()}`
  ) {
    return 'foreign-origin';
  }
  if (
    facts.fetchSite !== undefined &&
    facts.fetchSite !== 'same-origin' &&
    facts.fetchSite !== 'none'
  ) {
    return 'foreign-origin';
  }
  return 'ok';
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 掛在所有路由之前（`onRequest` 在解析 body 之前跑，所以被擋的請求連 body 都不會被讀）。
 * 回應形狀跟其他錯誤一樣；`correlationId` 是固定字串，因為這種請求不值得在日誌裡留一筆。
 */
export function registerRequestGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const verdict = requestVerdict({
      method: req.method,
      host: single(req.headers.host),
      origin: single(req.headers.origin),
      fetchSite: single(req.headers['sec-fetch-site']),
    });
    if (verdict === 'ok') return;
    // async hook 要提前回應，**得把 reply 交回去**，Fastify 才知道不要再往路由走。
    return reply.code(403).send({ ok: false, code: 'IO_REQUEST_FOREIGN', correlationId: verdict });
  });
}
