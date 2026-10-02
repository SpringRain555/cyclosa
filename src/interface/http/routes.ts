/**
 * Fastify 路由。
 *
 * **route 只做三件事**：解析請求 → 呼叫 application 的 service → 對映錯誤。
 * **業務規則不寫在這裡**（分層規則，由 tests/guards 守著）。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

import { httpStatusOf } from '../../domain/errors/codes.js';
import type { ItemStatus } from '../../domain/ingest/state.js';
import {
  changeCaseStatus,
  createCase,
  deleteCase,
  listCases,
  renameCase,
} from '../../application/case-service.js';
import {
  initDataRoot,
  moveDataRoot,
  resolveDataRootOrExplain,
  resolveOrCreateDataRoot,
} from '../../application/bootstrap-service.js';
import { createSampleCase } from '../../application/sample-service.js';
import {
  cancelRun,
  channelOf,
  startFileImport,
  uploadImportFile,
  pauseRun,
  resumeRun,
  startUrlImport,
} from '../../application/ingest-service.js';
import { undoRun } from '../../application/undo-service.js';
import { listCaseNotices, dismissCaseNotice } from '../../application/notice-service.js';
import { activeCount } from '../../application/run-registry.js';
import { describeFetchPolicy } from '../../application/fetch-policy.js';
import { shutdownSequence, targetOf } from './shutdown.js';
import { logger } from '../../shared/log.js';
import {
  changeItemStatus,
  clearAllRead,
  getItem,
  getItemContent,
  getSnapshot,
  listItems,
  markRead,
  urlForRetry,
} from '../../application/item-service.js';
import { discardDraftRun, getRun, listRuns } from '../../application/run-service.js';
import { chooseAngles, startExpansion } from '../../application/expand-service.js';
import {
  abandonResearch,
  converse,
  deleteResearch,
  editDirections,
  getResearchView,
  listResearchViews,
  startCollecting,
  startResearch,
  type DirectionInput,
} from '../../application/research-service.js';
import {
  finishCollecting,
  markCandidateUnavailable,
  reopenCandidate,
  resumeCollecting,
  uploadCandidate,
} from '../../application/research-collect.js';
import {
  listModelsFor,
  listProviders,
  saveProviders,
  testProvider,
} from '../../application/provider-service.js';
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
import { backfillVectors } from '../../application/embed-service.js';
import { rebuildDerived } from '../../application/rebuild-service.js';
import { exportEvidence } from '../../application/export-service.js';
import { searchCase, type SearchMode } from '../../application/search-service.js';
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

  /**
   * **前端每次進清單頁第一個打的就是這一支**，所以自動建立掛在這裡 ——
   * 啟動時建失敗（磁碟滿了、剛好沒權限）之後，重新整理一次就會再試。
   *
   * 底下其他端點的 `resolveDataRootOrExplain` **刻意不換成這一支**：
   * 那些地方要的是「說出為什麼不能服務你」，
   * 而「順手建一個資料根」不該是查一份專題清單的副作用。
   */
  app.get('/api/system/data-root', async (_req, reply) => {
    const r = await resolveOrCreateDataRoot();
    if (r.ok) ctx.dataRoot = r.data.dataRoot;
    return send(reply, r);
  });

  /**
   * 對外抓取的規矩，給畫面上那一列用。**數字從程式讀，不寫死在 i18n 裡** ——
   * 2026-09-13 之前畫面寫著「同網域間隔 3 秒」，與程式的真值只是碰巧相同。
   */
  app.get('/api/system/fetch-policy', async (_req, reply) =>
    reply.code(200).send({ ok: true, data: describeFetchPolicy(), correlationId: 'fetch-policy' }),
  );

  app.post<{ Body: { dataRoot?: unknown } }>('/api/system/data-root', async (req, reply) => {
    const value = req.body?.dataRoot;
    if (typeof value !== 'string' || value.trim().length === 0) {
      return reply.code(400).send({ ok: false, code: 'IO_POINTER_MALFORMED' });
    }
    const r = await initDataRoot(value.trim());
    if (r.ok) ctx.dataRoot = r.data.dataRoot;
    return send(reply, r);
  });

  /**
   * 重建範例專題。
   *
   * 第一次啟動會自動放一份；刪掉之後**不會自己回來**，
   * 而這一支是那個「我想要回來」的明確動作。
   * 已經有一份的時候回 `CASE_NAME_DUPLICATE` —— 重建不該悄悄產生第二份。
   */
  app.post('/api/system/sample', async (_req, reply) => {
    if (ctx.dataRoot === null) return send(reply, await resolveDataRootOrExplain());
    return send(reply, await createSampleCase(ctx.dataRoot));
  });

  /**
   * 換一個資料根，**既有的東西跟著搬過去**。
   *
   * 與上面那一支 `POST` 的差別是「已經有一個」與「還沒有」——
   * 所以這一支要求 `ctx.dataRoot` 不是 `null`，而且它會搬檔案。
   *
   * **有作業在跑時擋下來**：`activeCount()` 在這一層拿，
   * 因為 `run-registry` 是 interface 這一側的東西，
   * 而 application 那一層不該知道有沒有一個 HTTP 伺服器在跑作業。
   */
  app.post<{ Body: { dataRoot?: unknown } }>('/api/system/data-root/move', async (req, reply) => {
    if (ctx.dataRoot === null) return send(reply, await resolveDataRootOrExplain());
    const value = req.body?.dataRoot;
    if (typeof value !== 'string' || value.trim().length === 0) {
      return reply.code(400).send({ ok: false, code: 'IO_DATA_ROOT_TARGET_INVALID' });
    }
    const r = await moveDataRoot(ctx.dataRoot, value.trim(), activeCount());
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

  /**
   * 刪除專題。**兩段式，第二段的門在伺服器端**（比照結束與全部標成未讀）。
   *
   * 沒帶 `confirmName` 只回「你會失去什麼」，一個檔都不動；
   * 帶了就必須逐字對得上。**只在畫面上比對的話，那是一個繞得過的門** ——
   * 而這一顆按鈕刪掉的是蒐集來的東西本身。
   *
   * 用 `POST` 不用 `DELETE`：它要帶一個 body（那個名字），
   * 而 `DELETE` 帶 body 在中介層與快取上是一片灰色地帶。
   */
  app.post<{ Params: { slug: string }; Body: { confirmName?: unknown } }>(
    '/api/cases/:slug/delete',
    async (req, reply) => {
      if (ctx.dataRoot === null) return send(reply, await resolveDataRootOrExplain());
      const raw = req.body?.confirmName;
      const confirmName = typeof raw === 'string' ? raw : null;
      return send(reply, await deleteCase(ctx.dataRoot, req.params.slug, confirmName));
    },
  );

  /**
   * 改名。**名稱與資料夾一起改**（`case-service.ts` 的 `renameCase` 寫了為什麼）。
   *
   * 回的是**新的** `CaseSummary` —— 裡面的 `slug` 已經是新的，
   * 而前端要拿它去換掉網址。少回這一個欄位，改完名之後
   * 使用者按任何一個連結都會 404。
   */
  app.post<{ Params: { slug: string }; Body: { name?: unknown } }>(
    '/api/cases/:slug/rename',
    async (req, reply) => {
      if (ctx.dataRoot === null) return send(reply, await resolveDataRootOrExplain());
      const name = typeof req.body?.name === 'string' ? req.body.name : '';
      return send(reply, await renameCase(ctx.dataRoot, req.params.slug, name));
    },
  );

  /**
   * 結束 Cyclosa。
   *
   * ## 兩段式，而且第二段的門在伺服器端
   *
   * 沒帶 `force` 的呼叫**什麼都不做**，只回「現在有幾個作業在跑」——
   * 畫面拿那個數字去問使用者。帶了 `force` 才真的關。
   *
   * 把二次確認只做在前端的話，它就是一個可以被繞過的提醒；
   * 而**這顆按鈕會讓正在跑的抓取中斷**，那不是一個提醒等級的後果。
   *
   * ## 為什麼是 `POST` 而且沒有 `GET` 版本
   *
   * 一個 `GET` 會被瀏覽器預抓、被書籤、被歷史記錄重播 ——
   * 而它的效果是「關掉這個程式」。
   *
   * ## 瀏覽器關掉分頁**不會**走到這裡
   *
   * 那是刻意的：你可能開了兩個分頁，也可能是誤關，
   * 而 `beforeunload` 本來就不保證送得出去。**關掉程式要是一個明確的動作。**
   */
  app.post<{ Body: { force?: unknown } }>('/api/system/shutdown', async (req, reply) => {
    const running = activeCount();
    // **沒帶 `force` 一律只回狀態，即使沒有作業在跑。**
    //
    // 第一版是「沒作業就直接關」，而那讓確認變成一件可選的事：
    // 使用者按一下就沒了，連問都沒問。而**這顆按鈕的後果與有沒有作業無關** ——
    // 它關掉的是那個正在服務這個分頁的東西。
    if (req.body?.force !== true) {
      return reply.code(200).send({
        ok: true,
        data: { activeRuns: running, shuttingDown: false },
        correlationId: 'shutdown',
      });
    }
    void reply.code(200).send({
      ok: true,
      data: { activeRuns: running, shuttingDown: true },
      correlationId: 'shutdown',
    });
    /**
     * **關閉序列在 `shutdown.ts`，而且它是一個可以單獨測的函式。**
     *
     * 這裡曾經是 `setTimeout(100) → app.close() → exit(0)`，而那在
     * 「正在看一個執行中的作業」的時候**永遠不會走到 `exit`** ——
     * 開著的 SSE 進度通道走 `reply.hijack()`，Fastify 預設收不掉它。
     * 那正是二次確認對話框在講的那個情境。詳見 `shutdown.ts` 的檔頭。
     */
    void shutdownSequence(targetOf(app)).then((outcome) => {
      logger.info('關閉序列完成', { ...outcome });
      process.exit(0);
    });
    return reply;
  });

  registerProviderRoutes(app, ctx);
  registerIngestRoutes(app, ctx);
  registerExpandRoutes(app, ctx);
  registerResearchRoutes(app, ctx);
  registerItemRoutes(app, ctx);
  registerGraphRoutes(app, ctx);
  registerEdgeRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerExportRoutes(app, ctx);
}

/**
 * provider。
 *
 * **這一組不需要資料根**（除了 agent 的實測，它要一個工作目錄）——
 * provider 設定是這台機器的事實，跟資料放哪無關。
 */
function registerProviderRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/providers', async (_req, reply) => send(reply, await listProviders()));

  app.post<{ Body: unknown }>('/api/providers', async (req, reply) =>
    send(reply, await saveProviders(req.body)),
  );

  // **逐任務**（v0.24.0）：測的是那個任務實際會跑的那一支，不是某個角色的預設。
  app.post<{ Body: { task?: unknown } }>('/api/providers/test', async (req, reply) => {
    const task = req.body?.task;
    if (typeof task !== 'string') {
      return reply.code(400).send({ ok: false, code: 'PROVIDER_NOT_CONFIGURED' });
    }
    return send(reply, await testProvider(ctx.dataRoot, task));
  });

  /**
   * 「儲存並檢查」列模型那一步：**這一支不存檔就列**。填了位址（與金鑰變數）之後按那顆，
   * 畫面才有東西可以做成下拉選單 —— 存了才列的話會先出現一個空的選單。
   */
  app.post<{ Params: { kind: string }; Body: unknown }>(
    '/api/providers/connections/:kind/models',
    async (req, reply) => send(reply, await listModelsFor(req.params.kind, req.body)),
  );
}

