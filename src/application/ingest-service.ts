/**
 * 匯入的用例編排：一批輸入 → 擷取管線 → snapshot → 抽取 → 索引 → 節點。
 *
 * **三件事這一層要負責到底**：
 *
 * 1. **部分失敗是一等公民。** 40 個 URL 有 3 個 404，其餘 37 個照常寫入。
 *    這條規則的實作點是下面那個 `for` 迴圈 —— **每一項的失敗只影響那一項**。
 * 2. **索引在這裡就寫入**，不是等 Stage 12。否則要回頭替 5 萬筆重建。
 * 3. **取消時已寫入的保留。** 取消不是回滾。
 */
import { join } from 'node:path';

import {
  classifyExtension,
  classifyMime,
  charsetOf,
  type IngestKind,
} from '../domain/ingest/media-type.js';
import { settleRun, type RunStatus } from '../domain/ingest/state.js';
import { DEFAULT_INTERVAL_MS } from '../domain/ingest/throttle.js';
import { displayHost, normalizeUrl } from '../domain/ingest/url.js';
import { isEmptyContent } from '../domain/ingest/extract-confidence.js';
import type { ErrorCode } from '../domain/errors/codes.js';
import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase, updateCaseStatus } from '../infrastructure/db/repositories/case-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import { indexText, reindexTitleRank } from '../infrastructure/index/writer.js';
import { decodeHtml, decodeText } from '../infrastructure/extract/decode.js';
import { extractHtml } from '../infrastructure/extract/html.js';
import { imageDimensions } from '../infrastructure/extract/image.js';
import { detectLanguage } from '../infrastructure/extract/language.js';
import { extractPdf } from '../infrastructure/extract/pdf.js';
import { Crawler } from '../infrastructure/fetch/crawler.js';
import {
  EXTRACTOR_VERSION,
  appendManifest,
  sha256Of,
  writeDerived,
  writeSnapshot,
  type DerivedPayload,
} from '../infrastructure/fs/case-files.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId, newId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';
import * as registry from './run-registry.js';

const CASE_DB_FILE = 'case.sqlite';

/**
 * 執行中的作業那張表在 `run-registry.ts` —— **匯入與擴展共用一份**，
 * 因為它們走同一個取消端點。
 */
type ActiveRun = registry.ActiveRun;

function caseFolderOf(dataRoot: string, slug: string): string {
  return join(casesDir(dataRoot), slug);
}

async function openCase(dataRoot: string, slug: string): Promise<DatabaseSync | ErrorCode> {
  const opened = await openCaseDatabase(join(caseFolderOf(dataRoot, slug), CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new') return 'CASE_SCHEMA_TOO_NEW';
  if (opened.kind === 'migrate-failed') return 'CASE_SCHEMA_MIGRATE_FAILED';
  return opened.db;
}

export interface StartedRun {
  readonly runId: string;
  readonly total: number;
}

/**
 * 貼一批 URL。**立刻回一個 runId，抓取在背景進行** ——
 * 40 個 URL 至少要等 120 秒（同網域 3 秒），而一個等兩分鐘的 HTTP 請求
 * 會在每一層 proxy 與瀏覽器上遇到不同的逾時。
 */
export async function startUrlImport(
  dataRoot: string,
  slug: string,
  urls: readonly string[],
): Promise<Result<StartedRun>> {
  const cid = correlationId();
  if (urls.length === 0) return err('SEARCH_QUERY_EMPTY', cid, { why: 'no-urls' });

  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });

  const caseRow = readCase(db);
  if (caseRow === null) {
    db.close();
    return err('CASE_NOT_FOUND', cid, { slug });
  }
  if (caseRow.status === 'archived') {
    db.close();
    return err('CASE_ARCHIVED', cid, { slug });
  }

  const runId = newId();
  const now = Date.now();
  runs.insertRun(db, {
    id: runId,
    kind: 'import',
    label: urls.length === 1 ? (urls[0] as string) : `${urls.length} 個網址`,
    total: urls.length,
    correlationId: cid,
    now,
  });

  const queued: { readonly id: string; readonly url: string }[] = [];
  for (const url of urls) {
    const id = newId();
    runs.insertRunItem(db, { id, runId, requested: url, host: displayHost(url) || null });
    queued.push({ id, url });
  }

  if (caseRow.status === 'new' || caseRow.status === 'ready') {
    updateCaseStatus(db, 'collecting', now);
  }

  const state = registry.register(runId);
  const crawler = new Crawler({
    intervalMs: DEFAULT_INTERVAL_MS,
    onEvent: (e) => state.channel.emit({ type: 'throttled', host: e.host, waitedMs: e.waitedMs }),
  });
  // 取消匯入 ＝ 停爬蟲。**已寫入的保留。**
  state.cancellable = { stop: () => crawler.stop() };

  // **不 await。** 這條路徑刻意是「開始了」而不是「做完了」。
  void processUrls(db, dataRoot, slug, state, crawler, queued).catch((e: unknown) => {
    logger.error('匯入作業意外中止', { correlationId: cid, runId, reason: String(e) });
  });

  return ok({ runId, total: urls.length }, cid);
}

