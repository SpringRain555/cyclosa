/**
 * Fastify 路由。
 *
 * **route 只做三件事**：解析請求 → 呼叫 application 的 service → 對映錯誤。
 * **業務規則不寫在這裡**（分層規則，由 tests/guards 守著）。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import { httpStatusOf } from '../../domain/errors/codes.js';
import type { ItemStatus } from '../../domain/ingest/state.js';
import { changeCaseStatus, createCase, listCases } from '../../application/case-service.js';
import { initDataRoot, resolveDataRootOrExplain } from '../../application/bootstrap-service.js';
import {
  cancelRun,
  channelOf,
  importFile,
  startUrlImport,
} from '../../application/ingest-service.js';
import {
  changeItemStatus,
  getItem,
  getItemContent,
  getSnapshot,
  listItems,
  markRead,
  urlForRetry,
} from '../../application/item-service.js';
import { getRun, listRuns } from '../../application/run-service.js';
import {
  defaultFocus,
  subgraph,
  subgraphSize,
  type SubgraphQuery,
} from '../../application/graph-service.js';
import { createEdge, getEdge, listQueue, transitionEdge } from '../../application/edge-service.js';
import {
  DEFAULT_PROJECTION_THRESHOLDS,
  EDGE_ACTIONS,
  EDGE_LAYERS,
  normalizeFilters,
  normalizeHops,
  type EdgeAction,
  type EdgeLayer,
} from '../../domain/graph/index.js';
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

  registerIngestRoutes(app, ctx);
  registerItemRoutes(app, ctx);
  registerGraphRoutes(app, ctx);
  registerEdgeRoutes(app, ctx);
}

/** 資料根還沒好的時候一律回那個原因，**不是回一個空清單**（REQ-0001）。 */
async function requireDataRoot(ctx: AppContext, reply: FastifyReply): Promise<string | null> {
  if (ctx.dataRoot !== null) return ctx.dataRoot;
  await send(reply, await resolveDataRootOrExplain());
  return null;
}

/**
 * 檔名從標頭取出來。
 *
 * **一定要 decode**：中文檔名在 HTTP 標頭裡是 percent-encoded 的。
 * 而 `decodeURIComponent` 對半截的 `%` 會丟例外 —— 那時退回原字串，
 * 因為一個名字奇怪的檔案還是可以匯入，而一個 500 不行。
 */
function decodeFileName(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function registerIngestRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Params: { slug: string }; Body: { urls?: unknown } }>(
    '/api/cases/:slug/import/urls',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;

      const raw = req.body?.urls;
      const urls = Array.isArray(raw)
        ? raw.map((u) => String(u).trim()).filter((u) => u.length > 0)
        : typeof raw === 'string'
          ? raw
              .split(/[\s,]+/)
              .map((u) => u.trim())
              .filter((u) => u.length > 0)
          : [];

      return send(reply, await startUrlImport(dataRoot, req.params.slug, urls));
    },
  );

  app.post<{ Params: { slug: string } }>('/api/cases/:slug/import/file', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;

    // 檔名走標頭而不是 body —— body 整個都是檔案內容。
    const fileName = decodeFileName(req.headers['x-file-name']);
    if (fileName.trim().length === 0) {
      return reply.code(400).send({ ok: false, code: 'FETCH_BAD_URL' });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      return reply.code(400).send({ ok: false, code: 'PARSE_EMPTY_CONTENT' });
    }

    return send(reply, await importFile(dataRoot, req.params.slug, fileName, new Uint8Array(body)));
  });

  app.get<{ Params: { slug: string } }>('/api/cases/:slug/runs', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    return send(reply, await listRuns(dataRoot, req.params.slug));
  });

  app.get<{ Params: { slug: string; runId: string } }>(
    '/api/cases/:slug/runs/:runId',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await getRun(dataRoot, req.params.slug, req.params.runId));
    },
  );

  app.post<{ Params: { slug: string; runId: string } }>(
    '/api/cases/:slug/runs/:runId/cancel',
    async (req, reply) => send(reply, cancelRun(req.params.runId)),
  );

  /**
   * SSE：逐項進度、節流狀態、目前在做什麼。
   *
   * **`reply.hijack()` 是必要的** —— 不呼叫的話 Fastify 會在 handler 結束時
   * 自己送一份回應，而我們要的是一條開著的串流。
   */
  app.get<{ Params: { slug: string; runId: string } }>(
    '/api/cases/:slug/runs/:runId/events',
    (req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const channel = channelOf(req.params.runId);
      if (channel === null) {
        // 作業已經結束了 —— 送一個結束事件就好，讓前端改去讀 `/runs/:id`。
        reply.raw.write('event: closed\ndata: {}\n\n');
        reply.raw.end();
        return;
      }

      const unsubscribe = channel.subscribe((event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'settled') reply.raw.end();
      });
      req.raw.on('close', unsubscribe);
    },
  );
}

