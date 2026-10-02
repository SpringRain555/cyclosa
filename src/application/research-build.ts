import { join } from 'node:path';
import {
  workOutcome,
  nextRunStatus,
  settleWork,
  type WorkOutcome,
} from '../domain/ingest/state.js';
import { levelOf } from '../domain/errors/codes.js';
import { chargeTask, missingFor, TASK_EXTRACT, type TaskCosts } from '../domain/provider/index.js';
import {
  DECISIONS,
  effectiveDecision,
  mayStartBuilding,
  mayResumeBuilding,
  mayFinishBuilding,
  type Decision,
} from '../domain/research/index.js';
import { withTransaction, type DatabaseSync } from '../infrastructure/db/database.js';
import * as research from '../infrastructure/db/repositories/research-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as edges from '../infrastructure/db/repositories/edge-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import { readDerived } from '../infrastructure/fs/case-files.js';
import { casesDir } from '../infrastructure/fs/paths.js';
import { reindexTitleRank } from '../infrastructure/index/writer.js';
import { loadProviders, type Providers } from '../infrastructure/providers/registry.js';
import type { ChatProvider } from '../infrastructure/providers/types.js';
import { correlationId, newId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';
import { callExtract } from './extraction-call.js';
import { applyExtraction } from './extraction-service.js';
import { EXTRACT_SYSTEM, extractUser } from './extraction-prompts.js';
import { recordModelCall } from './model-call-log.js';
import {
  openResearchCase,
  viewOf,
  type ProvidersLoader,
  type ResearchView,
} from './research-view.js';
import * as registry from './run-registry.js';

export async function editCandidateDecision(
  dataRoot: string,
  slug: string,
  researchId: string,
  candidateId: string,
  input: { decision?: unknown; citedBy?: unknown },
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const db = await openResearchCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    const candidate = research.getCandidate(db, candidateId);
    if (row.status !== 'reviewing' || candidate?.researchId !== researchId)
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status });
    if (
      input.decision !== undefined &&
      input.decision !== null &&
      !DECISIONS.includes(input.decision as Decision)
    )
      return err('RESEARCH_STEP_INVALID', cid);
    const decision =
      input.decision === undefined ? candidate.decision : (input.decision as Decision | null);
    if (
      effectiveDecision({ ...candidate, decision }) === 'include' &&
      !(await hasBody(dataRoot, slug, candidate.itemId))
    )
      return err('RESEARCH_STEP_INVALID', cid, { why: 'no-body' });
    if (
      input.citedBy !== undefined &&
      (!Array.isArray(input.citedBy) ||
        input.citedBy.some(
          (id: unknown) =>
            typeof id !== 'string' || id === candidate.itemId || items.getItem(db, id) === null,
        ))
    )
      return err('RESEARCH_STEP_INVALID', cid);
    const providers = await load();
    if (research.getResearch(db, researchId)?.status !== 'reviewing')
      return err('RESEARCH_STEP_INVALID', cid);
    withTransaction(db, () => {
      research.setCandidateDecision(db, candidateId, decision, Date.now());
      if (input.citedBy !== undefined)
        research.setCandidateCitedBy(
          db,
          candidateId,
          [...new Set(input.citedBy as string[])],
          Date.now(),
        );
    });
    return ok(viewOf(db, row, providers), cid);
  } finally {
    db.close();
  }
}

async function hasBody(dataRoot: string, slug: string, itemId: string | null): Promise<boolean> {
  if (itemId === null) return false;
  const derived = await readDerived(join(casesDir(dataRoot), slug), itemId);
  return derived !== null && derived.text.trim().length > 0;
}

async function checkExtract(
  providers: Providers,
  cid: string,
): Promise<Result<{ chat: ChatProvider; mode: string }>> {
  const who = { role: 'chat', task: 'extract' };
  const chat = providers.chatFor('extract');
  if (chat === null) return err('PROVIDER_NOT_CONFIGURED', cid, who);
  const probe = await chat.probe();
  if (probe.kind === 'not-configured') return err('PROVIDER_NOT_CONFIGURED', cid, who);
  if (probe.kind === 'unreachable')
    return err('PROVIDER_UNREACHABLE', cid, { ...who, at: probe.detail });
  const match = missingFor(TASK_EXTRACT, probe.capabilities);
  if (match.kind === 'missing')
    return err('PROVIDER_CAPABILITY_MISSING', cid, {
      ...who,
      missing: match.flags,
      ...(match.context === null
        ? {}
        : { needContextTokens: match.context[0], haveContextTokens: match.context[1] }),
    });
  let format = await chat.jsonMode();
  if (format.mode === 'unchecked' && chat.checkJson !== undefined) {
    const checked = await chat.checkJson();
    if (checked.kind === 'error') return err(checked.code, cid, who);
    format = checked.value;
  }
  if (format.mode === 'none' || format.mode === 'unchecked')
    return err('PROVIDER_JSON_UNSUPPORTED', cid, who);
  return ok({ chat, mode: format.mode }, cid);
}

