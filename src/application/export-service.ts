/**
 * 證據包匯出的用例（Stage 11）。
 *
 * ## 「選一塊子圖」的意思是「你現在看到的那一塊」
 *
 * 所以這一支**呼叫 `graph-service` 的 `subgraph()`，不自己走一次圖**。
 * 自己走的話會多一份遍歷實作，而兩份遍歷遲早不一致 ——
 * 那時候匯出的東西會跟畫面上看到的不一樣，
 * 而**使用者沒有辦法發現**：兩份都看起來很正常。
 *
 * 代價是同一個專題的資料庫被打開兩次（一次算子圖、一次抓出處）。
 * 那是一次本機的檔案開啟，換一份不會分岔的實作 —— **划算。**
 *
 * ## 出處那一份不一定在選取範圍裡
 *
 * 一條「甲 收購 乙」的邊，兩端都是實體，而它的引文出自某一份文件 ——
 * 那份文件可能離焦點三跳，根本不在這次選取裡。
 *
 * **證據包必須自帶它**，否則 `sources.md` 裡查不到那個 `item`，
 * 而回溯的終點就落在這份檔案外面 —— 那正是驗收條件要擋的事。
 * 所以來源清單是「被引用的那些」∪「選取範圍裡的資料節點」。
 *
 * ## 這一支不寫資料庫
 *
 * 引文的位置變了也不更新 `edge_evidence`，點註的 `anchor_ok` 也不重寫。
 * **匯出是唯讀的動作** —— 理由寫在 `domain/export/verify.ts`。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseSelectors, pickPosition } from '../domain/annotation/index.js';
import type { ErrorCode } from '../domain/errors/codes.js';
import {
  checkQuote,
  countQuotes,
  evidenceRows,
  packFolderName,
  renderJsonl,
  renderPack,
  renderSources,
  type EvidencePack,
  type PackEdge,
  type PackNote,
  type PackQuote,
  type PackSource,
} from '../domain/export/index.js';
import type { ProjectionThresholds, SubgraphFilters } from '../domain/graph/index.js';
import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as edges from '../infrastructure/db/repositories/edge-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as noteRepo from '../infrastructure/db/repositories/note-repo.js';
import { readDerived, type DerivedPayload } from '../infrastructure/fs/case-files.js';
import { backupsDir, casesDir, exportsDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';
import { resolveNotes } from './note-service.js';
import { subgraph, type SubgraphEdge, type SubgraphNode } from './graph-service.js';

const CASE_DB_FILE = 'case.sqlite';

const PACK_FILE = 'evidence-pack.md';
const SOURCES_FILE = 'sources.md';
const ROWS_FILE = 'evidence.jsonl';

export interface ExportRequest {
  readonly focus: string | null;
  readonly hops: number;
  readonly filters: SubgraphFilters;
  readonly thresholds: ProjectionThresholds;
  /**
   * 只匯出這幾個節點。**`null` ＝ 整塊子圖**。
   *
   * 空陣列與 `null` 不一樣：空陣列是「我一個都沒選」，
   * 那是 `EXPORT_EMPTY_SELECTION`，不是「全選」。
   */
  readonly nodeIds: readonly string[] | null;
}

export interface ExportSummary {
  /** 匯出到哪。**畫面要顯示它** —— 不然使用者找不到剛剛產生的檔案。 */
  readonly folder: string;
  readonly files: readonly string[];
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly noteCount: number;
  readonly sourceCount: number;
  readonly quoteCount: number;
  readonly verified: number;
  readonly shifted: number;
  readonly missing: number;
  readonly projectedOmitted: number;
  /** `EXPORT_EVIDENCE_MISSING`：有引文回溯不到。**檔案照樣產生，而且標明了。** */
  readonly notice: ErrorCode | null;
}

function folderOf(dataRoot: string, slug: string): string {
  return join(casesDir(dataRoot), slug);
}

/** 只挑真的存在於資料庫的邊。**投影線不是關聯**，它每次打開都重算。 */
function isReal(edge: SubgraphEdge): boolean {
  return !edge.synthetic;
}