/** 子圖查詢的參數在兩支端點上完全一樣 —— **一樣就只解析一次**。 */
interface SubgraphQuerystring {
  focus?: string;
  hops?: string;
  layers?: string;
  status?: string;
  minConfidence?: string;
  types?: string;
  since?: string;
  until?: string;
  projection?: string;
}

function parseSubgraphQuery(q: SubgraphQuerystring): SubgraphQuery {
  /**
   * **只有 `minToExpand` 可調，`minToDraw` 沒有暴露出來。**
   *
   * 不是漏掉的：一個只被 1 份文件提到的實體，攤平出來是
   * *n(n−1)/2* = 0 條線 —— **它畫成「線」跟畫成「純屬性」在畫面上一模一樣**。
   * 給一個改了什麼都不會變的旋鈕，比不給更糟。
   */
  const expand = Number(q.projection);
  const thresholds = Number.isInteger(expand)
    ? { minToDraw: DEFAULT_PROJECTION_THRESHOLDS.minToDraw, minToExpand: expand }
    : DEFAULT_PROJECTION_THRESHOLDS;

  return {
    focus: typeof q.focus === 'string' && q.focus.length > 0 ? q.focus : null,
    hops: normalizeHops(q.hops),
    filters: normalizeFilters(q),
    thresholds,
  };
}

function registerGraphRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * 打開分頁時的起點。**它回一個焦點，不回一張圖** ——
   * 前端沒有東西可以當 `focus`，而 `focus` 是必填的（ADR-0008）。
   */
  app.get<{ Params: { slug: string } }>('/api/cases/:slug/subgraph/focus', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    return send(reply, await defaultFocus(dataRoot, req.params.slug));
  });

  /**
   * **只數不拉資料。** 工具列的跳數格在使用者按下去之前就顯示代價，
   * 所以它的效能預算是 50 ms（Stage 13 量測）。
   *
   * 這一條要放在 `/subgraph` 前面登記嗎？不用 —— Fastify 的路由樹
   * 對靜態片段（`size`）與參數的優先順序是確定的，而這兩條路徑不重疊。
   */
  app.get<{ Params: { slug: string }; Querystring: SubgraphQuerystring }>(
    '/api/cases/:slug/subgraph/size',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(
        reply,
        await subgraphSize(dataRoot, req.params.slug, parseSubgraphQuery(req.query)),
      );
    },
  );

  app.get<{ Params: { slug: string }; Querystring: SubgraphQuerystring }>(
    '/api/cases/:slug/subgraph',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await subgraph(dataRoot, req.params.slug, parseSubgraphQuery(req.query)));
    },
  );
}

/**
 * 關聯與裁決（Stage 8）。
 *
 * **沒有「機器提出一條邊」的端點。** 那條路只有擴展作業走得到，
 * 而擴展是從 `POST …/runs` 進來的（Stage 9）——
 * 開一個公開的寫入端點等於給了一條繞過墓碑與出處要求的路。
 */
function registerEdgeRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** 還在等人判斷的。**只有具名關係**（ADR-0015）。 */
  app.get<{ Params: { slug: string } }>('/api/cases/:slug/queue', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    return send(reply, await listQueue(dataRoot, req.params.slug));
  });

  app.get<{ Params: { slug: string; edgeId: string } }>(
    '/api/cases/:slug/edges/:edgeId',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await getEdge(dataRoot, req.params.slug, req.params.edgeId));
    },
  );

  app.post<{
    Params: { slug: string };
    Body: { source?: unknown; target?: unknown; rel?: unknown; layer?: unknown };
  }>('/api/cases/:slug/edges', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;

    const source = typeof req.body?.source === 'string' ? req.body.source : '';
    const target = typeof req.body?.target === 'string' ? req.body.target : '';
    if (source.length === 0 || target.length === 0) {
      return reply.code(404).send({ ok: false, code: 'GRAPH_NODE_NOT_FOUND' });
    }

    /**
     * **層預設是具名關係。** 手動連一條線的意思幾乎一定是
     * 「我主張這兩份之間有這個關係」，而那就是 `named` 的定義。
     * 另外三層要明講 —— 例如「這篇是那篇的轉載」就是 `derived`。
     */
    const raw = req.body?.layer;
    const layer: EdgeLayer =
      typeof raw === 'string' && (EDGE_LAYERS as readonly string[]).includes(raw)
        ? (raw as EdgeLayer)
        : 'named';
    const rel = typeof req.body?.rel === 'string' ? req.body.rel : '';

    return send(reply, await createEdge(dataRoot, req.params.slug, { source, target, rel, layer }));
  });

  /** **六條轉移都走這一個端點**（api-contract）。 */
  app.post<{ Params: { slug: string; edgeId: string }; Body: { action?: unknown } }>(
    '/api/cases/:slug/edges/:edgeId/transition',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;

      const raw = req.body?.action;
      if (typeof raw !== 'string' || !(EDGE_ACTIONS as readonly string[]).includes(raw)) {
        // 連動作名稱都不認得 —— 這是請求本身壞掉，不是狀態機的問題
        return reply.code(409).send({ ok: false, code: 'GRAPH_TRANSITION_INVALID' });
      }
      return send(
        reply,
        await transitionEdge(dataRoot, req.params.slug, req.params.edgeId, raw as EdgeAction),
      );
    },
  );
}

function registerItemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{
    Params: { slug: string };
    Querystring: {
      sort?: string;
      cursor?: string;
      limit?: string;
      status?: string;
      low?: string;
      unread?: string;
    };
  }>('/api/cases/:slug/items', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;

    const q = req.query;
    return send(
      reply,
      await listItems(dataRoot, req.params.slug, {
        sort: q.sort === 'title' ? 'title' : 'recent',
        ...(q.limit === undefined ? {} : { limit: Number(q.limit) }),
        cursor: q.cursor,
        status: q.status as ItemStatus | undefined,
        lowConfidenceOnly: q.low === '1',
        unreadOnly: q.unread === '1',
      }),
    );
  });

  app.get<{ Params: { slug: string; itemId: string } }>(
    '/api/cases/:slug/items/:itemId',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await getItem(dataRoot, req.params.slug, req.params.itemId));
    },
  );

  app.get<{ Params: { slug: string; itemId: string } }>(
    '/api/cases/:slug/items/:itemId/content',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await getItemContent(dataRoot, req.params.slug, req.params.itemId));
    },
  );

  /**
   * 原始快照。**這一條不回信封，回的是位元組本身** ——
   * 它是「看原始快照」那個按鈕要開的東西，瀏覽器要能直接顯示它。
   */
  app.get<{ Params: { slug: string; itemId: string } }>(
    '/api/cases/:slug/items/:itemId/snapshot',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;

      const result = await getSnapshot(dataRoot, req.params.slug, req.params.itemId);
      if (!result.ok) return send(reply, result);

      // **快照是外部來的 HTML。** 直接以 text/html 送出去，它就會在
      // `127.0.0.1:7433` 這個 origin 上執行自己的腳本，而那個 origin 有我們的 API。
      // 所以：擋掉腳本、擋掉外連、而且不讓它被當成 HTML 之外的東西嗅探。
      return reply
        .code(200)
        .header('content-type', result.data.mime)
        .header('x-content-type-options', 'nosniff')
        .header(
          'content-security-policy',
          "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
        )
        .send(result.data.bytes);
    },
  );

  app.post<{ Params: { slug: string; itemId: string }; Body: { read?: unknown } }>(
    '/api/cases/:slug/items/:itemId/read',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      const read = req.body?.read !== false;
      return send(reply, await markRead(dataRoot, req.params.slug, req.params.itemId, read));
    },
  );

  for (const action of ['exclude', 'restore'] as const) {
    app.post<{ Params: { slug: string; itemId: string } }>(
      `/api/cases/:slug/items/:itemId/${action}`,
      async (req, reply) => {
        const dataRoot = await requireDataRoot(ctx, reply);
        if (dataRoot === null) return reply;
        return send(
          reply,
          await changeItemStatus(dataRoot, req.params.slug, req.params.itemId, action),
        );
      },
    );
  }

  /** 重試 ＝ 把同一個 URL 再送一次匯入。**不產生第二個節點**（REQ-0003）。 */
  app.post<{ Params: { slug: string; itemId: string } }>(
    '/api/cases/:slug/items/:itemId/retry',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;

      const url = await urlForRetry(dataRoot, req.params.slug, req.params.itemId);
      if (!url.ok) return send(reply, url);
      return send(reply, await startUrlImport(dataRoot, req.params.slug, [url.data]));
    },
  );
}