export async function startBuilding(
  dataRoot: string,
  slug: string,
  researchId: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const db = await openResearchCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    const candidates = research.listCandidates(db, researchId);
    if (
      !mayStartBuilding(row.status, candidates.map(effectiveDecision)) &&
      !mayResumeBuilding(row.status, row.buildRunId !== null && registry.isActive(row.buildRunId))
    )
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status });
    const providers = await load();
    const checked = await checkExtract(providers, cid);
    if (!checked.ok) return checked;
    for (const candidate of candidates.filter(
      (entry) => entry.buildState !== 'done' && effectiveDecision(entry) === 'include',
    )) {
      if (!(await hasBody(dataRoot, slug, candidate.itemId)))
        return err('RESEARCH_STEP_INVALID', cid, { candidateId: candidate.id, why: 'no-body' });
    }
    const latest = research.getResearch(db, researchId);
    if (
      latest === null ||
      latest.status !== row.status ||
      (latest.buildRunId !== null && registry.isActive(latest.buildRunId)) ||
      JSON.stringify(research.listCandidates(db, researchId)) !== JSON.stringify(candidates)
    )
      return err('RESEARCH_STEP_INVALID', cid);
    const runId = newId();
    withTransaction(db, () => {
      runs.insertRun(db, {
        id: runId,
        kind: 'research',
        label: '建圖',
        total: candidates.filter((entry) => entry.buildState !== 'done').length,
        correlationId: cid,
        now: Date.now(),
        researchId,
        topic: row.topic,
        providers: JSON.stringify({
          extract: checked.data.chat.name,
          json: { extract: checked.data.mode },
        }),
      });
      research.setBuildRun(db, researchId, runId, Date.now());
      research.updateResearchStatus(db, researchId, 'building', Date.now());
    });
    const state = registry.register(runId);
    void processBuild(dataRoot, slug, researchId, providers, checked.data.chat, state).catch(
      (error: unknown) => {
        logger.error('建圖作業意外中止', { runId, reason: String(error) });
      },
    );
    const updated = research.getResearch(db, researchId);
    if (updated === null) return err('RESEARCH_UNEXPECTED', cid);
    return ok(viewOf(db, updated, providers), cid);
  } finally {
    db.close();
  }
}

export async function finishBuilding(
  dataRoot: string,
  slug: string,
  researchId: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const db = await openResearchCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    const run = row.buildRunId === null ? null : runs.getRun(db, row.buildRunId);
    if (
      !mayFinishBuilding(
        row.status,
        run !== null && registry.isActive(run.id),
        run?.status === 'cancelled' && run.endedReason === null ? 'cancelled' : 'interrupted',
      )
    )
      return err('RESEARCH_STEP_INVALID', cid);
    const providers = await load();
    const latest = research.getResearch(db, researchId);
    if (
      latest?.status !== 'building' ||
      latest.buildRunId !== row.buildRunId ||
      (latest.buildRunId !== null && registry.isActive(latest.buildRunId))
    )
      return err('RESEARCH_STEP_INVALID', cid);
    research.updateResearchStatus(db, researchId, 'done', Date.now());
    const updated = research.getResearch(db, researchId);
    if (updated === null) return err('RESEARCH_UNEXPECTED', cid);
    return ok(viewOf(db, updated, providers), cid);
  } finally {
    db.close();
  }
}