export async function exportEvidence(
  dataRoot: string,
  slug: string,
  request: ExportRequest,
): Promise<Result<ExportSummary>> {
  const cid = correlationId();

  // ── 一 · 拿到「使用者現在看到的那一塊」──────────────────
  const view = await subgraph(dataRoot, slug, {
    focus: request.focus,
    hops: request.hops,
    filters: request.filters,
    thresholds: request.thresholds,
  });
  if (!view.ok) return view;

  const keep =
    request.nodeIds === null ? new Set(view.data.nodes.map((n) => n.id)) : new Set(request.nodeIds);
  const nodes = view.data.nodes.filter((n) => keep.has(n.id));
  if (nodes.length === 0) {
    return err('EXPORT_EMPTY_SELECTION', cid, {
      asked: request.nodeIds === null ? 'subgraph' : request.nodeIds.length,
    });
  }

  const kept = new Set(nodes.map((n) => n.id));
  const inSelection = view.data.edges.filter((e) => kept.has(e.source) && kept.has(e.target));
  const realEdges = inSelection.filter(isReal);
  const projectedOmitted = inSelection.length - realEdges.length;

  // ── 二 · 抓出處、點註與來源 ────────────────────────────
  const folder = folderOf(dataRoot, slug);
  const opened = await openCaseDatabase(join(folder, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new')
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  if (opened.kind === 'migrate-failed') return err('CASE_SCHEMA_MIGRATE_FAILED', cid, {});

  let pack: EvidencePack;
  try {
    const caseRow = readCase(opened.db);
    if (caseRow === null) return err('CASE_NOT_FOUND', cid, { slug });
    pack = await buildPack(opened.db, folder, {
      caseName: caseRow.name,
      focusTitle: nodes.find((n) => n.id === view.data.focus)?.title ?? view.data.focus,
      hops: view.data.hops,
      nodes,
      edges: realEdges,
      projectedOmitted,
    });
  } finally {
    opened.db.close();
  }

  // ── 三 · 寫檔 ──────────────────────────────────────────
  const target = join(exportsDir(dataRoot, slug), packFolderName(pack.exportedAt));
  const rows = evidenceRows(pack);
  try {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, PACK_FILE), renderPack(pack), 'utf8');
    await writeFile(join(target, SOURCES_FILE), renderSources(pack), 'utf8');
    await writeFile(join(target, ROWS_FILE), renderJsonl(rows), 'utf8');
  } catch (e) {
    // 磁碟滿、權限不足、路徑被佔用 —— **對使用者是同一件事：換一個地方**。
    return err('EXPORT_TARGET_NOT_WRITABLE', cid, { reason: String((e as Error).message) });
  }

  const counts = countQuotes(pack);
  return ok(
    {
      folder: target,
      files: [PACK_FILE, SOURCES_FILE, ROWS_FILE],
      nodeCount: nodes.length,
      edgeCount: realEdges.length,
      noteCount: pack.notes.length,
      sourceCount: pack.sources.length,
      quoteCount: counts.total,
      verified: counts.verified,
      shifted: counts.shifted,
      missing: counts.missing,
      projectedOmitted,
      notice: counts.missing > 0 ? ('EXPORT_EVIDENCE_MISSING' as ErrorCode) : null,
    },
    cid,
  );
}

// ── 組裝 ──────────────────────────────────────────────────

interface BuildInput {
  readonly caseName: string;
  readonly focusTitle: string;
  readonly hops: number;
  readonly nodes: readonly SubgraphNode[];
  readonly edges: readonly SubgraphEdge[];
  readonly projectedOmitted: number;
}