export interface QueuedUrl {
  readonly id: string;
  readonly url: string;
}

async function processUrls(
  db: DatabaseSync,
  dataRoot: string,
  slug: string,
  state: ActiveRun,
  crawler: Crawler,
  queue: readonly QueuedUrl[],
): Promise<void> {
  const folder = caseFolderOf(dataRoot, slug);
  let succeeded = 0;
  let failed = 0;
  let done = 0;

  runs.startRun(db, state.runId, Date.now());
  state.channel.emit({ type: 'started', runId: state.runId, total: queue.length });

  try {
    for (const entry of queue) {
      if (state.cancelled) break;

      const outcome = await processOneUrl(db, folder, crawler, state.runId, entry);
      done++;
      if (outcome.counts === 'ok') succeeded++;
      else if (outcome.counts === 'failed') failed++;
      else succeeded++; // duplicate 不是失敗

      state.channel.emit({
        type: 'item',
        runItemId: entry.id,
        requested: entry.url,
        host: displayHost(entry.url) || null,
        outcome: outcome.outcome,
        code: outcome.code,
        itemId: outcome.itemId,
      });
      state.channel.emit({ type: 'progress', done, total: queue.length });

      // **429／503 之後整批停下來。** 已經寫入的保留，其餘標成已取消。
      if (crawler.isStopped) break;
    }

    const now = Date.now();
    const remaining = runs.cancelPendingItems(db, state.runId, now);

    let status: RunStatus;
    if (state.cancelled) {
      status = 'cancelled';
    } else if (crawler.isStopped && remaining > 0) {
      // 被對方限流而停 —— **有東西寫進去了就是部分失敗**，不是整批失敗
      status = succeeded > 0 ? 'partial' : 'failed';
    } else {
      const action = settleRun(succeeded, failed);
      status =
        action === 'complete' ? 'done' : action === 'complete-partial' ? 'partial' : 'failed';
    }

    runs.settleRunRow(db, { id: state.runId, status, succeeded, failed, now });

    // **標題名次整批重排一次**（不是每筆一次）——理由在 domain/search/collate.ts
    reindexTitleRank(db);

    const caseRow = readCase(db);
    if (caseRow !== null && caseRow.status === 'collecting') updateCaseStatus(db, 'ready', now);

    state.channel.emit({ type: 'settled', status, succeeded, failed });
  } finally {
    registry.unregister(state.runId);
    db.close();
  }
}

export interface OneOutcome {
  readonly outcome: runs.RunItemOutcome;
  readonly code: string | null;
  readonly itemId: string | null;
  readonly counts: 'ok' | 'failed' | 'duplicate';
}

function finishRunItem(
  db: DatabaseSync,
  runItemId: string,
  result: OneOutcome,
  waitedMs: number | null,
): OneOutcome {
  runs.updateRunItem(db, {
    id: runItemId,
    outcome: result.outcome,
    code: result.code,
    itemId: result.itemId,
    newNodes: result.counts === 'ok' ? 1 : 0,
    waitedMs,
    now: Date.now(),
  });
  return result;
}

