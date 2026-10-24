/**
 * 抽進圖：**整理的第一片**（ADR-0033 D13 操作表的「抽這幾份」，實作時的決定是 S24-1～S24-5）。
 *
 * 匯入本身不產生任何關聯；研究建圖只抽它自己找來的那幾份。專題裡其餘「還沒抽過」的資料，
 * 由這裡列給人勾、勾了才抽（Q10：預設不勾）。**抽的規則跟研究建圖是同一套**：
 * `callExtract` → `applyExtraction`（實體對齊、`locateQuote`、待查證、墓碑），一條都不另寫。
 *
 * ## 為什麼不開「殼」
 *
 * D13 的整理是研究那個殼（`research.kind='consolidate'`）：先由模型讀專題、交出操作清單。
 * 這一片沒有規劃那一步 —— 哪幾份還沒抽過是資料庫數得出來的事實 —— 所以只開一筆
 * `run.kind='consolidate'` 的作業。代價是 D4（同一個專題同時只有一次研究或整理沒結束）
 * 不能靠資料庫的部分唯一索引守，改成**兩邊互查**：研究沒結束不能抽（這裡），
 * 抽的作業在跑不能開研究（`research-service.ts` 的 `startResearch`）。
 * 兩邊的「查」與「寫」都在同一個同步段落裡，同一個行程裡插不進第二個請求。
 */
import { join } from 'node:path';