async function buildPack(
  db: DatabaseSync,
  folder: string,
  input: BuildInput,
): Promise<EvidencePack> {
  /** 同一份的 `derived/` 只讀一次 —— 一條邊上有五筆出處指同一份是正常的。 */
  const derivedCache = new Map<string, DerivedPayload | null>();
  const textOf = async (itemId: string): Promise<string | null> => {
    if (!derivedCache.has(itemId)) derivedCache.set(itemId, await readDerived(folder, itemId));
    return derivedCache.get(itemId)?.text ?? null;
  };

  const itemCache = new Map<string, items.ItemRow | null>();
  const itemOf = (itemId: string): items.ItemRow | null => {
    if (!itemCache.has(itemId)) itemCache.set(itemId, items.getItem(db, itemId));
    return itemCache.get(itemId) ?? null;
  };

  /** 被引用到的那些 `item`，照第一次被引用的順序。 */
  const cited: string[] = [];

  const packEdges: PackEdge[] = [];
  for (const edge of input.edges) {
    const quotes: PackQuote[] = [];
    // **兩種邊不去讀它的引文**，而理由不一樣：
    // 已否決的是「你判斷過它不成立」，Markdown 那邊只列一行；
    // 其餘三層是「照設計就沒有出處」（ADR-0015），它們列成一張表。
    if (edge.status !== 'rejected' && edge.layer === 'named') {
      for (const row of edges.evidenceRows(db, edge.id)) {
        const item = itemOf(row.itemId);
        const check = checkQuote(await textOf(row.itemId), row.quote, row.charStart, row.charEnd);
        quotes.push({
          itemId: row.itemId,
          itemTitle: row.itemTitle,
          quote: row.quote,
          status: check.status,
          start: check.start,
          end: check.end,
          recordedStart: row.charStart,
          recordedEnd: row.charEnd,
          snapshotSha256: item?.sha256 ?? null,
          page: null,
          rect: null,
        });
        if (!cited.includes(row.itemId)) cited.push(row.itemId);
      }
    }
    packEdges.push({
      id: edge.id,
      rel: edge.rel,
      sourceTitle: titleOf(input.nodes, edge.source),
      targetTitle: titleOf(input.nodes, edge.target),
      directional: edge.directional,
      layer: edge.layer,
      status: edge.status,
      origin: edge.origin,
      tier: edge.tier,
      evidenceCount: edge.evidenceCount,
      independentSourceCount: edge.independentSourceCount,
      previouslyRejected: edge.previouslyRejected,
      quotes,
    });
  }

  // ── 點註 ────────────────────────────────────────────────
  const noteIds = input.nodes.filter((n) => n.kind === 'item' && n.subKind === 'note');
  const noteRows = noteIds
    .map((n) => noteRepo.getNote(db, n.id))
    .filter((r): r is noteRepo.NoteRow => r !== null);
  // **解析用閱讀器那一支**，不重寫一份。
  const resolved = await resolveNotes(db, folder, noteRows);

  const packNotes: PackNote[] = resolved.map((r) => {
    const position = pickPosition(parseSelectors(r.note.selectorJson));
    const recordedStart = position?.start ?? 0;
    const recordedEnd = position?.end ?? 0;

    let quote: PackQuote | null = null;
    if (r.note.itemId !== null) {
      const hit = r.hit;
      quote = {
        itemId: r.note.itemId,
        itemTitle: r.targetTitle ?? r.note.itemId,
        quote: r.quote,
        status:
          hit.kind === 'not-found' ? 'missing' : hit.kind === 'shifted' ? 'shifted' : 'verified',
        start: hit.kind === 'exact' || hit.kind === 'shifted' ? hit.start : recordedStart,
        end: hit.kind === 'exact' || hit.kind === 'shifted' ? hit.end : recordedEnd,
        recordedStart,
        recordedEnd,
        snapshotSha256: r.note.snapshotSha256,
        page: hit.kind === 'exact' || hit.kind === 'shifted' ? hit.page : null,
        rect: hit.kind === 'rect' ? hit.rect : null,
      };
      if (!cited.includes(r.note.itemId)) cited.push(r.note.itemId);
    }
    return { id: r.note.id, body: r.note.body, createdAt: r.note.createdAt, quote };
  });

  // ── 來源清單 ────────────────────────────────────────────
  // 被引用的優先，再補上選取範圍裡其餘的資料節點。
  // **點註不算來源** —— 它是自己寫的，混進來會讓這份看起來比實際上更有出處。
  const sourceIds = [...cited];
  for (const node of input.nodes) {
    if (node.kind !== 'item' || node.subKind === 'note') continue;
    if (!sourceIds.includes(node.id)) sourceIds.push(node.id);
  }

  const sources: PackSource[] = [];
  for (const id of sourceIds) {
    const row = itemOf(id);
    if (row === null || row.kind === 'note') continue;
    sources.push({
      id: row.id,
      title: row.title,
      kind: row.kind,
      lang: row.lang,
      sourceUrl: row.sourceUrl ?? row.requestedUrl,
      fetchedAt: row.fetchedAt,
      sha256: row.sha256,
      sourceExt: row.sourceExt,
      lowConfidence: row.lowConfidence,
      lowConfidenceReasons: row.lowConfidenceReasons,
    });
  }

  // **只有具名關係進那三組。** 其餘三層是機器算出來的結構，不是主張 ——
  // 混在一起的話，一個只有一條開放問題的專題看起來像有九條。
  const byStatus = (status: SubgraphEdge['status']): readonly PackEdge[] =>
    packEdges.filter((e) => e.layer === 'named' && e.status === status);

  return {
    caseName: input.caseName,
    focusTitle: input.focusTitle,
    hops: input.hops,
    exportedAt: Date.now(),
    nodeCount: input.nodes.length,
    edgeCount: input.edges.length,
    confirmed: byStatus('confirmed'),
    pending: byStatus('pending'),
    rejected: byStatus('rejected'),
    structural: packEdges.filter((e) => e.layer !== 'named'),
    notes: packNotes,
    sources,
    projectedOmitted: input.projectedOmitted,
  };
}

/**
 * 邊的兩端在畫面上叫什麼。
 *
 * **找不到就退回 id** —— 一條邊的某一端被篩選掉是可能的，
 * 而在證據包裡印一個空白比印一個 id 糟：id 至少查得到。
 */
function titleOf(nodes: readonly SubgraphNode[], id: string): string {
  return nodes.find((n) => n.id === id)?.title ?? id;
}