export async function processOneUrl(
  db: DatabaseSync,
  folder: string,
  crawler: Crawler,
  runId: string,
  entry: QueuedUrl,
): Promise<OneOutcome> {
  const parsed = normalizeUrl(entry.url);
  if (parsed.kind !== 'ok') {
    return finishRunItem(
      db,
      entry.id,
      { outcome: 'failed', code: 'FETCH_BAD_URL', itemId: null, counts: 'failed' },
      null,
    );
  }

  // **同一個 URL 不建第二個節點**（REQ-0003）。失敗過的那一個可以重用。
  const existing = items.findByRequestedUrl(db, parsed.url);
  if (existing !== null && existing.status !== 'failed') {
    return finishRunItem(
      db,
      entry.id,
      { outcome: 'duplicate', code: 'FETCH_DUPLICATE', itemId: existing.id, counts: 'duplicate' },
      null,
    );
  }

  const now = Date.now();
  let itemId: string;
  if (existing === null) {
    itemId = newId();
    items.insertPendingItem(db, {
      id: itemId,
      kind: 'web',
      requestedUrl: parsed.url,
      title: parsed.url,
      runId,
      now,
    });
  } else {
    itemId = existing.id;
    items.markPending(db, itemId, now);
  }

  const { outcome, waitedMs } = await crawler.fetch(parsed.url);
  if (outcome.kind === 'error') {
    items.markFailed(db, itemId, outcome.code, Date.now());
    await appendManifest(folder, {
      at: new Date().toISOString(),
      url: parsed.url,
      itemId,
      status: 'failed',
      code: outcome.code,
      sha256: null,
      byteSize: null,
      contentType: null,
      hops: [],
    });
    return finishRunItem(
      db,
      entry.id,
      { outcome: 'failed', code: outcome.code, itemId, counts: 'failed' },
      waitedMs,
    );
  }

  return ingestBytes(db, folder, {
    runItemId: entry.id,
    waitedMs,
    itemId,
    requestedUrl: parsed.url,
    finalUrl: outcome.finalUrl,
    bytes: outcome.bytes,
    contentType: outcome.contentType,
    hops: outcome.hops.map((h) => h.host),
  });
}

/**
 * 從「一段位元組」到「一個可讀的節點」。
 *
 * **網路與本機檔案在這裡匯流** —— 上面兩條路只負責把位元組拿到手。
 * 快照、雜湊、抽取、索引都只有這一份實作。
 */
async function ingestBytes(
  db: DatabaseSync,
  folder: string,
  input: {
    readonly runItemId: string;
    readonly itemId: string;
    readonly requestedUrl: string | null;
    readonly finalUrl: string;
    readonly bytes: Uint8Array;
    readonly contentType: string | null;
    readonly fileName?: string;
    readonly hops: readonly string[];
    /** 為了節流等了多久。檔案匯入沒有等，所以是 0。 */
    readonly waitedMs?: number;
  },
): Promise<OneOutcome> {
  const media =
    input.contentType !== null
      ? classifyMime(input.contentType)
      : classifyExtension(input.fileName ?? '');

  if (media.kind !== 'ok') {
    items.markFailed(db, input.itemId, 'FETCH_UNSUPPORTED_TYPE', Date.now());
    return finishRunItem(
      db,
      input.runItemId,
      { outcome: 'failed', code: 'FETCH_UNSUPPORTED_TYPE', itemId: input.itemId, counts: 'failed' },
      input.waitedMs ?? null,
    );
  }

  // **同一份內容只存一次快照。** 認出重複靠 SHA-256，不是靠 URL。
  const sha = sha256Of(input.bytes);
  const twin = items.findBySha256(db, sha);
  if (twin !== null && twin.id !== input.itemId) {
    db.prepare('DELETE FROM item WHERE id = ?').run(input.itemId);
    // **抓過就要留一列。** REQ-0003 說的是「每次擷取寫一列」，
    // 而這一次確實抓了 —— 只是結果是「已經有了」。
    await appendManifest(folder, {
      at: new Date().toISOString(),
      url: input.requestedUrl,
      itemId: twin.id,
      status: 'ok',
      code: 'FETCH_DUPLICATE',
      sha256: sha,
      byteSize: input.bytes.byteLength,
      contentType: media.mime,
      hops: input.hops,
    });
    return finishRunItem(
      db,
      input.runItemId,
      { outcome: 'duplicate', code: 'FETCH_DUPLICATE', itemId: twin.id, counts: 'duplicate' },
      input.waitedMs ?? null,
    );
  }

  const written = await writeSnapshot(folder, input.bytes, media.ext);
  const now = Date.now();
  items.markFetched(db, {
    id: input.itemId,
    sourceUrl: input.finalUrl,
    sha256: written.sha256,
    mime: media.mime,
    sourceExt: media.ext,
    byteSize: written.byteSize,
    kind: media.itemKind,
    now,
  });

  await appendManifest(folder, {
    at: new Date().toISOString(),
    url: input.requestedUrl,
    itemId: input.itemId,
    status: 'ok',
    code: null,
    sha256: written.sha256,
    byteSize: written.byteSize,
    contentType: media.mime,
    hops: input.hops,
  });

  const extracted = await extract(input.bytes, media.itemKind, input.contentType, input.finalUrl);
  if (extracted.kind === 'failed') {
    items.markFailed(db, input.itemId, extracted.code, Date.now());
    return finishRunItem(
      db,
      input.runItemId,
      { outcome: 'failed', code: extracted.code, itemId: input.itemId, counts: 'failed' },
      input.waitedMs ?? null,
    );
  }

  const payload = extracted.payload;
  await writeDerived(folder, input.itemId, payload);

  const lang = detectLanguage(payload.text);
  items.markParsed(db, {
    id: input.itemId,
    title: payload.title,
    lang,
    excerpt: payload.excerpt,
    lowConfidence: payload.lowConfidence,
    reasons: payload.reasons,
    extractorVersion: payload.extractorVersion,
    pageCount: payload.pages?.length ?? null,
    imageWidth: extracted.image?.width ?? null,
    imageHeight: extracted.image?.height ?? null,
    now: Date.now(),
  });

  indexText(db, {
    ownerKind: 'item',
    ownerId: input.itemId,
    lang,
    title: payload.title,
    text: payload.text,
  });

  return finishRunItem(
    db,
    input.runItemId,
    { outcome: 'ok', code: extracted.notice, itemId: input.itemId, counts: 'ok' },
    input.waitedMs ?? null,
  );
}

