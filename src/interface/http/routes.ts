/**
 * Fastify 路由。
 *
 * **route 只做三件事**：解析請求 → 呼叫 application 的 service → 對映錯誤。
 * **業務規則不寫在這裡**（分層規則，由 tests/guards 守著）。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import { httpStatusOf } from '../../domain/errors/codes.js';
import { changeCaseStatus, createCase, listCases } from '../../application/case-service.js';
import { initDataRoot, resolveDataRootOrExplain } from '../../application/bootstrap-service.js';
import type { Result } from '../../shared/result.js';

export interface AppContext {
  readonly version: string;
  /** 啟動時解析出來的資料根。**沒解析成功就是 `null`**，而清單頁要顯示那個原因。 */
  dataRoot: string | null;
}

/**
 * 把 `Result` 送出去。
 *
 * **`message` 不在這裡** —— UI 只顯示繁中訊息，而那些字串的唯一來源是
 * `web/src/i18n/zh-TW.ts`。後端送碼，前端查表。
 * 這樣「同一個碼在兩個地方有兩種說法」就不可能發生。
 */
function send<T>(reply: FastifyReply, result: Result<T>): FastifyReply {
  if (result.ok) {
    return reply
      .code(200)
      .send({ ok: true, data: result.data, correlationId: result.correlationId });
  }
  return reply.code(httpStatusOf(result.code)).send({
    ok: false,
    code: result.code,
    correlationId: result.correlationId,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  });
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * 單一實例偵測靠它（ADR-0020）。
   *
   * **一定要回一個可辨識的欄位** —— 只看「有沒有回 200」
   * 會把別人跑在 7433 的服務誤認成自己，然後把瀏覽器開到一個不相干的網頁。
   */
  app.get('/healthz', async () => ({ app: 'cyclosa', version: ctx.version }));

  app.get('/api/system/data-root', async (_req, reply) => {
    const r = await resolveDataRootOrExplain();
    if (r.ok) ctx.dataRoot = r.data.dataRoot;
    return send(reply, r);
  });

  app.post<{ Body: { dataRoot?: unknown } }>('/api/system/data-root', async (req, reply) => {
    const value = req.body?.dataRoot;
    if (typeof value !== 'string' || value.trim().length === 0) {
      return reply.code(400).send({ ok: false, code: 'IO_POINTER_MALFORMED' });
    }
    const r = await initDataRoot(value.trim());
    if (r.ok) ctx.dataRoot = r.data.dataRoot;
    return send(reply, r);
  });

  app.get('/api/cases', async (_req, reply) => {
    if (ctx.dataRoot === null) {
      // 資料根還沒解析出來 —— 回那個原因，**不是回一個空清單**（REQ-0001）
      return send(reply, await resolveDataRootOrExplain());
    }
    return send(reply, await listCases(ctx.dataRoot));
  });

  app.post<{ Body: { name?: unknown; seed?: unknown } }>('/api/cases', async (req, reply) => {
    if (ctx.dataRoot === null) return send(reply, await resolveDataRootOrExplain());
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const seed = typeof req.body?.seed === 'string' ? req.body.seed : undefined;
    return send(reply, await createCase(ctx.dataRoot, { name, seed }));
  });

  app.post<{ Params: { slug: string }; Body: { action?: unknown } }>(
    '/api/cases/:slug/status',
    async (req, reply) => {
      if (ctx.dataRoot === null) return send(reply, await resolveDataRootOrExplain());
      const action = req.body?.action;
      if (action !== 'archive' && action !== 'reopen') {
        return reply.code(400).send({ ok: false, code: 'GRAPH_TRANSITION_INVALID' });
      }
      return send(reply, await changeCaseStatus(ctx.dataRoot, req.params.slug, action));
    },
  );
}
