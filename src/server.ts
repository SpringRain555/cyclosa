/**
 * 建 server、掛路由、解析資料根。**這個檔案不會自己啟動任何東西** ——
 * 啟動是 `main.ts` 的事，測試 import 這一份。
 *
 * **只綁 `127.0.0.1`**（ADR-0002）—— 綁 `0.0.0.0` 等於把一個沒有認證的
 * 本機工具開到區域網路上，那要是另一個決定，帶著它自己的認證設計。
 * **而「只有本機連得到」不等於「只有這個工具的頁面連得到」** —— 瀏覽器裡的任何網頁都在本機，
 * 所以每一個請求另外檢查 Host 與 Origin（ADR-0036，`interface/http/request-guard.ts`）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';

import { MAX_UPLOAD_BYTES } from './domain/ingest/upload.js';
import { registerRequestGuard } from './interface/http/request-guard.js';
import { registerRoutes, type AppContext } from './interface/http/routes.js';
import { pdfjsRoot, registerPdfjsAssets, registerStatic } from './interface/http/static.js';
import { resolveOrCreateDataRoot } from './application/bootstrap-service.js';
import { correlationId } from './shared/id.js';
import { logger } from './shared/log.js';

export const HOST = '127.0.0.1';
export const PORT = 7433;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 版本從 `package.json` 讀，**不在這裡寫第二次**。
 *
 * 寫死的那一版在 v0.1.1 就已經跟 `package.json` 分岔了 ——
 * 而 `/healthz` 回報的就是這個值，也就是說單一實例偵測看到的版本是錯的。
 * `dist/server.js` 與 `src/server.ts` 往上一層都是 repo 根目錄。
 */
function readVersion(): string {
  try {
    const raw = readFileSync(join(HERE, '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();

/** build 過的前端在 `web/dist`；`dist/server.js` 與 `src/server.ts` 都往上一層找得到它。 */
function webRoot(): string {
  return join(HERE, '..', 'web', 'dist');
}

/** Fastify 自己丟的錯誤帶著 `FST_ERR_*` 的 `code`；其他的回 `null`。 */
function fastifyCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' && code.startsWith('FST_ERR_') ? code : null;
}

export async function buildServer(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const ctx: AppContext = { version: VERSION, dataRoot: null };

  // **只收這個工具自己的頁面送來的請求**（ADR-0036）—— 掛在所有路由之前。
  registerRequestGuard(app);

  /**
   * **拿掉 Fastify 預設的 `text/plain` 解析器。**
   *
   * `text/plain` 的 POST 是瀏覽器眼中的「簡單請求」：任何一個網頁都能不經預檢送過來，
   * 而那個解析器會把它交給路由。前端只送 JSON 與 `application/octet-stream`，用不到它。
   * 拿掉之後那種請求是 415，碰不到任何一支路由（ADR-0036）。
   */
  app.removeContentTypeParser('text/plain');

  /**
   * 拖進來的檔案用原始位元組上傳。
   *
   * **沒有裝 multipart 套件**：一次一個檔、檔名走標頭，
   * 那條路不需要解析 multipart，也就不需要一個會解析外部輸入的新依賴。
   * base64 塞進 JSON 也可以，但那會讓 32 MB 變成 43 MB。
   */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body);
    },
  );

  /**
   * **空的 JSON body 當成 `{}`，不是錯誤。**
   *
   * Fastify 預設對「宣告了 `application/json` 但 body 是空的」直接回錯，
   * 而經過我們的錯誤處理器之後那會變成一個 500 ——
   * 對一個本來就不需要參數的動作（排除、復原、重試）來說，
   * 那是一個完全沒有道理的失敗。2026-09-07 手動驗收時三個按鈕一起中。
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  // **第一次啟動自動建，不問**。故障的那三種仍然照原樣往上回 ——
  // 理由在 `resolveOrCreateDataRoot` 的註解裡。
  const resolved = await resolveOrCreateDataRoot();
  if (resolved.ok) {
    ctx.dataRoot = resolved.data.dataRoot;
    logger.info('資料根已就緒', { correlationId: resolved.correlationId });
  } else {
    // **不是啟動失敗。** 清單頁要顯示「指標檔在哪、指到哪、那個路徑怎麼了」，
    // 而顯示那件事需要 server 活著（REQ-0001）。
    logger.warn('資料根尚未就緒', { correlationId: resolved.correlationId, code: resolved.code });
  }

  /**
   * 未預期的例外也要有碼與 correlationId，
   * **不得出現英文 stack trace 直接噴到使用者畫面上**（REQ-0008）。
   */
  app.setErrorHandler((error: unknown, req, reply) => {
    // **Fastify 自己擋下的那一種不是「未預期」**：前端只送 JSON 與 octet-stream，
    // 收到別的型別（415）就是別人送的 —— 跟 `request-guard.ts` 擋下的是同一件事（ADR-0036）。
    if (fastifyCode(error) === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      void reply
        .code(415)
        .send({ ok: false, code: 'IO_REQUEST_FOREIGN', correlationId: 'media-type' });
      return;
    }
    // **上傳超過上限也不是「未預期」**：使用者拖了一個太大的檔案。批次匯入在開批次時就照大小標掉了，
    // 走到這裡的是沒報大小的那一種 —— 說清楚上限，不叫人交識別碼（`domain/ingest/upload.ts`）。
    if (fastifyCode(error) === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      void reply.code(413).send({
        ok: false,
        code: 'FETCH_UPLOAD_TOO_LARGE',
        correlationId: 'body-too-large',
        // 那一條路由自己的上限（上傳是 256 MB，其他 JSON 請求是整個 server 的 32 MB）
        detail: { limit: req.routeOptions.bodyLimit ?? MAX_UPLOAD_BYTES },
      });
      return;
    }
    const cid = correlationId();
    logger.error('未預期的例外', {
      correlationId: cid,
      route: req.routeOptions.url ?? req.url,
      reason: error instanceof Error ? error.message : String(error),
    });
    void reply.code(500).send({ ok: false, code: 'IO_UNEXPECTED', correlationId: cid });
  });

  registerRoutes(app, ctx);
  registerPdfjsAssets(app, pdfjsRoot());
  registerStatic(app, webRoot());

  return { app, ctx };
}