import { levelOf, type ErrorCode } from '../domain/errors/codes.js';
import {
  nextRunStatus,
  settleWork,
  workOutcome,
  type RunStatus,
  type WorkOutcome,
} from '../domain/ingest/state.js';
import { chargeTask, type TaskCosts } from '../domain/provider/index.js';
import { isUnextracted } from '../domain/research/index.js';
import { withTransaction, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as research from '../infrastructure/db/repositories/research-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import { readDerived } from '../infrastructure/fs/case-files.js';
import { casesDir } from '../infrastructure/fs/paths.js';
import { reindexTitleRank } from '../infrastructure/index/writer.js';
import { loadProviders, type Providers } from '../infrastructure/providers/registry.js';
import type { ChatProvider } from '../infrastructure/providers/types.js';
import { correlationId, newId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';
import { callExtract, checkExtract } from './extraction-call.js';
import { EXTRACT_SYSTEM, extractUser } from './extraction-prompts.js';
import { executeRetypeOperation } from './consolidate-ops/retype.js';
import * as consolidateOps from '../infrastructure/db/repositories/consolidate-op-repo.js';
import { executeExtractOperation } from './consolidate-ops/extract.js';
import { executeMergeOperation } from './consolidate-ops/merge.js';
import { executeAddEdgeOperation } from './consolidate-ops/add-edge.js';
import { conformsTo } from '../domain/provider/schema-check.js';
import {
  ADD_EDGE_OP_SCHEMA,
  type ConsolidateOpPayloadByKind,
} from '../domain/research/consolidate.js';
import { findByTriple } from '../infrastructure/db/repositories/edge-repo.js';
import { edgeSnapshot } from '../infrastructure/db/repositories/consolidate-edge-undo-repo.js';
import { recordModelCall } from './model-call-log.js';
import {
  bodyAvailable,
  openResearchCase,
  type ProvidersLoader,
  type ServiceView,
} from './research-view.js';
import * as registry from './run-registry.js';

/** 作業紀錄上那一筆的名字。 */
const RUN_LABEL = '抽進圖';

/** 清單上的一份。標題是原文；有初讀過的繁中標題就一起給，畫面跟閱讀器同一套切換。 */
export interface UnextractedItem {
  readonly id: string;
  readonly title: string;
  readonly titleZh: string | null;
  readonly kind: string;
  /** 衍生正文有多少字。抽取只讀開頭 `MAX_TEXT_CHARS`，畫面要說得出哪幾份只讀到一部分。 */
  readonly chars: number;
  readonly createdAt: number;
}

export interface ConsolidateView {
  readonly items: readonly UnextractedItem[];
  /** 走哪一個服務、哪一個模型（「從正文抽實體與關係」那一列）。 */
  readonly extractService: ServiceView;
  /** 這個專題**正在跑的**那一筆「抽進圖」；有的話不能再開一筆。 */
  readonly runId: string | null;
  /** 有一次研究還沒結束（D4）：做完或放棄之前不能抽。 */
  readonly researchOpen: boolean;
}

/** 正在跑的「抽進圖」：資料庫說在跑，**而且就在這個行程裡**（上一次沒收尾的由 `run-sweep` 掃掉）。 */
export function activeConsolidateRun(db: DatabaseSync): string | null {
  return (
    runs.listRunningRunIdsOfKind(db, 'consolidate').find((id) => registry.isActive(id)) ?? null
  );
}

export async function listUnextractedItems(
  db: DatabaseSync,
  folder: string,
): Promise<UnextractedItem[]> {
  const out: UnextractedItem[] = [];
  for (const { item, machineEvidence } of items.listExtractionCandidates(db)) {
    const derived = await readDerived(folder, item.id);
    const facts = {
      kind: item.kind,
      status: item.status,
      extractedAt: item.extractedAt,
      machineEvidence,
      hasBody: bodyAvailable(derived),
    };
    if (!isUnextracted(facts) || derived === null) continue;
    out.push({
      id: item.id,
      title: item.title,
      titleZh: item.titleZh,
      kind: item.kind,
      chars: derived.text.length,
      createdAt: item.createdAt,
    });
  }
  return out;
}

function serviceOf(providers: Providers): ServiceView {
  const setting = providers.config.tasks.extract;
  return { via: setting.via, model: setting.model, costs: setting.via !== 'ollama' };
}

/** 「還沒抽過」的清單，連同現在能不能抽。**不呼叫模型、不花錢。** */
export async function listUnextracted(
  dataRoot: string,
  slug: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ConsolidateView>> {
  const cid = correlationId();
  const db = await openResearchCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    if (readCase(db) === null) return err('CASE_NOT_FOUND', cid, { slug });
    const list = await listUnextractedItems(db, join(casesDir(dataRoot), slug));
    return ok(
      {
        items: list,
        extractService: serviceOf(await load()),
        runId: activeConsolidateRun(db),
        researchOpen: research.openResearch(db) !== null,
      },
      cid,
    );
  } finally {
    db.close();
  }
}

/**
 * 開一筆「抽進圖」。勾的每一份都要還在「還沒抽過」清單上 —— 畫面舊了（別的分頁剛抽過、剛排除）就整批不收，
 * 回 `CONSOLIDATE_SELECTION_INVALID` 叫人重新整理，而不是默默少抽幾份。
 */
export async function startConsolidate(
  dataRoot: string,
  slug: string,
  itemIds: unknown,
  load: ProvidersLoader = loadProviders,
): Promise<Result<{ readonly runId: string }>> {
  const cid = correlationId();
  if (
    !Array.isArray(itemIds) ||
    itemIds.length === 0 ||
    !itemIds.every((id): id is string => typeof id === 'string')
  )
    return err('CONSOLIDATE_SELECTION_INVALID', cid, { why: 'empty' });
  const wanted = [...new Set(itemIds)];
  const folder = join(casesDir(dataRoot), slug);
  const db = await openResearchCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const caseRow = readCase(db);
    if (caseRow === null) return err('CASE_NOT_FOUND', cid, { slug });
    if (caseRow.status === 'archived') return err('CASE_ARCHIVED', cid, { slug });
    const blocked = gate(db, cid);
    if (blocked !== null) return blocked;

    const listed = new Map(
      (await listUnextractedItems(db, folder)).map((entry) => [entry.id, entry]),
    );
    const chosen = wanted.flatMap((id) => {
      const entry = listed.get(id);
      return entry === undefined ? [] : [entry];
    });
    if (chosen.length !== wanted.length)
      return err('CONSOLIDATE_SELECTION_INVALID', cid, {
        why: 'not-listed',
        missing: wanted.length - chosen.length,
      });

    const providers = await load();
    const checked = await checkExtract(providers, cid);
    if (!checked.ok) return checked;

    // **再查一次，跟寫入在同一個同步段落裡**：上面那幾個 `await` 之間，別的請求可能開了研究或另一筆。
    const again = gate(db, cid);
    if (again !== null) return again;
    const runId = newId();
    const plan = chosen.map((entry) => ({
      runItemId: newId(),
      itemId: entry.id,
      title: entry.title,
    }));
    withTransaction(db, () => {
      runs.insertRun(db, {
        id: runId,
        kind: 'consolidate',
        label: RUN_LABEL,
        total: plan.length,
        correlationId: cid,
        now: Date.now(),
        providers: JSON.stringify({
          extract: checked.data.chat.name,
          json: { extract: checked.data.mode },
        }),
      });
      for (const entry of plan)
        runs.insertRunItem(db, {
          id: entry.runItemId,
          runId,
          requested: entry.title,
          host: null,
          itemId: entry.itemId,
        });
    });
    launchConsolidateWorker({ dataRoot, slug, providers, chat: checked.data.chat, runId, plan });
    return ok({ runId }, cid);
  } finally {
    db.close();
  }
}

export type ConsolidateWorkerPlanEntry = {
  readonly runItemId: string;
  readonly title: string;
  readonly opId?: string;
} & (
  | {
      readonly itemId: string;
      readonly addEdge?: ConsolidateOpPayloadByKind['add-edge'];
      readonly merge?: undefined;
      readonly retype?: undefined;
      readonly retypeExpected?: undefined;
    }
  | {
      readonly itemId: null;
      readonly addEdge?: undefined;
      readonly merge: { readonly keep: string; readonly drop: string };
      readonly retype?: undefined;
      readonly retypeExpected?: undefined;
    }
  | {
      readonly itemId: null;
      readonly addEdge?: undefined;
      readonly merge?: undefined;
      readonly retype: import('../domain/research/consolidate.js').ConsolidateOpPayloadByKind['retype'];
      readonly retypeExpected: string;
    }
);

export interface ConsolidateWorkerHooks {
  readonly onItemSettled?: (
    db: DatabaseSync,
    entry: ConsolidateWorkerPlanEntry,
    code: ErrorCode | null,
    outcome: WorkOutcome,
  ) => void;
  readonly onRunSettled?: (db: DatabaseSync, status: RunStatus) => void;
}

/** 啟動共用抽取 worker；整理殼和原本「抽進圖」都走同一支 callExtract/applyExtraction。 */
export function launchConsolidateWorker(input: {
  readonly dataRoot: string;
  readonly slug: string;
  readonly providers: Providers;
  readonly chat: ChatProvider | null;
  readonly runId: string;
  readonly plan: readonly ConsolidateWorkerPlanEntry[];
  readonly hooks?: ConsolidateWorkerHooks;
}): void {
  const state = registry.register(input.runId);
  void processConsolidate(
    input.dataRoot,
    input.slug,
    input.providers,
    input.chat,
    state,
    input.plan,
    input.hooks,
  ).catch((error: unknown) => {
    logger.error('抽進圖作業意外中止', { runId: input.runId, reason: String(error) });
  });
}

/** D4 的兩個方向在這一邊的那一半：研究沒結束、或已經有一筆在跑。 */
function gate(db: DatabaseSync, cid: string): Result<never> | null {
  const open = research.openResearch(db);
  if (open !== null) return err('CONSOLIDATE_RESEARCH_OPEN', cid, { researchId: open.id });
  const running = activeConsolidateRun(db);
  if (running !== null) return err('CONSOLIDATE_RUNNING', cid, { runId: running });
  return null;
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_SQLITE_ERROR' &&
    'errcode' in error &&
    (Number(error.errcode) & 0xff) === 19
  );
}

