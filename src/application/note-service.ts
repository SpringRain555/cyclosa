/**
 * 筆記與點註的用例（Stage 10）。
 *
 * ## 選擇器是伺服器建的，不是前端送過來的
 *
 * 前端只送**位置**（起訖字元，或圖片上的矩形），引文與前後文由這裡從
 * `derived/` 切出來。
 *
 * 那個分工不是為了省頻寬 —— 是為了讓「引文一定真的在那個位置上」
 * 成為一件**做不到相反的事**。前端送引文的話，一個舊分頁、一個沒重整的畫面、
 * 一個改過的 JS，都能存進一則「引文與位置對不上」的點註，
 * 而那種點註在畫面上跟正確的一模一樣。
 *
 * 同一個形狀在 Stage 9 已經出現過一次（模型給的字元位置一律丟掉，自己找）。
 * **兩次的判準相同：一個指錯位置的引用比沒有引用更糟，因為它看起來已經驗過了。**
 *
 * ## 一則點註寫三個地方
 *
 * | 寫到哪 | 為什麼 |
 * |---|---|
 * | `item`（`kind='note'`）| 它要能出現在圖上、參與關聯（ADR-0010 第 4 條）|
 * | `note` | 錨點本身 |
 * | `notes\<id>.md` | **離開這個工具也讀得到**（ADR-0010 第 3 條）|
 *
 * 前兩個在同一個交易裡，第三個**寫失敗不算失敗** —— 註記已經進資料庫了，
 * 只是純文字那一份沒寫成（`NOTE_MD_WRITE_FAILED`，級別 `partial`）。
 */
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import {
  anchorOk,
  imageSelector,
  parseSelectors,
  pdfSelectors,
  resolveAnchor,
  textSelectors,
  type AnchorHit,
  type Rect,
  type Selector,
} from '../domain/annotation/index.js';
import type { ErrorCode } from '../domain/errors/codes.js';
import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as notes from '../infrastructure/db/repositories/note-repo.js';
import { insertEdge } from '../infrastructure/db/repositories/edge-repo.js';
import { dropIndexFor, indexText } from '../infrastructure/index/writer.js';
import { notesDir, readDerived, type DerivedPayload } from '../infrastructure/fs/case-files.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId, newId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';

const CASE_DB_FILE = 'case.sqlite';

/** 圖上那個節點的標題長度。太長的節點標籤在圖上會蓋掉旁邊的東西。 */
const TITLE_CHARS = 40;

/**
 * 點註與它標的那一份之間那條線的關係型別。
 *
 * ## 為什麼要有這條線
 *
 * 圖的導覽是「焦點 ＋ 幾跳」（ADR-0008），**所以一個零度數的節點等於不存在** ——
 * 它只有在你已經知道它的 id 的時候才看得到。
 * 一則沒有線的點註「在圖上是一個節點」這句話字面上為真、實際上為假。
 *
 * ## 為什麼是 `named` ＋ `origin='human'` ＋ `已確認`
 *
 * Stage 8 定過這條規則：**手動建立的邊一建立就是已確認、`origin='human'`**。
 * 而這條線正是使用者手動建立的 —— 他在那一份文件裡選了一段字，
 * 那個動作本身就是主張「這則筆記是關於這一份的」。
 *
 * 它不會進裁決佇列（佇列只收 `pending`），也不會被算進校準比例
 * （那只採計 `origin='machine'`）—— 兩件事 Stage 8 都已經擋好了。
 *
 * **這條線可以刪。** 刪掉它不影響錨點：閱讀器照樣標得出來，
 * 因為錨點在 `note` 那張表上，而這條線是它在圖上的說法。
 */
const ANCHOR_REL = '註於';

function folderOf(dataRoot: string, slug: string): string {
  return join(casesDir(dataRoot), slug);
}

