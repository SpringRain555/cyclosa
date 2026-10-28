/**
 * 舊資料升級成新格式（ADR-0039 第五節）。
 *
 * ## 為什麼是 App 自己升，而不是一顆「重算」按鈕
 *
 * 2026-10-28 使用者看過 Markdown 渲染的提案之後說：舊資料要全部換成新版的格式，換不了就重新處理，**不要留著相容舊格式**。
 * 原本的做法是「找不到新版就讀舊版、按『重算全部正文』才換」—— 那會讓同一個專題半新半舊：有的筆記渲染、有的沒有，
 * 帶記號的舊引文只標一句「對不到」。所以抽取器升版之後，**第一次碰到一個專題時就把它整個升上來**，升完才處理請求
 * （`interface/http/upgrade-gate.ts`）。
 *
 * ## 升級做什麼
 *
 * | 資料 | 怎麼處理 |
 * |---|---|
 * | 抽取改過的種類（`EXTRACTOR_CHANGES`）| 從快照重抽；正文變了就重建索引、作廢向量、把引文與點註換到新正文 |
 * | 抽取沒改過的種類 | `derived` 檔換成新版號（內容不動，`blocks: null`）|
 * | 筆記附件 | 標題改用 Markdown 的標題規則，索引與摘要改成看得到的字 |
 * | 舊版號的 `derived` 檔 | 刪掉（`readDerived` 只讀現行版）|
 *
 * **向量不在這裡重算**：那要載入嵌入模型，而這台機器的 GPU 是幾個專案共用的；作廢的那幾份由既有的回填補。
 *
 * ## 引文與點註怎麼換
 *
 * Markdown 拿掉記號之後，舊引文裡的 `**` 已經不在正文裡了 —— 用字去找會找不到。解析時記了一張
 * 「新正文第 i 個字 ↔ 原文第幾個字」的對照表（`infrastructure/extract/markdown.ts`），而 v2 的正文就是原文：
 * 先在舊正文確認它原本在哪（位置對不上就先找字），再換到新正文，**引文與點註的字改成新正文的那一段**。
 * 沒有對照表的（非 Markdown 的重抽）照既有的找字。**對不上的留著、數出來**，不刪。
 *
 * ## 一份一個交易
 *
 * 每一份是「寫新版 `derived` → 一個交易裡改資料列、索引、向量、引文、點註 → 刪舊版檔」。中途停掉的話，
 * 沒做完的那一份資料庫還說它是舊版，下一次啟動會整份重做；**`case.derived_version` 最後才寫**。
 */
import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';

