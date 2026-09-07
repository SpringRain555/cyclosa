/**
 * 建 server、掛路由、解析資料根。**這個檔案不會自己啟動任何東西** ——
 * 啟動是 `main.ts` 的事，測試 import 這一份。
 *
 * **只綁 `127.0.0.1`**（ADR-0002）—— 綁 `0.0.0.0` 等於把一個沒有認證的
 * 本機工具開到區域網路上，那要是另一個決定，帶著它自己的認證設計。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerRoutes, type AppContext } from './interface/http/routes.js';
import { registerStatic } from './interface/http/static.js';
import { resolveDataRootOrExplain } from './application/bootstrap-service.js';
import { correlationId } from './shared/id.js';
import { logger } from './shared/log.js';

export const HOST = '127.0.0.1';
export const PORT = 7433;
export const VERSION = '0.1.0';

const HERE = dirname(fileURLToPath(import.meta.url));

/** build 過的前端在 `web/dist`；`dist/server.js` 與 `src/server.ts` 都往上一層找得到它。 */
function webRoot(): string {
  return join(HERE, '..', 'web', 'dist');
}

export async function buildServer(): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const ctx: AppContext = { version: VERSION, dataRoot: null };

  const resolved = await resolveDataRootOrExplain();
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
    const cid = correlationId();
    logger.error('未預期的例外', {
      correlationId: cid,
      route: req.routeOptions.url ?? req.url,
      reason: error instanceof Error ? error.message : String(error),
    });
    void reply.code(500).send({ ok: false, code: 'IO_UNEXPECTED', correlationId: cid });
  });

  registerRoutes(app, ctx);
  registerStatic(app, webRoot());

  return { app, ctx };
}