async function withCase<T>(
  dataRoot: string,
  slug: string,
  body: (db: DatabaseSync, folder: string) => Promise<Result<T>> | Result<T>,
): Promise<Result<T>> {
  const cid = correlationId();
  const folder = folderOf(dataRoot, slug);
  const opened = await openCaseDatabase(join(folder, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new')
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  if (opened.kind === 'migrate-failed')
    return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { at: opened.at });
  if (opened.kind === 'missing') return err('CASE_NOT_FOUND', cid, { slug });

  try {
    if (readCase(opened.db) === null) return err('CASE_NOT_FOUND', cid, { slug });
    return await body(opened.db, folder);
  } finally {
    opened.db.close();
  }
}

// ── 解析 ──────────────────────────────────────────────────

/** 一則點註 ＋ **它現在解到哪裡**。位置是算出來的，不存。 */
export interface ResolvedNote {
  readonly note: notes.NoteRow;
  readonly hit: AnchorHit;
  /** 引文（從選擇器讀出來的，不是重新切的）。清單上要顯示它。 */
  readonly quote: string;
  /** 標在哪一份上的標題。那一份不在了就是 `null`。 */
  readonly targetTitle: string | null;
  /** 刪掉它會連帶拿掉幾條線。**畫面上要在按下去之前說出這個數字。** */
  readonly edgeCount: number;
}

function targetOf(item: items.ItemRow, derived: DerivedPayload | null) {
  return {
    kind: (derived?.kind ?? (item.kind === 'note' ? 'text' : item.kind)) as
      'web' | 'pdf' | 'image' | 'text',
    text: derived?.text ?? '',
    pages: derived?.pages ?? null,
    width: item.imageWidth,
    height: item.imageHeight,
  };
}

/**
 * 解一批點註。**同一份資料的 `derived/` 只讀一次** ——
 * 一份文件上有 30 則點註是正常的，讀 30 次同一個檔不是。
 */
const NOT_FOUND: AnchorHit = { kind: 'not-found' };

/**
 * **匯出也用這一支**（Stage 11）—— 一則點註「現在解到哪裡」只能有一個答案，
 * 而閱讀器與證據包如果各算各的，兩邊遲早會對同一則給出不同的位置。
 */
export async function resolveNotes(
  db: DatabaseSync,
  folder: string,
  rows: readonly notes.NoteRow[],
): Promise<readonly ResolvedNote[]> {
  const derivedCache = new Map<string, DerivedPayload | null>();
  const edges = notes.edgeCounts(db, ANCHOR_REL);
  const out: ResolvedNote[] = [];

  for (const note of rows) {
    const selectors = parseSelectors(note.selectorJson);
    const quote = selectors.find((s) => s.type === 'TextQuoteSelector')?.exact ?? '';

    if (note.itemId === null) {
      // 標的那一份被刪掉了。**註記本身還在**（error-codes 的 `NOTE_TARGET_MISSING`）。
      out.push({
        note,
        hit: NOT_FOUND,
        quote,
        targetTitle: null,
        edgeCount: edges.get(note.id) ?? 0,
      });
      continue;
    }

    const item = items.getItem(db, note.itemId);
    if (item === null) {
      out.push({
        note,
        hit: NOT_FOUND,
        quote,
        targetTitle: null,
        edgeCount: edges.get(note.id) ?? 0,
      });
      continue;
    }

    if (!derivedCache.has(note.itemId)) {
      derivedCache.set(note.itemId, await readDerived(folder, note.itemId));
    }
    const derived = derivedCache.get(note.itemId) ?? null;

    // **快照換了就不解。** 錨點對的是舊的那一份，而拿新的去解會回一個
    // 看起來成功的位置 —— 那正是 ADR-0010 第 5 條要擋的事。
    const snapshotChanged =
      note.snapshotSha256 !== null && item.sha256 !== null && note.snapshotSha256 !== item.sha256;

    const hit: AnchorHit = snapshotChanged
      ? { kind: 'not-found' }
      : resolveAnchor(targetOf(item, derived), selectors);

    out.push({ note, hit, quote, targetTitle: item.title, edgeCount: edges.get(note.id) ?? 0 });
  }
  return sortByPlace(out);
}

/**
 * 依**在文件裡的位置**排，不依建立時間。
 *
 * 閱讀器右邊那一欄跟左邊的正文是要對照著看的，所以它得跟正文同一個方向 ——
 * 三則的時候看不出差別，三十則的時候「我剛剛標的那一句在哪」就只能一則一則找。
 *
 * **對不上原文的排最後**：它們沒有位置，而硬給一個位置就是在假裝知道。
 */
function sortByPlace(rows: readonly ResolvedNote[]): readonly ResolvedNote[] {
  const key = (r: ResolvedNote): readonly [number, number, number] => {
    if (r.hit.kind === 'not-found') return [2, 0, 0];
    if (r.hit.kind === 'rect') return [1, r.hit.rect.y, r.hit.rect.x];
    return [0, r.hit.page ?? 0, r.hit.start];
  };
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

/**
 * 重解一個專題全部的點註並把 `anchor_ok` 寫回去。
 *
 * **這支就是 `derived/` 整批重算之後要跑的那一步**，
 * 而它回的那三個數字就是 Stage 10 的驗收條件本身。
 */
export async function reresolveAll(
  db: DatabaseSync,
  folder: string,
): Promise<{
  readonly checked: number;
  readonly exact: number;
  readonly shifted: number;
  readonly unresolved: number;
}> {
  const rows = notes.listNotes(db, Number.MAX_SAFE_INTEGER);
  const resolved = await resolveNotes(db, folder, rows);
  const now = Date.now();

  let exact = 0;
  let shifted = 0;
  let unresolved = 0;
  for (const r of resolved) {
    if (r.hit.kind === 'exact' || r.hit.kind === 'rect') exact++;
    else if (r.hit.kind === 'shifted') shifted++;
    else unresolved++;

    const okNow = anchorOk(r.hit);
    if (okNow !== r.note.anchorOk) notes.setAnchorOk(db, r.note.id, okNow, now);
  }
  return { checked: resolved.length, exact, shifted, unresolved };
}

// ── notes\*.md ────────────────────────────────────────────

/**
 * 純 Markdown 的那一份（ADR-0010 第 3 條）。
 *
 * 前置資料刻意只放**識別碼與座標**，引文放進正文的引用區塊 ——
 * 這樣就完全不需要處理 YAML 的跳脫，而一份不需要跳脫的格式
 * 是一份不會因為引文裡有個冒號就壞掉的格式。
 *
 * **無 BOM**（`.md` 的規矩）。
 */
function markdownFor(note: notes.NoteRow, quote: string, page: number | null): string {
  const lines = [
    '---',
    `id: ${note.id}`,
    `item: ${note.itemId ?? ''}`,
    `snapshot: ${note.snapshotSha256 ?? ''}`,
  ];
  if (page !== null) lines.push(`page: ${String(page)}`);
  lines.push(`created: ${new Date(note.createdAt).toISOString()}`, '---', '');

  if (quote.length > 0) {
    for (const line of quote.split('\n')) lines.push(`> ${line}`);
    lines.push('');
  }
  lines.push(note.body, '');
  return lines.join('\n');
}

async function writeMarkdown(
  folder: string,
  note: notes.NoteRow,
  quote: string,
  page: number | null,
): Promise<string | null> {
  try {
    const dir = notesDir(folder);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${note.id}.md`);
    await writeFile(path, markdownFor(note, quote, page), 'utf8');
    return path;
  } catch {
    return null;
  }
}

// ── 建立 ──────────────────────────────────────────────────

export interface NewNoteInput {
  readonly body: string;
  /** 文字選取：`derived/` 正文（PDF 是那一頁）的字元區間。 */
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  /** PDF 的頁碼。**1-based。** */
  readonly page?: number | undefined;
  /** 圖片的矩形。 */
  readonly rect?: Rect | undefined;
}

export interface CreatedNote {
  readonly note: ResolvedNote;
  /** `notes\*.md` 沒寫成的時候是 `NOTE_MD_WRITE_FAILED`。**不是失敗。** */
  readonly notice: ErrorCode | null;
}

/** 圖上那個節點叫什麼。**先用你寫的字，沒寫才退回引文。** */
function titleFor(body: string, quote: string): string {
  const firstLine =
    body
      .split('\n')
      .find((l) => l.trim().length > 0)
      ?.trim() ?? '';
  const source = firstLine.length > 0 ? firstLine : quote;
  const flat = source.replace(/\s+/g, ' ').trim();
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS)}…` : flat;
}

/** 三種來源建出來的東西正規化成同一個形狀，呼叫端才不必分三路。 */
type Built =
  | {
      readonly kind: 'ok';
      readonly selectors: readonly Selector[];
      readonly quote: string;
      readonly page: number | null;
    }
  | { readonly kind: 'too-short' | 'too-long' | 'out-of-range' | 'no-text' };

function buildSelectors(
  item: items.ItemRow,
  derived: DerivedPayload | null,
  input: NewNoteInput,
): Built {
  if (input.rect !== undefined) {
    if (item.imageWidth === null || item.imageHeight === null) return { kind: 'no-text' };
    const built = imageSelector(input.rect, item.imageWidth, item.imageHeight);
    if (built.kind !== 'ok') return built;
    return { kind: 'ok', selectors: built.selectors, quote: '', page: null };
  }

  if (input.start === undefined || input.end === undefined) return { kind: 'out-of-range' };
  if (derived === null) return { kind: 'no-text' };

  if (derived.kind === 'pdf') {
    const page = input.page ?? 1;
    const pageText = derived.pages?.[page - 1];
    if (pageText === undefined) return { kind: 'out-of-range' };
    const built = pdfSelectors(pageText, page, input.start, input.end);
    if (built.kind !== 'ok') return built;
    return { kind: 'ok', selectors: built.selectors, quote: built.value.exact, page };
  }

  if (derived.text.length === 0) return { kind: 'no-text' };
  const built = textSelectors(derived.text, input.start, input.end);
  if (built.kind !== 'ok') return built;
  return { kind: 'ok', selectors: built.selectors, quote: built.value.exact, page: null };
}

const BUILD_FAILURE: Readonly<Record<string, ErrorCode>> = {
  'too-short': 'NOTE_ANCHOR_UNRESOLVED',
  'too-long': 'NOTE_ANCHOR_UNRESOLVED',
  'out-of-range': 'NOTE_ANCHOR_UNRESOLVED',
  'no-text': 'NOTE_TARGET_MISSING',
};

export async function createNote(
  dataRoot: string,
  slug: string,
  itemId: string,
  input: NewNoteInput,
): Promise<Result<CreatedNote>> {
  return withCase(dataRoot, slug, async (db, folder) => {
    const cid = correlationId();

    const item = items.getItem(db, itemId);
    if (item === null) return err('GRAPH_NODE_NOT_FOUND', cid, { itemId });
    // **點註不能標在點註上。** 那條路會長出一棵深度不明的樹，
    // 而「這句話出自哪裡」的答案會變成另一則筆記而不是一份資料。
    if (item.kind === 'note') return err('NOTE_TARGET_MISSING', cid, { why: 'note-on-note' });

    const derived = await readDerived(folder, itemId);
    const built = buildSelectors(item, derived, input);
    if (built.kind !== 'ok') {
      return err(BUILD_FAILURE[built.kind] ?? 'NOTE_UNEXPECTED', cid, { why: built.kind });
    }

    const { selectors, quote, page } = built;
    const now = Date.now();

    const row = notes.insertNote(db, {
      id: newId(),
      itemId,
      title: titleFor(input.body, quote),
      body: input.body,
      selectorJson: JSON.stringify(selectors),
      // **這就是「錨在不可變的快照上」。** 那一份換了，這裡就對不上。
      snapshotSha256: item.sha256,
      anchorOk: true,
      now,
    });

    // 引文與正文都要能被檢索到。**owner 是 `item`** —— 一則點註就是一個 item，
    // 而搜尋結果上「它是筆記」由 `item.kind` 說，不需要第二套 owner 型別。
    items.setExcerpt(db, row.id, [quote, input.body].filter((s) => s.length > 0).join('\n'));
    indexText(db, {
      ownerKind: 'item',
      ownerId: row.id,
      lang: item.lang,
      title: titleFor(input.body, quote),
      text: `${quote}\n${input.body}`,
    });

    // 圖上那條線。**它是使用者的動作的結果，不是機器的推論。**
    insertEdge(
      db,
      {
        layer: 'named',
        rel: ANCHOR_REL,
        source: row.id,
        sourceKind: 'item',
        target: itemId,
        targetKind: 'item',
        origin: 'human',
        confidence: 1,
      },
      now,
    );

    const mdPath = await writeMarkdown(folder, row, quote, page);
    if (mdPath !== null) notes.setMdPath(db, row.id, mdPath);

    const stored = notes.getNote(db, row.id) as notes.NoteRow;
    return ok(
      {
        note: {
          note: stored,
          hit: resolveAnchor(targetOf(item, derived), selectors),
          quote,
          targetTitle: item.title,
          edgeCount: 0,
        },
        notice: mdPath === null ? ('NOTE_MD_WRITE_FAILED' as ErrorCode) : null,
      },
      cid,
    );
  });
}

// ── 讀 ────────────────────────────────────────────────────

export async function listNotesForItem(
  dataRoot: string,
  slug: string,
  itemId: string,
): Promise<Result<readonly ResolvedNote[]>> {
  return withCase(dataRoot, slug, async (db, folder) => {
    const cid = correlationId();
    const rows = notes.listNotesFor(db, itemId);
    return ok(await resolveNotes(db, folder, rows), cid);
  });
}

export async function listAllNotes(
  dataRoot: string,
  slug: string,
): Promise<Result<readonly ResolvedNote[]>> {
  return withCase(dataRoot, slug, async (db, folder) => {
    const cid = correlationId();
    return ok(await resolveNotes(db, folder, notes.listNotes(db)), cid);
  });
}

// ── 改與刪 ────────────────────────────────────────────────

/** 改註記內容。**錨點不動。** 改的是你寫的字，不是你標的位置。 */
export async function updateNote(
  dataRoot: string,
  slug: string,
  noteId: string,
  body: string,
): Promise<Result<CreatedNote>> {
  return withCase(dataRoot, slug, async (db, folder) => {
    const cid = correlationId();
    const existing = notes.getNote(db, noteId);
    if (existing === null) return err('GRAPH_NODE_NOT_FOUND', cid, { noteId });

    const now = Date.now();
    notes.updateBody(db, noteId, body, now);

    const selectors = parseSelectors(existing.selectorJson);
    const quote = selectors.find((s) => s.type === 'TextQuoteSelector')?.exact ?? '';
    const title = titleFor(body, quote);
    items.setTitle(db, noteId, title, now);
    items.setExcerpt(db, noteId, [quote, body].filter((s) => s.length > 0).join('\n'));
    indexText(db, {
      ownerKind: 'item',
      ownerId: noteId,
      lang: 'und',
      title,
      text: `${quote}\n${body}`,
    });

    const updated = notes.getNote(db, noteId) as notes.NoteRow;
    const page = selectors
      .map((s) => (s.type === 'FragmentSelector' ? /^#page=(\d+)$/.exec(s.value)?.[1] : undefined))
      .find((v) => v !== undefined);
    const mdPath = await writeMarkdown(
      folder,
      updated,
      quote,
      page === undefined ? null : Number(page),
    );

    const [resolved] = await resolveNotes(db, folder, [updated]);
    return ok(
      {
        note: resolved as ResolvedNote,
        notice: mdPath === null ? ('NOTE_MD_WRITE_FAILED' as ErrorCode) : null,
      },
      cid,
    );
  });
}

export interface DeletedNote {
  readonly id: string;
  /** 順便被拿掉的線有幾條。**刪之前畫面上要說出這個數字。** */
  readonly removedEdges: number;
}

export async function deleteNote(
  dataRoot: string,
  slug: string,
  noteId: string,
): Promise<Result<DeletedNote>> {
  return withCase(dataRoot, slug, async (db, folder) => {
    const cid = correlationId();
    const existing = notes.getNote(db, noteId);
    if (existing === null) return err('GRAPH_NODE_NOT_FOUND', cid, { noteId });

    const removedEdges = notes.edgeCountFor(db, noteId);
    db.prepare('DELETE FROM edge WHERE source_id = ? OR target_id = ?').run(noteId, noteId);
    dropIndexFor(db, 'item', noteId);
    notes.deleteNote(db, noteId);

    // 純文字那一份跟著走。**刪不掉不算失敗** —— 資料庫那邊已經沒有它了。
    if (existing.mdPath !== null) await rm(existing.mdPath, { force: true }).catch(() => undefined);
    else await rm(join(notesDir(folder), `${noteId}.md`), { force: true }).catch(() => undefined);

    return ok({ id: noteId, removedEdges }, cid);
  });
}
