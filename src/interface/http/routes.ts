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
import { chooseAngles, startExpansion } from '../../application/expand-service.js';
import { listProviders, saveProviders, testProvider } from '../../application/provider-service.js';
import {
  defaultFocus,
  subgraph,
  subgraphSize,
  type SubgraphQuery,
} from '../../application/graph-service.js';
import { createEdge, getEdge, listQueue, transitionEdge } from '../../application/edge-service.js';
import {
  createNote,
  deleteNote,
  listAllNotes,
  listNotesForItem,
  updateNote,
} from '../../application/note-service.js';
import { rebuildDerived } from '../../application/rebuild-service.js';
import {
  listSources,
  probeSources,
  removeSource,
  saveSource,
  type SourceInput,
} from '../../application/source-service.js';
import {
  listMergeCandidates,
  mergeEntity,
  unmergeEntity,
} from '../../application/entity-service.js';
import { PROVIDER_ROLES, type ProviderRole } from '../../domain/provider/index.js';
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

/** 請求裡的整數。**不是整數就當作沒送** —— 不四捨五入、不轉型。 */
function intOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

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

  registerProviderRoutes(app, ctx);
  registerIngestRoutes(app, ctx);
  registerExpandRoutes(app, ctx);
  registerItemRoutes(app, ctx);
  registerGraphRoutes(app, ctx);
  registerEdgeRoutes(app, ctx);
}

/**
 * provider（Stage 9）。
 *
 * **這一組不需要資料根**（除了 agent 的實測，它要一個工作目錄）——
 * provider 設定是這台機器的事實，跟資料放哪無關。
 */
function registerProviderRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/providers', async (_req, reply) => send(reply, await listProviders()));

  app.post<{ Body: unknown }>('/api/providers', async (req, reply) =>
    send(reply, await saveProviders(req.body)),
  );

  app.post<{ Body: { role?: unknown } }>('/api/providers/test', async (req, reply) => {
    const role = req.body?.role;
    if (typeof role !== 'string' || !(PROVIDER_ROLES as readonly string[]).includes(role)) {
      return reply.code(400).send({ ok: false, code: 'PROVIDER_NOT_CONFIGURED' });
    }
    return send(reply, await testProvider(ctx.dataRoot, role as ProviderRole));
  });
}

/**
 * 擴展（Stage 9）。**兩支端點，中間有一個人。**
 *
 * `POST …/runs` 回的是子問題清單而**不會開始抓** —— 那一步是
 * REQ-0004 的驗收條件（「不是黑箱一次跑完」），不是可以省略的 UI 糖。
 */
function registerExpandRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Params: { slug: string }; Body: { topic?: unknown } }>(
    '/api/cases/:slug/runs',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      const topic = typeof req.body?.topic === 'string' ? req.body.topic : '';
      return send(reply, await startExpansion(dataRoot, req.params.slug, topic));
    },
  );

  app.post<{ Params: { slug: string; runId: string }; Body: { angles?: unknown } }>(
    '/api/cases/:slug/runs/:runId/angles',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      const raw = req.body?.angles;
      const angles = Array.isArray(raw) ? raw.map((a) => String(a)) : [];
      return send(reply, await chooseAngles(dataRoot, req.params.slug, req.params.runId, angles));
    },
  );
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

  // ── 筆記與點註（Stage 10）────────────────────────────────

  /**
   * 建立一則點註。
   *
   * **body 只送位置，不送引文** —— 引文由伺服器從 `derived/` 切出來
   * （`note-service` 開頭那一段）。前端送引文的話，就存得進一則
   * 「引文與位置對不上」的點註，而那種點註在畫面上跟正確的一模一樣。
   */
  app.post<{
    Params: { slug: string; itemId: string };
    Body: {
      body?: unknown;
      start?: unknown;
      end?: unknown;
      page?: unknown;
      rect?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown };
    };
  }>('/api/cases/:slug/items/:itemId/notes', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;

    const raw = req.body ?? {};
    const rect = raw.rect;
    return send(
      reply,
      await createNote(dataRoot, req.params.slug, req.params.itemId, {
        body: typeof raw.body === 'string' ? raw.body : '',
        start: intOrUndefined(raw.start),
        end: intOrUndefined(raw.end),
        page: intOrUndefined(raw.page),
        rect:
          rect === undefined
            ? undefined
            : {
                x: intOrUndefined(rect.x) ?? -1,
                y: intOrUndefined(rect.y) ?? -1,
                w: intOrUndefined(rect.w) ?? -1,
                h: intOrUndefined(rect.h) ?? -1,
              },
      }),
    );
  });

  app.get<{ Params: { slug: string; itemId: string } }>(
    '/api/cases/:slug/items/:itemId/notes',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await listNotesForItem(dataRoot, req.params.slug, req.params.itemId));
    },
  );

  /** 專題全部的點註 —— **一條 SELECT，不是三張表的 UNION**（ADR-0019）。 */
  app.get<{ Params: { slug: string } }>('/api/cases/:slug/notes', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    return send(reply, await listAllNotes(dataRoot, req.params.slug));
  });

  /** 改內容。**錨點不動** —— 改的是你寫的字，不是你標的位置。 */
  app.patch<{ Params: { slug: string; noteId: string }; Body: { body?: unknown } }>(
    '/api/cases/:slug/notes/:noteId',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      const body = typeof req.body?.body === 'string' ? req.body.body : '';
      return send(reply, await updateNote(dataRoot, req.params.slug, req.params.noteId, body));
    },
  );

  app.delete<{ Params: { slug: string; noteId: string } }>(
    '/api/cases/:slug/notes/:noteId',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await deleteNote(dataRoot, req.params.slug, req.params.noteId));
    },
  );

  /**
   * `derived/` 整批重算。
   *
   * **這是 Stage 10 的驗收條件做成的一顆按鈕**：回的三個數字
   * （對得上／位移／對不上）就是「重算前後差異必須為 0」在畫面上的樣子。
   */
  app.post<{ Params: { slug: string } }>('/api/cases/:slug/rebuild', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    return send(reply, await rebuildDerived(dataRoot, req.params.slug));
  });

  // ── 來源網站（Stage 10.5）───────────────────────────────

  /**
   * 來源網站清單。
   *
   * **判斷的主要依據是你自己抓過的結果**（`run_item` 聚合出來的），
   * 不是探測 —— 出版社的首頁一律回 200 而文章回 403，
   * 所以「探測一下這個站」對它們幾乎沒有用。
   */
  app.get('/api/sources', async (_req, reply) => send(reply, await listSources(ctx.dataRoot)));

  app.post<{ Body: Partial<SourceInput> & { host?: unknown } }>(
    '/api/sources',
    async (req, reply) => {
      const raw = req.body ?? {};
      if (typeof raw.host !== 'string') return send(reply, await listSources(ctx.dataRoot));
      return send(reply, await saveSource({ ...raw, host: raw.host } as SourceInput));
    },
  );

  app.delete<{ Params: { host: string } }>('/api/sources/:host', async (req, reply) =>
    send(reply, await removeSource(req.params.host)),
  );

  /** 檢查。**走的是同一條擷取管線** —— robots、同網域間隔、429／503 立刻停。 */
  app.post<{ Body: { hosts?: unknown } }>('/api/sources/check', async (req, reply) => {
    const raw = req.body?.hosts;
    const hosts = Array.isArray(raw) ? raw.map((h) => String(h)) : null;
    return send(reply, await probeSources(ctx.dataRoot, hosts));
  });

  // ── 實體對齊（Stage 10.5）───────────────────────────────

  app.get<{ Params: { slug: string } }>('/api/cases/:slug/entities/merges', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    return send(reply, await listMergeCandidates(dataRoot, req.params.slug));
  });

  /** 合併。**不刪任何一列**，而且動了哪幾條邊記下來 —— 所以取消得掉。 */
  app.post<{ Params: { slug: string }; Body: { keptId?: unknown; mergedId?: unknown } }>(
    '/api/cases/:slug/entities/merge',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      const keptId = String(req.body?.keptId ?? '');
      const mergedId = String(req.body?.mergedId ?? '');
      return send(reply, await mergeEntity(dataRoot, req.params.slug, keptId, mergedId));
    },
  );

  app.post<{ Params: { slug: string; entityId: string } }>(
    '/api/cases/:slug/entities/:entityId/unmerge',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await unmergeEntity(dataRoot, req.params.slug, req.params.entityId));
    },
  );
}