async function processBuild(
  dataRoot: string,
  slug: string,
  researchId: string,
  providers: Providers,
  chat: ChatProvider,
  state: registry.ActiveRun,
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
    const candidates = research
      .listCandidates(db, researchId)
      .filter((entry) => entry.buildState !== 'done');
    state.channel.emit({ type: 'started', runId: state.runId, total: candidates.length });
    for (const candidate of candidates) {
      await state.gate();
      if (state.cancelled) break;
      const runItemId = newId();
      runs.insertRunItem(db, {
        id: runItemId,
        runId: state.runId,
        requested: candidate.url,
        host: null,
      });
      const decision = effectiveDecision(candidate);
      let itemId = candidate.itemId;
      let newEdges = 0;
      let newNodes = 0;
      let code: import('../domain/errors/codes.js').ErrorCode | null = null;
      const derived = itemId === null ? null : await readDerived(folder, itemId);
      if (state.cancelled) break;
      const body = derived !== null && derived.text.trim().length > 0;
      if (decision === 'include' && itemId !== null && body) {
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
          itemId,
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
          const extractedItemId = itemId;
          const applied = applyExtraction(
            db,
            itemId,
            state.runId,
            derived.text,
            called.extraction,
            (result) => {
              items.setItemExtracted(activeDb, {
                id: extractedItemId,
                extractedBy: chat.name,
                now: Date.now(),
              });
              research.setCandidateBuild(activeDb, {
                id: candidate.id,
                state: 'done',
                code: null,
                now: Date.now(),
              });
              runs.updateRunItem(activeDb, {
                id: runItemId,
                outcome: 'ok',
                code: result.code,
                itemId,
                now: Date.now(),
              });
              runs.setRunItemEdges(activeDb, runItemId, result.newEdges);
            },
          );
          newEdges = applied.newEdges;
          code = applied.code;
        }
      } else if (decision === 'include') code = 'PARSE_EMPTY_CONTENT';
      else
        withTransaction(db, () => {
          if (decision === 'discard' && itemId !== null)
            items.setStatus(activeDb, itemId, 'excluded', Date.now());
          if (decision === 'reference' && !body) {
            if (itemId === null || items.getItem(activeDb, itemId)?.kind !== 'reference') {
              itemId = newId();
              items.insertReference(activeDb, {
                id: itemId,
                title: candidate.title,
                url: candidate.url,
                runId: state.runId,
                now: Date.now(),
                bibJson: JSON.stringify({
                  ...candidate.bib,
                  why: candidate.why,
                  unavailableReason: candidate.unavailableReason,
                  reasonNote: candidate.reasonNote,
                  code: candidate.code,
                  acquisition: candidate.acquisition,
                  expectedAccess: candidate.expectedAccess,
                }),
              });
              research.setCandidateItem(activeDb, candidate.id, itemId, Date.now());
              newNodes = 1;
            }
            for (const source of candidate.citedBy) {
              const ref = { source, target: itemId, rel: '引用' };
              if (
                source !== itemId &&
                items.getItem(activeDb, source) !== null &&
                edges.findByTriple(activeDb, ref) === null
              ) {
                edges.insertEdge(
                  activeDb,
                  {
                    ...ref,
                    layer: 'named',
                    sourceKind: 'item',
                    targetKind: 'item',
                    origin: 'human',
                    confidence: 1,
                    runId: state.runId,
                  },
                  Date.now(),
                );
                newEdges += 1;
              }
            }
          }
          research.setCandidateBuild(activeDb, {
            id: candidate.id,
            state: 'done',
            code: null,
            now: Date.now(),
          });
          runs.updateRunItem(activeDb, {
            id: runItemId,
            outcome: 'ok',
            itemId,
            newNodes,
            now: Date.now(),
          });
          runs.setRunItemEdges(activeDb, runItemId, newEdges);
        });
      if (code !== null && research.getCandidate(db, candidate.id)?.buildState !== 'done')
        research.setCandidateBuild(db, {
          id: candidate.id,
          state: 'failed',
          code,
          now: Date.now(),
        });
      const outcome = workOutcome({
        code,
        fatal: code !== null && levelOf(code) === 'error',
        produced: newEdges > 0 || newNodes > 0,
      });
      outcomes.push(outcome);
      runs.updateRunItem(db, {
        id: runItemId,
        outcome: outcome === 'failed' ? 'failed' : 'ok',
        code,
        itemId,
        newNodes,
        now: Date.now(),
      });
      runs.setRunItemEdges(db, runItemId, newEdges);
      state.channel.emit({ type: 'progress', done: outcomes.length, total: candidates.length });
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
    if (!state.cancelled) research.moveResearchIf(db, researchId, 'building', 'done', Date.now());
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
        errorCode: 'RESEARCH_UNEXPECTED',
        now: Date.now(),
      });
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
