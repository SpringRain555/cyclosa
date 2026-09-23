/**
 * 資料節點與閱讀器的用例。
 *
 * **閱讀器讀的是 `derived/`，「看原始快照」讀的是 `sources/`** ——
 * 兩者不是同一份東西，而使用者要能在它們之間切換（ADR-0003、ADR-0010）。
 */
import { join } from 'node:path';

import { nextItemStatus, type ItemStatus } from '../domain/ingest/state.js';
import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as research from '../infrastructure/db/repositories/research-repo.js';
import { dropIndexFor } from '../infrastructure/index/writer.js';
import {
  isStaleDerived,
  readDerived,
  readSnapshot,
  type DerivedPayload,
} from '../infrastructure/fs/case-files.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';

const CASE_DB_FILE = 'case.sqlite';
const HEX64 = /^[0-9a-f]{64}$/;

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

export interface ItemListQuery {
  readonly sort?: 'recent' | 'title';
  readonly limit?: number;
  readonly cursor?: string | undefined;
  readonly status?: ItemStatus | undefined;
  readonly lowConfidenceOnly?: boolean;
  readonly unreadOnly?: boolean;
}

export async function listItems(
  dataRoot: string,
  slug: string,
  query: ItemListQuery,
): Promise<Result<items.ItemPage>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const page = items.listItems(db, {
      sort: query.sort ?? 'recent',
      // 上限鎖在 200：這是一頁清單，不是匯出。**沒有「全部拿回來」這個選項。**
      limit: Math.min(Math.max(query.limit ?? 50, 1), 200),
      cursor: query.cursor,
      status: query.status,
      onlyLowConfidence: query.lowConfidenceOnly === true,
      unreadOnly: query.unreadOnly === true,
    });
    return ok(page, cid);
  });
}

export interface ItemDetail {
  readonly item: items.ItemRow;
  /** 同一個排序下的前後兩份 —— 閱讀器的「312 份中的第 N 份」要用它。 */
  readonly neighbours: { readonly previous: string | null; readonly next: string | null };
  readonly position: { readonly index: number; readonly total: number };
  /**
   * 這一份是一次**還沒結束的研究**的候選（ADR-0033 D8，Stage 20）。
   *
   * 抓回來的候選就是資料節點，閱讀器裡可以先讀 —— **但它還沒被確認**，
   * 而且閘門三之前一條關聯都不會從它抽出來。閱讀器頂部那一行「候選 · 研究『…』還沒確認」就讀這一欄。
   */
  readonly candidacy: { readonly researchId: string; readonly topic: string } | null;
}

export async function getItem(
  dataRoot: string,
  slug: string,
  itemId: string,
): Promise<Result<ItemDetail>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const row = items.getItem(db, itemId);
    if (row === null) return err('GRAPH_NODE_NOT_FOUND', cid, { itemId });

    // 「第 N 份，共 M 份」與上一份／下一份走的是**跟左邊那張清單一樣的集合** ——
    // 不含點註。兩邊用不同的集合的話，「共 4 份」下面會只列出 1 份。
    const ordered = db
      .prepare(
        `SELECT id FROM item WHERE status != 'excluded' AND kind != 'note'
         ORDER BY created_at DESC, id DESC`,
      )
      .all() as { id?: unknown }[];
    const ids = ordered.map((r) => String(r['id']));
    const index = ids.indexOf(itemId);

    return ok(
      {
        item: row,
        neighbours: {
          previous: index > 0 ? (ids[index - 1] as string) : null,
          next: index >= 0 && index + 1 < ids.length ? (ids[index + 1] as string) : null,
        },
        position: { index: index < 0 ? 0 : index + 1, total: ids.length },
        candidacy: research.openCandidacyOf(db, itemId),
      },
      cid,
    );
  });
}

export interface ItemContent {
  readonly item: items.ItemRow;
  readonly derived: DerivedPayload | null;
  /** 這份正文是舊版抽取器抽的 —— 按「重算全部正文」才會換成新的。閱讀器要說出來。 */
  readonly stale: boolean;
}

/** 閱讀器的正文。**`derived/` 不見了不是災難** —— 重抽就有了，快照還在。 */
export async function getItemContent(
  dataRoot: string,
  slug: string,
  itemId: string,
): Promise<Result<ItemContent>> {
  return withCase(dataRoot, slug, async (db, folder) => {
    const cid = correlationId();
    const row = items.getItem(db, itemId);
    if (row === null) return err('GRAPH_NODE_NOT_FOUND', cid, { itemId });
    const derived = await readDerived(folder, itemId);
    // 只對「那一版之後這一種資料真的改過」的才說舊版（`EXTRACTOR_CHANGES`）——
    // v2 只改了 PDF，網頁也標舊版的話只會叫人去按一顆沒有用的按鈕。
    return ok({ item: row, derived, stale: derived !== null && isStaleDerived(derived) }, cid);
  });
}

export interface SnapshotBytes {
  readonly bytes: Buffer;
  readonly mime: string;
}