export type ExtractOutcome =
  | {
      readonly kind: 'ok';
      readonly payload: DerivedPayload;
      readonly notice: ErrorCode | null;
      readonly image?: { readonly width: number; readonly height: number } | undefined;
    }
  | { readonly kind: 'failed'; readonly code: ErrorCode };

/**
 * 從位元組抽出正文。
 *
 * **導出的理由是整批重算**（`rebuild-service`）—— 重算走的必須是
 * **同一支**抽取，不是一份長得很像的副本。兩份的話，
 * 「重算前後差異為 0」驗的就變成兩份實作有多像，而不是抽取有多穩定。
 */
export async function extract(
  bytes: Uint8Array,
  kind: IngestKind,
  contentType: string | null,
  url: string,
): Promise<ExtractOutcome> {
  if (kind === 'web') {
    const decoded = decodeHtml(bytes, charsetOf(contentType));
    if (decoded.kind !== 'ok') return { kind: 'failed', code: 'PARSE_ENCODING' };

    const result = extractHtml(decoded.text, url);
    // **JS-only 要跟「這頁本來就沒東西」分開**（REQ-0003）。
    if (result.jsOnly) return { kind: 'failed', code: 'PARSE_JS_ONLY' };
    if (isEmptyContent(result.signals)) return { kind: 'failed', code: 'PARSE_EMPTY_CONTENT' };

    return {
      kind: 'ok',
      notice: result.verdict.lowConfidence ? 'PARSE_LOW_CONFIDENCE' : null,
      payload: {
        extractorVersion: EXTRACTOR_VERSION,
        kind: 'web',
        title: result.title,
        text: result.text,
        html: result.html,
        pages: null,
        excerpt: result.excerpt.slice(0, 400),
        lowConfidence: result.verdict.lowConfidence,
        reasons: result.verdict.reasons,
      },
    };
  }

  if (kind === 'pdf') {
    const result = await extractPdf(bytes);
    if (result.kind === 'encrypted') return { kind: 'failed', code: 'PARSE_PDF_ENCRYPTED' };
    if (result.kind === 'unreadable') return { kind: 'failed', code: 'PARSE_UNEXPECTED' };

    const text = result.pages.join('\n\n');
    return {
      kind: 'ok',
      // **掃描件不是失敗。** 它只是沒有文字層，而使用者要看得出差別（ADR-0019）。
      notice: result.noTextLayer ? 'PARSE_PDF_NO_TEXT_LAYER' : null,
      payload: {
        extractorVersion: EXTRACTOR_VERSION,
        kind: 'pdf',
        title: result.title ?? fileNameOf(url),
        text,
        html: null,
        pages: result.pages,
        excerpt: text.slice(0, 400),
        lowConfidence: result.noTextLayer,
        reasons: result.noTextLayer ? ['pdf-no-text-layer'] : [],
      },
    };
  }

  if (kind === 'image') {
    const size = imageDimensions(bytes);
    return {
      kind: 'ok',
      notice: null,
      ...(size === null ? {} : { image: size }),
      payload: {
        extractorVersion: EXTRACTOR_VERSION,
        kind: 'image',
        title: fileNameOf(url),
        text: '',
        html: null,
        pages: null,
        excerpt: '',
        // 圖片沒有正文，所以「抽取信心」對它沒有意義 —— **不要標低信心**，
        // 那會讓標記在圖片上變成雜訊。
        lowConfidence: false,
        reasons: [],
      },
    };
  }

  const decoded = decodeText(bytes, charsetOf(contentType));
  if (decoded.kind !== 'ok') return { kind: 'failed', code: 'PARSE_ENCODING' };
  const text = decoded.text.trim();
  if (text.length === 0) return { kind: 'failed', code: 'PARSE_EMPTY_CONTENT' };

  const firstLine = (text.split('\n')[0] ?? '').replace(/^#+\s*/, '').trim();
  return {
    kind: 'ok',
    notice: null,
    payload: {
      extractorVersion: EXTRACTOR_VERSION,
      kind: 'text',
      title: firstLine.slice(0, 120) || fileNameOf(url),
      text,
      html: null,
      pages: null,
      excerpt: text.slice(0, 400),
      lowConfidence: false,
      reasons: [],
    },
  };
}

function fileNameOf(urlOrName: string): string {
  try {
    const u = new URL(urlOrName);
    const last = u.pathname
      .split('/')
      .filter((s) => s.length > 0)
      .pop();
    return decodeURIComponent(last ?? u.hostname);
  } catch {
    return urlOrName;
  }
}

// ── 檔案匯入 ───────────────────────────────────────────────

/**
 * 上傳一個檔案。**走的是同一條 `ingestBytes`** ——
 * 快照、雜湊、抽取、索引只有一份實作。
 */
export async function importFile(
  dataRoot: string,
  slug: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<
  Result<{ readonly runId: string; readonly itemId: string | null; readonly code: string | null }>
> {
  const cid = correlationId();
  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });

  try {
    const caseRow = readCase(db);
    if (caseRow === null) return err('CASE_NOT_FOUND', cid, { slug });
    if (caseRow.status === 'archived') return err('CASE_ARCHIVED', cid, { slug });

    const runId = newId();
    const runItemId = newId();
    const now = Date.now();
    runs.insertRun(db, {
      id: runId,
      kind: 'import',
      label: fileName,
      total: 1,
      correlationId: cid,
      now,
    });
    runs.insertRunItem(db, { id: runItemId, runId, requested: fileName, host: null });
    runs.startRun(db, runId, now);

    const media = classifyExtension(fileName);
    if (media.kind !== 'ok') {
      runs.updateRunItem(db, {
        id: runItemId,
        outcome: 'failed',
        code: 'FETCH_UNSUPPORTED_TYPE',
        now: Date.now(),
      });
      runs.settleRunRow(db, {
        id: runId,
        status: 'failed',
        succeeded: 0,
        failed: 1,
        now: Date.now(),
      });
      return ok({ runId, itemId: null, code: 'FETCH_UNSUPPORTED_TYPE' }, cid);
    }

    const itemId = newId();
    items.insertPendingItem(db, {
      id: itemId,
      kind: media.itemKind,
      requestedUrl: null,
      title: fileName,
      runId,
      now,
    });

    const result = await ingestBytes(db, caseFolderOf(dataRoot, slug), {
      runItemId,
      itemId,
      requestedUrl: null,
      finalUrl: fileName,
      bytes,
      contentType: null,
      fileName,
      hops: [],
    });

    const failed = result.counts === 'failed' ? 1 : 0;
    runs.settleRunRow(db, {
      id: runId,
      status: failed === 1 ? 'failed' : 'done',
      succeeded: failed === 1 ? 0 : 1,
      failed,
      now: Date.now(),
    });
    reindexTitleRank(db);
    if (caseRow.status === 'new') updateCaseStatus(db, 'ready', Date.now());

    return ok({ runId, itemId: result.itemId, code: result.code }, cid);
  } finally {
    db.close();
  }
}

// ── 取消與重試 ─────────────────────────────────────────────

/** 取消 ＝ 停止送出新請求 ＋ 標 `已取消`。**已寫入的保留。** */
export function cancelRun(runId: string): Result<true> {
  const cid = correlationId();
  if (!registry.cancel(runId))
    return err('GRAPH_TRANSITION_INVALID', cid, { runId, why: 'not-active' });
  return ok(true, cid);
}

export const channelOf = registry.channelOf;
export const isActive = registry.isActive;
export const replayOf = registry.replayOf;