/**
 * 擴展。**兩支端點，中間有一個人。**
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

/**
 * 研究（ADR-0033）：規劃與閘門一（Stage 19）、蒐集與閘門二（Stage 20）。
 *
 * 路由只做「解析請求 → 呼叫 service → 對映錯誤」—— 規則一條都不在這裡
 * （可不可以再談、閘門按不按得下去、哪一列可以上傳在 `domain/research`）。
 */
function registerResearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Params: { slug: string } }>('/api/cases/:slug/research', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    return send(reply, await listResearchViews(dataRoot, req.params.slug));
  });

  app.post<{ Params: { slug: string }; Body: { topic?: unknown } }>(
    '/api/cases/:slug/research',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      const topic = typeof req.body?.topic === 'string' ? req.body.topic : '';
      return send(reply, await startResearch(dataRoot, req.params.slug, { topic }));
    },
  );

  app.get<{ Params: { slug: string; researchId: string } }>(
    '/api/cases/:slug/research/:researchId',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await getResearchView(dataRoot, req.params.slug, req.params.researchId));
    },
  );

  /** 談一輪。**這一支會花錢** —— 畫面上那句話在閘門旁邊先說過了。 */
  app.post<{ Params: { slug: string; researchId: string }; Body: { said?: unknown } }>(
    '/api/cases/:slug/research/:researchId/messages',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      const said = typeof req.body?.said === 'string' ? req.body.said : '';
      return send(reply, await converse(dataRoot, req.params.slug, req.params.researchId, said));
    },
  );

  /** 改方向（整份換掉）。**不花錢** —— 這是人自己改的。 */
  app.put<{ Params: { slug: string; researchId: string }; Body: { directions?: unknown } }>(
    '/api/cases/:slug/research/:researchId/directions',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      const raw = req.body?.directions;
      const list = Array.isArray(raw) ? (raw as DirectionInput[]) : [];
      return send(
        reply,
        await editDirections(dataRoot, req.params.slug, req.params.researchId, list),
      );
    },
  );

  /** 閘門一。 */
  app.post<{ Params: { slug: string; researchId: string } }>(
    '/api/cases/:slug/research/:researchId/start',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await startCollecting(dataRoot, req.params.slug, req.params.researchId));
    },
  );

  app.post<{ Params: { slug: string; researchId: string } }>(
    '/api/cases/:slug/research/:researchId/abandon',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await abandonResearch(dataRoot, req.params.slug, req.params.researchId));
    },
  );

  // ── 蒐集（Stage 20）──────────────────────────────────────

  /** 繼續蒐集：開一筆新的作業，只做還沒做完的（R13）。**搜尋那一段會花錢。** */
  app.post<{ Params: { slug: string; researchId: string } }>(
    '/api/cases/:slug/research/:researchId/collect',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await resumeCollecting(dataRoot, req.params.slug, req.params.researchId));
    },
  );

  /** 閘門二「完成蒐集」：之後不再找、不再抓（R12）。 */
  app.post<{ Params: { slug: string; researchId: string } }>(
    '/api/cases/:slug/research/:researchId/finish',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await finishCollecting(dataRoot, req.params.slug, req.params.researchId));
    },
  );

  /**
   * 把你拿到的檔案對回一列候選（R10）。**跟批次匯入的逐檔上傳同一種請求**：
   * body 整個是檔案內容，檔名走 `x-file-name` 標頭。
   */
  app.post<{ Params: { slug: string; researchId: string; candidateId: string } }>(
    '/api/cases/:slug/research/:researchId/candidates/:candidateId/upload',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      const fileName = decodeFileName(req.headers['x-file-name']);
      if (fileName.trim().length === 0) {
        return reply.code(400).send({ ok: false, code: 'FETCH_BAD_URL' });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.byteLength === 0) {
        return reply.code(400).send({ ok: false, code: 'PARSE_EMPTY_CONTENT' });
      }
      return send(
        reply,
        await uploadCandidate(
          dataRoot,
          req.params.slug,
          req.params.researchId,
          req.params.candidateId,
          { name: fileName, bytes: new Uint8Array(body) },
        ),
      );
    },
  );

  /** 你說拿不到，而且說了原因（R11）。 */
  app.post<{
    Params: { slug: string; researchId: string; candidateId: string };
    Body: { reason?: unknown; note?: unknown };
  }>(
    '/api/cases/:slug/research/:researchId/candidates/:candidateId/unavailable',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(
        reply,
        await markCandidateUnavailable(
          dataRoot,
          req.params.slug,
          req.params.researchId,
          req.params.candidateId,
          { reason: req.body?.reason, note: req.body?.note },
        ),
      );
    },
  );

  /** 標錯了 —— 改回「要你拿」。 */
  app.post<{ Params: { slug: string; researchId: string; candidateId: string } }>(
    '/api/cases/:slug/research/:researchId/candidates/:candidateId/reopen',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(
        reply,
        await reopenCandidate(
          dataRoot,
          req.params.slug,
          req.params.researchId,
          req.params.candidateId,
        ),
      );
    },
  );

  app.delete<{ Params: { slug: string; researchId: string } }>(
    '/api/cases/:slug/research/:researchId',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await deleteResearch(dataRoot, req.params.slug, req.params.researchId));
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

  app.post<{ Params: { slug: string }; Body: { names?: unknown } }>(
    '/api/cases/:slug/import/files',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      const names = req.body?.names;
      if (
        !Array.isArray(names) ||
        !names.every((name): name is string => typeof name === 'string')
      ) {
        return reply.code(400).send({ ok: false, code: 'SEARCH_QUERY_EMPTY' });
      }
      return send(reply, await startFileImport(dataRoot, req.params.slug, names));
    },
  );

  app.post<{ Params: { slug: string; runId: string; runItemId: string } }>(
    '/api/cases/:slug/import/files/:runId/:runItemId',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;

      // 檔名走標頭而不是 body —— body 整個都是檔案內容。
      const fileName = decodeFileName(req.headers['x-file-name']);
      if (fileName.trim().length === 0) {
        return reply.code(400).send({ ok: false, code: 'FETCH_BAD_URL' });
      }

      const body = req.body;
      if (!Buffer.isBuffer(body)) {
        return reply.code(400).send({ ok: false, code: 'PARSE_EMPTY_CONTENT' });
      }

      return send(
        reply,
        await uploadImportFile(
          dataRoot,
          req.params.slug,
          req.params.runId,
          req.params.runItemId,
          fileName,
          new Uint8Array(body),
        ),
      );
    },
  );

  app.get<{ Params: { slug: string } }>('/api/cases/:slug/notices', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    return send(reply, await listCaseNotices(dataRoot, req.params.slug));
  });

  app.post<{ Params: { slug: string; noticeId: string } }>(
    '/api/cases/:slug/notices/:noticeId/dismiss',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await dismissCaseNotice(dataRoot, req.params.slug, req.params.noticeId));
    },
  );

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
   * 丟掉一筆還沒開始的擴展草稿。**只有 `queued` 的 expand 刪得掉** ——
   * 跑過的作業留著（要拿掉它寫的東西是「復原」，另一支端點）。
   */
  app.delete<{ Params: { slug: string; runId: string } }>(
    '/api/cases/:slug/runs/:runId',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await discardDraftRun(dataRoot, req.params.slug, req.params.runId));
    },
  );

  /**
   * 暫停與續跑。
   *
   * **暫停不是取消**：正在做的那一項會做完，然後停在項與項之間。
   * 中途砍掉正在抓的那一項會留下一個抓了一半的快照 ——
   * 而那正是「取消時已寫入的保留」在保護的東西。
   */
  app.post<{ Params: { slug: string; runId: string } }>(
    '/api/cases/:slug/runs/:runId/pause',
    async (req, reply) => send(reply, pauseRun(req.params.runId)),
  );

  app.post<{ Params: { slug: string; runId: string } }>(
    '/api/cases/:slug/runs/:runId/resume',
    async (req, reply) => send(reply, resumeRun(req.params.runId)),
  );

  /**
   * 復原這次作業。**跟取消是兩件事**（`undo-service.ts` 的檔頭寫了為什麼）——
   * 取消是「別再做下去了」，復原是「剛剛那一整批，當作沒發生」。
   *
   * **不碰 `sources\`，也不碰人的判定。**
   */
  app.post<{ Params: { slug: string; runId: string } }>(
    '/api/cases/:slug/runs/:runId/undo',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await undoRun(dataRoot, req.params.slug, req.params.runId));
    },
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
   * 所以它的效能預算是 50 ms（v0.12.0 量測）。
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
 * 關聯與裁決。
 *
 * **沒有「機器提出一條邊」的端點。** 那條路只有擴展作業走得到，
 * 而擴展是從 `POST …/runs` 進來的——
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

  /**
   * 整個專題全部標成未讀。
   *
   * **`/items/unread-all` 放在 `:itemId` 那幾支的後面是刻意的** ——
   * Fastify 的路由是靜態段優先，不會把 `unread-all` 當成一個 itemId，
   * 但**讀這個檔的人會**，所以它緊接著那一組，而不是散在別的地方。
   *
   * 兩段式，門在伺服器端（形狀同 `/api/system/shutdown`）：
   * 沒帶 `force` 只回「有幾份標著已讀」，帶了才真的清。
   */
  app.post<{ Params: { slug: string }; Body: { force?: unknown } }>(
    '/api/cases/:slug/items/unread-all',
    async (req, reply) => {
      const dataRoot = await requireDataRoot(ctx, reply);
      if (dataRoot === null) return reply;
      return send(reply, await clearAllRead(dataRoot, req.params.slug, req.body?.force === true));
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

  // ── 筆記與點註────────────────────────────────

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
   * **這是 v0.6.0 的驗收條件做成的一顆按鈕**：回的三個數字
   * （對得上／位移／對不上）就是「重算前後差異必須為 0」在畫面上的樣子。
   */
  app.post<{ Params: { slug: string } }>('/api/cases/:slug/rebuild', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    return send(reply, await rebuildDerived(dataRoot, req.params.slug));
  });

  /**
   * 補上還沒有向量的資料。**一次一批，回報還剩幾份。**
   *
   * **不是 `run`**，理由寫在 `embed-service` 檔頭：它的續跑點就是查詢本身，
   * 所以「取消」與「復原」對它沒有意義 —— 而一個假的取消按鈕比沒有更糟。
   * 呼叫端看 `remaining` 決定要不要再打一次。
   */
  app.post<{ Params: { slug: string } }>('/api/cases/:slug/embed', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    return send(reply, await backfillVectors(dataRoot, req.params.slug));
  });

  // ── 來源網站───────────────────────────────

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
      return send(reply, await saveSource({ ...raw, host: raw.host } as SourceInput, ctx.dataRoot));
    },
  );

  app.delete<{ Params: { host: string } }>('/api/sources/:host', async (req, reply) =>
    send(reply, await removeSource(req.params.host, ctx.dataRoot)),
  );

  /** 檢查。**走的是同一條擷取管線** —— robots、同網域間隔、429／503 退避重試。 */
  app.post<{ Body: { hosts?: unknown } }>('/api/sources/check', async (req, reply) => {
    const raw = req.body?.hosts;
    const hosts = Array.isArray(raw) ? raw.map((h) => String(h)) : null;
    return send(reply, await probeSources(ctx.dataRoot, hosts));
  });

  // ── 實體對齊───────────────────────────────

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