/** 原始快照。**不可變**，而且是點註真正錨定的地方。 */
export async function getSnapshot(
  dataRoot: string,
  slug: string,
  itemId: string,
): Promise<Result<SnapshotBytes>> {
  return withCase(dataRoot, slug, async (db, folder) => {
    const cid = correlationId();
    const row = items.getItem(db, itemId);
    if (row === null) return err('GRAPH_NODE_NOT_FOUND', cid, { itemId });
    if (row.sha256 === null || row.sourceExt === null) {
      return err('IO_SNAPSHOT_MISSING', cid, { itemId });
    }
    // 雜湊是我們自己寫的，但**檔名會被組進路徑**，所以還是驗一次形狀。
    if (!HEX64.test(row.sha256)) return err('IO_SNAPSHOT_CORRUPT', cid, { itemId });

    try {
      const bytes = await readSnapshot(folder, row.sha256, row.sourceExt);
      return ok({ bytes, mime: row.mime ?? 'application/octet-stream' }, cid);
    } catch {
      return err('IO_SNAPSHOT_MISSING', cid, { itemId });
    }
  });
}

/** **已讀是正交旗標，不是狀態轉移。** */
export async function markRead(
  dataRoot: string,
  slug: string,
  itemId: string,
  read: boolean,
): Promise<Result<number | null>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    if (items.getItem(db, itemId) === null) return err('GRAPH_NODE_NOT_FOUND', cid, { itemId });
    const at = read ? Date.now() : null;
    items.setReadAt(db, itemId, at);
    return ok(at, cid);
  });
}

export interface ReadReset {
  /** 現在有幾份標著已讀。**確認那句話要說出這個數字。** */
  readonly read: number;
  /** 真的被清掉幾份。沒帶 `force` 的那一次是 0。 */
  readonly cleared: number;
  /** 這一次到底做了沒有。 */
  readonly done: boolean;
}

/**
 * 整個專題全部標成未讀。
 *
 * ## 兩段式，而且門在伺服器端
 *
 * 沒帶 `force` 只回「有幾份標著已讀」，**什麼都不改**；帶了才真的清。
 * 形狀跟 `POST /api/system/shutdown` 一樣，理由也一樣：
 * **把二次確認只做在前端的話，它是一個繞得過的提醒**，
 * 而這個動作沒有回頭路 —— 哪幾份讀過是使用者累積出來的資訊。
 *
 * ## 它有一個跨模組的副作用，而確認文案必須說出來
 *
 * `domain/run/undo.ts` 把 **`item.read === true` 當成「人動過這一份」**
 * 的三種訊號之一，而復原一次作業時「人動過的」會被留下來。
 * 也就是說：**把已讀全部清掉，會讓既有作業的「復原」刪掉更多東西。**
 *
 * 這不是這個功能的 bug，是它真的做的事 —— 而使用者按下去之前有權知道。
 */
export async function clearAllRead(
  dataRoot: string,
  slug: string,
  force: boolean,
): Promise<Result<ReadReset>> {
  return withCase<ReadReset>(dataRoot, slug, (db) => {
    const cid = correlationId();
    const read = items.countRead(db);
    if (!force) return ok({ read, cleared: 0, done: false }, cid);
    return ok({ read, cleared: items.clearAllReadAt(db), done: true }, cid);
  });
}

/**
 * 已排除／復原。**只有人能做**（state-machines）——
 * 所以這支的 actor 寫死成 `human`，而不是從呼叫端傳進來。
 */
export async function changeItemStatus(
  dataRoot: string,
  slug: string,
  itemId: string,
  action: 'exclude' | 'restore',
): Promise<Result<ItemStatus>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const row = items.getItem(db, itemId);
    if (row === null) return err('GRAPH_NODE_NOT_FOUND', cid, { itemId });

    const to = nextItemStatus(row.status, action, 'human');
    if (to === null) return err('GRAPH_TRANSITION_INVALID', cid, { from: row.status, action });

    items.setStatus(db, itemId, to, Date.now());
    // 排除掉的東西不該還出現在檢索結果裡。**復原時會在重抽或重算索引時補回來** ——
    // 而目前復原之後那一份會回到「待處理」，本來就要重跑一次。
    if (to === 'excluded') dropIndexFor(db, 'item', itemId);
    return ok(to, cid);
  });
}

/** 要重試的那個 URL。**重試不產生第二個節點**，所以呼叫端拿它去跑匯入。 */
export async function urlForRetry(
  dataRoot: string,
  slug: string,
  itemId: string,
): Promise<Result<string>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const row = items.getItem(db, itemId);
    if (row === null) return err('GRAPH_NODE_NOT_FOUND', cid, { itemId });
    if (row.requestedUrl === null) {
      // 上傳的檔案沒有 URL 可以重抓 —— 要重來只能再拖一次檔案。
      return err('GRAPH_TRANSITION_INVALID', cid, { why: 'no-url' });
    }
    return ok(row.requestedUrl, cid);
  });
}

export async function caseStats(
  dataRoot: string,
  slug: string,
): Promise<
  Result<{ readonly snapshotBytes: number; readonly byStatus: Readonly<Record<string, number>> }>
> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    return ok(
      { snapshotBytes: items.totalSnapshotBytes(db), byStatus: items.countByStatus(db) },
      cid,
    );
  });
}