async function processConsolidate(
  dataRoot: string,
  slug: string,
  providers: Providers,
  chat: ChatProvider | null,
  state: registry.ActiveRun,
  plan: readonly ConsolidateWorkerPlanEntry[],
  hooks?: ConsolidateWorkerHooks,
): Promise<void> {
  let db: DatabaseSync | null = null;
  const outcomes: WorkOutcome[] = [];
  let taskCosts: TaskCosts = {};
  try {
    const opened = await openResearchCase(dataRoot, slug);
    if (typeof opened === 'string') return;
    const activeDb = opened;
    db = activeDb;
    const folder = join(casesDir(dataRoot), slug);
    const abort = new AbortController();
    state.cancellable = { stop: () => abort.abort() };
    runs.startRun(db, state.runId, Date.now());
    state.channel.emit({ type: 'started', runId: state.runId, total: plan.length });

    for (const entry of plan) {
      await state.gate();
      if (state.cancelled) break;
      let trackedItemId =
        entry.itemId === null ? null : (items.getItem(db, entry.itemId)?.id ?? null);
      runs.updateRunItem(db, {
        id: entry.runItemId,
        outcome: 'running',
        itemId: trackedItemId,
        now: Date.now(),
      });
      let code: ErrorCode | null = null;
      let newEdges = 0;
      let merged = false;
      if (entry.merge !== undefined) {
        try {
          const result = await executeMergeOperation({
            dataRoot,
            slug,
            runId: state.runId,
            ...entry.merge,
          });
          if (result.ok) merged = true;
          else
            code = ['GRAPH_NODE_NOT_FOUND', 'GRAPH_TRANSITION_INVALID', 'GRAPH_SELF_EDGE'].includes(
              result.code,
            )
              ? 'CONSOLIDATE_OP_STALE'
              : result.code;
        } catch {
          code = 'CONSOLIDATE_UNEXPECTED';
        }
      } else if (entry.retype !== undefined) {
        try {
          const applied = executeRetypeOperation({
            db,
            ...entry.retype,
            expectedRevision: entry.retypeExpected ?? '',
            completed: (undo) => {
              if (entry.opId === undefined) throw new Error('missing retype operation');
              consolidateOps.setState(activeDb, {
                id: entry.opId,
                state: 'done',
                runId: state.runId,
                undoJson: JSON.stringify(undo),
                executedAt: Date.now(),
              });
            },
          });
          if (!applied) code = 'CONSOLIDATE_OP_STALE';
        } catch (error) {
          code = 'CONSOLIDATE_UNEXPECTED';
          logger.error('改型別寫入失敗', { opId: entry.opId, error: String(error) });
        }
      } else if (entry.addEdge !== undefined) {
        const derived = await readDerived(folder, entry.itemId);
        if (state.cancelled) break;
        trackedItemId = items.getItem(db, entry.itemId)?.id ?? null;
        const payload = entry.addEdge;
        if (
          entry.opId === undefined ||
          derived === null ||
          readCase(db)?.status === 'archived' ||
          !conformsTo(ADD_EDGE_OP_SCHEMA, payload).ok
        ) {
          code = 'CONSOLIDATE_OP_STALE';
        } else {
          const opId = entry.opId;
          try {
            withTransaction(db, () => {
              const existing = findByTriple(activeDb, payload);
              const before = existing === null ? null : edgeSnapshot(activeDb, existing.id);
              const applied = executeAddEdgeOperation({
                db: activeDb,
                itemId: entry.itemId,
                runId: state.runId,
                text: derived.text,
                extraction: {
                  entities: [],
                  relations: [],
                  dropped: { unknownEntity: 0, selfRelation: 0, duplicate: 0 },
                },
                addEdge: payload,
              });
              newEdges = applied.newEdges;
              code = applied.code;
              const written = findByTriple(activeDb, payload);
              consolidateOps.setState(activeDb, {
                id: opId,
                state:
                  code === 'CONSOLIDATE_OP_STALE' || code === 'PROVIDER_QUOTE_NOT_FOUND'
                    ? 'stale'
                    : code === 'GRAPH_TOMBSTONED'
                      ? 'skipped'
                      : 'done',
                code,
                runId: state.runId,
                executedAt: Date.now(),
                undoJson:
                  code === null && written !== null
                    ? JSON.stringify({
                        runId: state.runId,
                        edgeId: written.id,
                        before,
                        after: edgeSnapshot(activeDb, written.id),
                      })
                    : JSON.stringify({ runId: state.runId }),
              });
              runs.updateRunItem(activeDb, {
                id: entry.runItemId,
                outcome: code === 'CONSOLIDATE_OP_STALE' ? 'failed' : 'ok',
                code,
                itemId: trackedItemId,
                now: Date.now(),
              });
              runs.setRunItemEdges(activeDb, entry.runItemId, newEdges);
            });
          } catch (error) {
            if (!isConstraintError(error)) throw error;
            newEdges = 0;
            code = 'CONSOLIDATE_UNEXPECTED';
            consolidateOps.setState(db, {
              id: opId,
              state: 'failed',
              code,
              runId: state.runId,
              executedAt: Date.now(),
            });
            logger.error('整理關聯寫入失敗', { opId, reason: String(error) });
          }
        }
        if (code === 'CONSOLIDATE_OP_STALE' && entry.opId !== undefined)
          consolidateOps.setState(db, {
            id: entry.opId,
            state: 'stale',
            code,
            runId: state.runId,
            executedAt: Date.now(),
          });
      } else {
        if (chat === null) throw new Error('extract provider missing');
        const derived = await readDerived(folder, entry.itemId);
        if (state.cancelled) break;
        // 規劃之後資料可能被抽過、排除或復原；執行前重查「還沒抽過」事實。
        const candidate = items
          .listExtractionCandidates(db)
          .find(({ item }) => item.id === entry.itemId);
        const eligible =
          candidate !== undefined &&
          derived !== null &&
          isUnextracted({
            kind: candidate.item.kind,
            status: candidate.item.status,
            extractedAt: candidate.item.extractedAt,
            machineEvidence: candidate.machineEvidence,
            hasBody: bodyAvailable(derived),
          });
        if (!eligible || readCase(db)?.status === 'archived')
          code = entry.opId === undefined ? 'PARSE_EMPTY_CONTENT' : 'CONSOLIDATE_OP_STALE';
        else {
          const called = await callExtract(chat, derived, abort);
          taskCosts = chargeTask(taskCosts, 'extract', called.costUsd);
          const cost = taskCosts['extract'];
          if (cost === undefined) throw new Error('extract cost missing');
          runs.updateRunBudget(
            db,
            state.runId,
            cost.requests,
            cost.costUsd,
            cost.unpriced,
            taskCosts,
          );
          await recordModelCall(providers, folder, {
            task: 'extract',
            role: 'chat',
            model: chat.name,
            runId: state.runId,
            correlationId: state.runId,
            itemId: entry.itemId,
            system: EXTRACT_SYSTEM,
            user: extractUser(derived.title, derived.text),
            text: called.kind === 'ok' ? JSON.stringify(called.extraction) : null,
            errorDetail: null,
            ok: called.kind === 'ok',
            code: called.kind === 'error' ? called.code : null,
            elapsedMs: called.elapsedMs,
            costUsd: called.costUsd,
          });
          if (state.cancelled) break;
          if (called.kind === 'error') code = called.code;
          else {
            try {
              const applied = executeExtractOperation({
                db,
                itemId: entry.itemId,
                runId: state.runId,
                text: derived.text,
                extraction: called.extraction,
                completed: (result) => {
                  items.setItemExtracted(activeDb, {
                    id: entry.itemId,
                    extractedBy: chat.name,
                    now: Date.now(),
                  });
                  runs.updateRunItem(activeDb, {
                    id: entry.runItemId,
                    outcome: 'ok',
                    code: result.code,
                    itemId: entry.itemId,
                    now: Date.now(),
                  });
                  runs.setRunItemEdges(activeDb, entry.runItemId, result.newEdges);
                },
              });
              newEdges = applied.newEdges;
              code = applied.code;
            } catch (error) {
              if (!isConstraintError(error)) throw error;
              code = 'CONSOLIDATE_UNEXPECTED';
              logger.error('抽進圖寫入失敗', { itemId: entry.itemId, error: String(error) });
            }
          }
        }
      }
      const outcome = workOutcome({
        code,
        fatal: code !== null && levelOf(code) === 'error',
        produced: newEdges > 0 || merged,
      });
      outcomes.push(outcome);
      hooks?.onItemSettled?.(db, entry, code, outcome);
      runs.updateRunItem(db, {
        id: entry.runItemId,
        outcome: outcome === 'failed' ? 'failed' : 'ok',
        code,
        itemId: entry.itemId === null ? null : (items.getItem(db, entry.itemId)?.id ?? null),
        now: Date.now(),
      });
      runs.setRunItemEdges(db, entry.runItemId, newEdges);
      state.channel.emit({
        type: 'item',
        runItemId: entry.runItemId,
        requested: entry.title,
        host: null,
        outcome: outcome === 'failed' ? 'failed' : 'ok',
        code,
        itemId: entry.retype === undefined ? entry.itemId : null,
      });
      state.channel.emit({ type: 'progress', done: outcomes.length, total: plan.length });
    }

    reindexTitleRank(db);
    runs.cancelPendingItems(db, state.runId, Date.now());
    const status = state.cancelled
      ? 'cancelled'
      : (nextRunStatus('running', settleWork(outcomes)) ?? 'failed');
    const succeeded = outcomes.filter((entry) => entry !== 'failed').length;
    const failed = outcomes.length - succeeded;
    runs.settleRunRow(db, {
      id: state.runId,
      status,
      succeeded,
      failed,
      endedReason: state.cancelReason,
      now: Date.now(),
    });
    hooks?.onRunSettled?.(db, status);
    registry.unregister(state.runId);
    state.channel.emit({ type: 'settled', status, succeeded, failed });
  } catch (error) {
    if (db !== null) {
      runs.cancelPendingItems(db, state.runId, Date.now());
      runs.settleRunRow(db, {
        id: state.runId,
        status: 'failed',
        succeeded: outcomes.filter((entry) => entry !== 'failed').length,
        failed: 1,
        errorCode: 'CONSOLIDATE_UNEXPECTED',
        now: Date.now(),
      });
      hooks?.onRunSettled?.(db, 'failed');
    }
    registry.unregister(state.runId);
    state.channel.emit({
      type: 'settled',
      status: 'failed',
      succeeded: outcomes.filter((entry) => entry !== 'failed').length,
      failed: 1,
    });
    throw error;
  } finally {
    registry.unregister(state.runId);
    db?.close();
  }
}