import { checkQuote } from '../domain/export/verify.js';
import {
  anchorOk,
  parseSelectors,
  resolveAnchor,
  resolveInText,
  textSelectors,
} from '../domain/annotation/index.js';
import { markdownTitle } from '../domain/ingest/markdown.js';
import { remapRange } from '../domain/text/markdown-blocks.js';
import {
  openCaseDatabase,
  withTransaction,
  type DatabaseSync,
} from '../infrastructure/db/database.js';
import {
  readCase,
  readDerivedVersion,
  setDerivedVersion,
} from '../infrastructure/db/repositories/case-repo.js';
import * as edges from '../infrastructure/db/repositories/edge-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as notes from '../infrastructure/db/repositories/note-repo.js';
import { insertNotice } from '../infrastructure/db/repositories/notice-repo.js';
import { dropVectorsFor } from '../infrastructure/db/repositories/vector-repo.js';
import {
  EXTRACTOR_VERSION,
  changedSince,
  derivedPath,
  notesDir,
  readDerivedAt,
  readSnapshot,
  writeDerived,
  type DerivedPayload,
} from '../infrastructure/fs/case-files.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { indexText, reindexTitleRank } from '../infrastructure/index/writer.js';
import { newId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { extract, languageOf } from './ingest-service.js';
import { targetOf, visibleText, writeMarkdown as writeNoteMarkdown } from './note-service.js';

const CASE_DB_FILE = 'case.sqlite';
const HEX64 = /^[0-9a-f]{64}$/;

/** 升級通知的種類（`case_notice.kind`）。畫面在 `CaseNotices.vue` 認它。 */
export const UPGRADE_NOTICE_KIND = 'derived-upgrade';

export interface UpgradeCounts {
  /** 碰到的幾條 */
  readonly checked: number;
  /** 字一樣、只搬了位置 */
  readonly moved: number;
  /** 字換成新正文的那一段（記號拿掉了） */
  readonly rewritten: number;
  /** 對不上：原樣留著 */
  readonly unresolved: number;
}

export interface UpgradeReport {
  readonly from: number;
  readonly to: number;
  /** 從快照重抽的份數 */
  readonly reextracted: number;
  /** 其中正文真的變了的（Markdown 拿掉記號）—— 這幾份的向量作廢，要回填 */
  readonly changed: number;
  /** 抽取沒改過、只換版號的份數 */
  readonly restamped: number;
  /** 重抽不了的（快照不見或抽不出正文）—— 這幾份現在沒有正文 */
  readonly failed: number;
  /** 正文變了、原本有語意索引的份數：向量作廢了，要用回填重建 */
  readonly vectorsDropped: number;
  /** 改了標題與索引的筆記附件 */
  readonly attachments: number;
  readonly evidence: UpgradeCounts;
  readonly notes: UpgradeCounts;
}

class Counter {
  checked = 0;
  moved = 0;
  rewritten = 0;
  unresolved = 0;
  done(): UpgradeCounts {
    return {
      checked: this.checked,
      moved: this.moved,
      rewritten: this.rewritten,
      unresolved: this.unresolved,
    };
  }
}

/** 一份重抽之後，新舊正文與（Markdown 才有的）對照表。 */
interface Change {
  readonly oldText: string | null;
  readonly newText: string;
  /** `map[i]`：新正文第 i 個字在舊正文的位置。舊正文跟解析的原文一字不差才有 */
  readonly map: Int32Array | null;
}

type Moved =
  | { readonly kind: 'kept' }
  | { readonly kind: 'moved'; readonly start: number; readonly end: number }
  | {
      readonly kind: 'rewritten';
      readonly quote: string;
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: 'lost' };

/** 一條引文換到新正文。 */
function moveQuote(change: Change, quote: string, start: number, end: number): Moved {
  if (change.map !== null && change.oldText !== null) {
    const before = checkQuote(change.oldText, quote, start, end);
    if (before.status !== 'missing') {
      const next = remapRange(change.map, change.newText, before.start, before.end);
      if (next !== null) {
        const text = change.newText.slice(next.start, next.end);
        if (text !== quote) return { kind: 'rewritten', quote: text, ...next };
        return next.start === start && next.end === end
          ? { kind: 'kept' }
          : { kind: 'moved', ...next };
      }
    }
  }
  const after = checkQuote(change.newText, quote, start, end);
  if (after.status === 'verified') return { kind: 'kept' };
  if (after.status === 'shifted') return { kind: 'moved', start: after.start, end: after.end };
  return { kind: 'lost' };
}

async function removeOlder(folder: string, itemId: string): Promise<void> {
  for (let version = 1; version < EXTRACTOR_VERSION; version++) {
    await rm(derivedPath(folder, itemId, version), { force: true });
  }
}

/** 一份資料的引文與點註換到新正文（在那一份的交易裡）。點註的 `.md` 回傳出去、交易外再寫。 */
function moveAnchors(
  db: DatabaseSync,
  item: items.ItemRow,
  payload: DerivedPayload,
  change: Change,
  evidenceRows: readonly ReturnType<typeof edges.allEvidence>[number][],
  evidence: Counter,
  noteCounter: Counter,
  now: number,
): { readonly note: notes.NoteRow; readonly quote: string }[] {
  for (const row of evidenceRows) {
    evidence.checked++;
    const moved = moveQuote(change, row.quote, row.charStart, row.charEnd);
    if (moved.kind === 'moved') {
      edges.setEvidenceSpan(db, row.id, moved.start, moved.end);
      evidence.moved++;
    } else if (moved.kind === 'rewritten') {
      edges.setEvidenceQuote(db, row.id, moved.quote, moved.start, moved.end);
      evidence.rewritten++;
    } else if (moved.kind === 'lost') {
      evidence.unresolved++;
    }
  }

  const rewrittenNotes: { readonly note: notes.NoteRow; readonly quote: string }[] = [];
  for (const note of notes.listNotesFor(db, item.id)) {
    if (note.selectorJson === '[]') continue;
    noteCounter.checked++;
    const selectors = parseSelectors(note.selectorJson);
    // 快照換了的點註本來就解不了（ADR-0010 第 5 條）—— 不動。
    const snapshotChanged =
      note.snapshotSha256 !== null && item.sha256 !== null && note.snapshotSha256 !== item.sha256;
    const textOnly = selectors.every((s) => s.type !== 'FragmentSelector');
    if (!snapshotChanged && textOnly && change.map !== null && change.oldText !== null) {
      const before = resolveInText(change.oldText, selectors);
      if (before.kind === 'exact' || before.kind === 'shifted') {
        const next = remapRange(change.map, change.newText, before.start, before.end);
        const built = next === null ? null : textSelectors(change.newText, next.start, next.end);
        if (built?.kind === 'ok') {
          const json = JSON.stringify(built.selectors);
          notes.setSelectors(db, note.id, json, true, now);
          noteCounter.rewritten++;
          rewrittenNotes.push({ note: { ...note, selectorJson: json }, quote: built.value.exact });
          continue;
        }
      }
    }
    const hit = snapshotChanged
      ? ({ kind: 'not-found' } as const)
      : resolveAnchor(targetOf(item, payload), selectors);
    if (hit.kind === 'shifted') noteCounter.moved++;
    if (hit.kind === 'not-found') noteCounter.unresolved++;
    const okNow = anchorOk(hit);
    if (okNow !== note.anchorOk) notes.setAnchorOk(db, note.id, okNow, now);
  }
  return rewrittenNotes;
}

/** 筆記附件：標題改用 Markdown 的標題規則，索引與摘要改成看得到的字。 */
async function upgradeAttachments(db: DatabaseSync, folder: string): Promise<number> {
  let count = 0;
  for (const note of notes.listNotes(db, Number.MAX_SAFE_INTEGER)) {
    if (note.selectorJson !== '[]' || note.itemId === null) continue;
    let fileName = '';
    try {
      const raw = await readFile(join(notesDir(folder), `${note.id}.filename.json`), 'utf8');
      const parsed = JSON.parse(raw) as { fileName?: unknown };
      if (typeof parsed.fileName === 'string') fileName = parsed.fileName;
    } catch {
      // 中繼資料遺失：標題退回正文的規則。
    }
    const title = markdownTitle(note.body, fileName);
    const visible = visibleText(note.body);
    const current = items.getItem(db, note.id);
    // 已經是新格式的（v1.1.0 之後附上的）不動 —— 升級不該改到不需要改的列。
    if (current !== null && current.title === title && current.excerpt === visible) continue;
    const lang = items.getItem(db, note.itemId)?.lang ?? 'und';
    withTransaction(db, () => {
      items.setTitle(db, note.id, title, Date.now());
      items.setExcerpt(db, note.id, visible);
      indexText(db, { ownerKind: 'item', ownerId: note.id, lang, title, text: visible });
    });
    count++;
  }
  return count;
}

async function upgradeOpen(db: DatabaseSync, folder: string, from: number): Promise<UpgradeReport> {
  const evidence = new Counter();
  const noteCounter = new Counter();
  let reextracted = 0;
  let changed = 0;
  let restamped = 0;
  let failed = 0;
  let vectorsDropped = 0;

  const evidenceByItem = new Map<string, ReturnType<typeof edges.allEvidence>[number][]>();
  for (const row of edges.allEvidence(db)) {
    const list = evidenceByItem.get(row.itemId) ?? [];
    list.push(row);
    evidenceByItem.set(row.itemId, list);
  }

  for (const id of items.listOlderThan(db, EXTRACTOR_VERSION)) {
    const item = items.getItem(db, id);
    if (item === null || item.extractorVersion === null) continue;
    if (item.kind === 'note' || item.kind === 'reference') continue;
    const old = await readDerivedAt(folder, id, item.extractorVersion);

    // 抽取沒改過的種類：只換版號，一字不動。
    if (old !== null && !changedSince(old.kind, item.extractorVersion)) {
      await writeDerived(folder, id, {
        ...old,
        extractorVersion: EXTRACTOR_VERSION,
        blocks: old.blocks ?? null,
      });
      items.setExtractorVersion(db, id, EXTRACTOR_VERSION);
      await removeOlder(folder, id);
      restamped++;
      continue;
    }

    if (item.sha256 === null || item.sourceExt === null || !HEX64.test(item.sha256)) {
      failed++;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readSnapshot(folder, item.sha256, item.sourceExt);
    } catch {
      failed++;
      continue;
    }
    const outcome = await extract(bytes, item.kind, item.mime, item.sourceUrl ?? item.title);
    if (outcome.kind === 'failed') {
      failed++;
      continue;
    }
    const payload = outcome.payload;
    const textChanged = old === null || old.text !== payload.text;
    const change: Change = {
      oldText: old?.text ?? null,
      newText: payload.text,
      map:
        outcome.sourceMap !== undefined && old !== null && outcome.source === old.text
          ? outcome.sourceMap
          : null,
    };

    await writeDerived(folder, id, payload);
    const now = Date.now();
    const lang = languageOf(payload);
    const rewrittenNotes = withTransaction(db, () => {
      items.markReextracted(db, {
        id,
        title: payload.title,
        lang,
        excerpt: payload.excerpt,
        lowConfidence: payload.lowConfidence,
        reasons: payload.reasons,
        extractorVersion: payload.extractorVersion,
        pageCount: payload.pages?.length ?? null,
        imageWidth: outcome.image?.width ?? null,
        imageHeight: outcome.image?.height ?? null,
        now,
      });
      if (!textChanged) return [];
      indexText(db, {
        ownerKind: 'item',
        ownerId: id,
        lang,
        title: payload.title,
        text: payload.text,
      });
      // 舊向量指的是一段已經不在正文裡的字 —— 留著的話語意檢索會命中它，點過去卻找不到。
      if (dropVectorsFor(db, 'item', id) > 0) vectorsDropped++;
      return moveAnchors(
        db,
        item,
        payload,
        change,
        evidenceByItem.get(id) ?? [],
        evidence,
        noteCounter,
        now,
      );
    });
    for (const { note, quote } of rewrittenNotes) {
      const path = await writeNoteMarkdown(folder, note, quote, null);
      if (path !== null) notes.setMdPath(db, note.id, path);
    }
    await removeOlder(folder, id);
    reextracted++;
    if (textChanged) changed++;
  }

  const attachments = await upgradeAttachments(db, folder);
  if (reextracted > 0 || attachments > 0) reindexTitleRank(db);

  return {
    from,
    to: EXTRACTOR_VERSION,
    reextracted,
    changed,
    restamped,
    failed,
    vectorsDropped,
    attachments,
    evidence: evidence.done(),
    notes: noteCounter.done(),
  };
}

/** 值得跟使用者說的才寫通知：只換了版號的專題，打開時不該多一張卡。 */
function worthNoticing(report: UpgradeReport): boolean {
  return (
    report.changed > 0 ||
    report.failed > 0 ||
    report.attachments > 0 ||
    report.evidence.unresolved > 0 ||
    report.notes.unresolved > 0
  );
}

/**
 * 升級一個專題。**已經是現行版就什麼都不做**（`current`）。開不起來的回 `unavailable` ——
 * 那個錯誤交給原本那個請求自己去報（不存在、schema 太新、搬家搬到一半…），升級不另外發明一種失敗。
 */
export async function upgradeCase(
  dataRoot: string,
  slug: string,
): Promise<UpgradeReport | 'current' | 'unavailable'> {
  const folder = join(casesDir(dataRoot), slug);
  const opened = await openCaseDatabase(join(folder, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind !== 'ok') return 'unavailable';
  const db = opened.db;
  try {
    if (readCase(db) === null) return 'unavailable';
    const from = readDerivedVersion(db);
    if (from >= EXTRACTOR_VERSION) return 'current';

    const report = await upgradeOpen(db, folder, from);
    if (worthNoticing(report)) {
      insertNotice(db, {
        id: newId(),
        kind: UPGRADE_NOTICE_KIND,
        bodyJson: JSON.stringify(report),
        createdAt: Date.now(),
      });
    }
    setDerivedVersion(db, EXTRACTOR_VERSION);
    return report;
  } finally {
    db.close();
  }
}

/**
 * **同一個程序裡每個專題只檢查一次**；同時進來的請求等同一次升級。
 * 開不起來的（還不存在、schema 太新）不記成「檢查過」—— 之後建出來或換回來的那一個要能升。
 * 升級本身出錯（照理不會）只記 log、不擋請求：請求照常走，讀不到的正文照原本的方式說出來，下一個請求再試。
 */
const upgrades = new Map<string, Promise<void>>();

export function ensureCaseUpgraded(dataRoot: string, slug: string): Promise<void> {
  const key = `${dataRoot}\u0000${slug}`;
  const known = upgrades.get(key);
  if (known !== undefined) return known;
  const pending = upgradeCase(dataRoot, slug).then(
    (result) => {
      if (result === 'unavailable') upgrades.delete(key);
      else if (result !== 'current') logger.info('專題的正文升級完成', { slug, ...result });
    },
    (e: unknown) => {
      upgrades.delete(key);
      logger.error('專題的正文升級失敗', { slug, reason: String((e as Error).message) });
    },
  );
  upgrades.set(key, pending);
  return pending;
}

/** 測試用：清掉「這個程序已經檢查過」的紀錄。 */
export function forgetUpgradeChecks(): void {
  upgrades.clear();
}