/**
 * 證據包匯出。
 *
 * **參數跟子圖那兩支一模一樣**，因為「選一塊子圖」的意思就是
 * 「你現在看到的那一塊」—— 換一組參數就等於換了一塊，
 * 而那時匯出的東西跟畫面上的對不起來。
 *
 * 走 `POST` 不是 `GET`：它**會在磁碟上產生檔案**，
 * 而一個會產生東西的動作不該長得像一次讀取（可以被預抓、被快取、被重試）。
 */
/**
 * 檢索。**`GET`，而且只有一支** —— 全文與語意是同一個端點的兩個 `mode`。
 *
 * 分成兩支的話，前端要自己決定「這次要問哪一支」，
 * 而那個決定的依據（有沒有嵌入模型）在伺服器這一邊。
 *
 * **拿不到向量時**（沒設模型、Ollama 沒開、模型被 `ollama rm` 掉）：
 * `mode=semantic`／`hybrid` 拿到全文的結果加一條 `SEARCH_EMBED_UNAVAILABLE`
 * 的 notice —— 照 `api-contract.md` 那一行（「語意不可用時全文照常回」）。
 * **不假裝跑過語意，也不整個失敗。**
 */
function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{
    Params: { slug: string };
    Querystring: { q?: string; mode?: string; limit?: string };
  }>('/api/cases/:slug/search', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    const raw = req.query.mode;
    const mode: SearchMode = raw === 'semantic' || raw === 'hybrid' ? raw : 'text';
    const limit = Number(req.query.limit);
    return send(
      reply,
      await searchCase(dataRoot, req.params.slug, {
        q: req.query.q ?? '',
        mode,
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      }),
    );
  });
}

function registerExportRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{
    Params: { slug: string };
    Body: SubgraphQuerystring & { nodeIds?: unknown };
  }>('/api/cases/:slug/export/evidence', async (req, reply) => {
    const dataRoot = await requireDataRoot(ctx, reply);
    if (dataRoot === null) return reply;
    const body = req.body ?? {};
    const raw = body.nodeIds;
    return send(
      reply,
      await exportEvidence(dataRoot, req.params.slug, {
        ...parseSubgraphQuery(body),
        // **`null` 與 `[]` 不一樣**：沒送就是整塊，送了一個空陣列是「一個都沒選」。
        nodeIds: Array.isArray(raw) ? raw.map((id) => String(id)) : null,
      }),
    );
  });
}
