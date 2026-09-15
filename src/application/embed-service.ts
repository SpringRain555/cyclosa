/**
 * 向量的寫入：**匯入時寫一份，回填補上以前的。**
 *
 * ## 匯入時寫是「盡力而為」，而那跟檢索的規則刻意相反
 *
 * | | 沒設定嵌入模型時 |
 * |---|---|
 * | **檢索** | 停手並說出來（`SEARCH_EMBED_UNAVAILABLE`）—— **不假裝有語意檢索** |
 * | **匯入** | 照常匯入，只是沒有向量 |
 *
 * 兩邊不一樣是因為問的問題不一樣。檢索那一邊使用者**要求了**語意，
 * 給他一份只有全文的結果卻不說，就是靜默降級（ADR-0006 第 3 條）。
 * 匯入這一邊使用者要的是「把這份東西收進來」——
 * **而這個工具的其餘部分完全不需要模型**（`providers/config.ts` 檔頭）。
 * 因為沒設嵌入模型就擋下匯入，等於把一個可選功能變成必要條件。
 *
 * 代價是**「沒有向量」變成一個安靜的狀態**，所以它要有一個地方看得見：
 * `countItemsMissingVectors` 就是那個地方，設定頁與搜尋面板都讀它。
 *
 * ## 回填不是一個 `run`
 *
 * 匯入與擴展是 `run`，因為它們**做完就沒有第二次機會**
 * （抓過的網址不會再抓一遍），所以要逐項留下發生了什麼。
 *
 * 回填不是那種東西：**它的續跑點就是查詢本身**
 * （`itemsMissingVectors` ＝ 還沒做的），中斷之後再按一次就從那裡接下去。
 * 給它一個 `run` 會讓畫面上出現「取消」與「復原」，
 * 而那兩個動作對它都沒有意義 —— **一個假的取消按鈕比沒有更糟。**
 *
 * 所以它是**有界的一批**：一次做 `BATCH_ITEMS` 份，回報還剩幾份，
 * 由呼叫端決定要不要再來一次。
 */
import { join } from 'node:path';

import { chunkText, type Chunk } from '../domain/search/chunk.js';
import type { ErrorCode } from '../domain/errors/codes.js';
import {
  openCaseDatabase,
  withTransaction,
  type DatabaseSync,
} from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as vectors from '../infrastructure/db/repositories/vector-repo.js';
import { loadItems, type ItemRow } from '../infrastructure/db/repositories/item-repo.js';
import { readDerived } from '../infrastructure/fs/case-files.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { loadProviders, type Providers } from '../infrastructure/providers/registry.js';
import type { EmbedProvider } from '../infrastructure/providers/embed-ollama.js';
import { correlationId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';

const CASE_DB_FILE = 'case.sqlite';

/**
 * 一次回填幾份資料。
 *
 * 2026-09-09 量到 `qwen3-embedding:4b` 是 **36.6 段／秒**（RTX 5090），
 * 一份文件最多 6 段 —— 所以 60 份大約是 **10 秒**。
 * 那個長度剛好還在「一個 HTTP 請求等得起」的範圍內，
 * 而它同時決定了進度條多久動一次。
 */
export const BATCH_ITEMS = 60;

/**
 * 一份資料的正文。
 *
 * **跟 `search-service.textOf` 是同一個組法**（標題在前、點註讀 `excerpt`）——
 * 兩邊不一樣的話，語意檢索命中的位置會對不上全文檢索驗證的位置。
 */
async function textOf(folder: string, item: ItemRow): Promise<string | null> {
  if (item.kind === 'note')
    return item.excerpt.length > 0 ? `${item.title}\n${item.excerpt}` : null;
  const derived = await readDerived(folder, item.id);
  if (derived === null) return null;
  return `${derived.title}\n${derived.text}`;
}

export interface EmbedOne {
  readonly chunks: number;
  readonly code: ErrorCode | null;
}

/**
 * 替一份資料寫向量。**這一支是匯入與回填共用的那一支。**
 *
 * 回 `chunks: 0` 有兩種原因，而它們不一樣：
 * 正文短到切不出任何一段（`code` 是 `null` —— 那不是錯誤），
 * 或者嵌入呼叫失敗（`code` 有值）。
 */
export async function embedOne(
  db: DatabaseSync,
  folder: string,
  item: ItemRow,
  provider: EmbedProvider,
  signal?: AbortSignal,
): Promise<EmbedOne> {
  const text = await textOf(folder, item);
  if (text === null || text.trim().length === 0) {
    // **正文沒了就把舊向量也清掉。** 留著的話語意檢索會命中一段
    // 已經不存在的文字，而點過去什麼都沒有。
    withTransaction(db, () => vectors.dropVectorsFor(db, 'item', item.id));
    return { chunks: 0, code: null };
  }

  const parts: readonly Chunk[] = chunkText(text);
  if (parts.length === 0) {
    withTransaction(db, () => vectors.dropVectorsFor(db, 'item', item.id));
    return { chunks: 0, code: null };
  }

  const out = await provider.embedDocuments(
    parts.map((p) => p.text),
    signal,
  );
  if (out.kind === 'error') return { chunks: 0, code: out.code };

  const now = Date.now();
  const written = withTransaction(db, () =>
    vectors.replaceVectors(db, {
      ownerKind: 'item',
      ownerId: item.id,
      model: provider.model,
      dim: out.value.dim,
      now,
      rows: parts.map((part, i) => ({
        // **`id` 帶得動段落序號**，所以一列向量指得回它是第幾段 ——
        // 而那是「命中要指得回原文」的一半（另一半是 `chunk` 的偏移量，
        // 它由 `ord` 重算得到，不存第二份）。
        id: `${item.id}#${part.ord}`,
        ownerKind: 'item' as const,
        ownerId: item.id,
        embedding: out.value.vectors[i] as Float32Array,
      })),
    }),
  );
  return { chunks: written, code: null };
}

/**
 * 匯入時順手寫一份。**失敗不影響匯入。**
 *
 * 這一支吞掉錯誤而只寫進日誌，那是這個檔頭那張表的第二列 ——
 * 而「吞掉」在這個專案裡通常是錯的，所以理由要具體：
 * 這一次的失敗**有一個看得見的殘留**（那份資料出現在「還沒有向量」的計數裡），
 * 而且**有一條把它補回來的路**（回填）。兩者都成立才可以吞。
 */
export async function embedOnImport(
  db: DatabaseSync,
  folder: string,
  itemId: string,
  providers: Providers,
): Promise<void> {
  const provider = providers.embed;
  if (provider === null) return;
  const item = loadItems(db, [itemId])[0];
  if (item === undefined) return;
  try {
    const result = await embedOne(db, folder, item, provider);
    if (result.code !== null) {
      logger.warn('匯入時寫向量失敗，之後可以回填', { itemId, code: result.code });
    }
  } catch (e) {
    logger.warn('匯入時寫向量丟例外，之後可以回填', { itemId, reason: String(e) });
  }
}

export interface BackfillReport {
  /** 設定的嵌入模型。**`null` ＝ 沒設定**，那時候其餘欄位都是 0 */
  readonly model: string | null;
  /** 這一批做了幾份 */
  readonly processed: number;
  /** 這一批寫了幾條向量 */
  readonly written: number;
  /** 做完這一批之後還差幾份 */
  readonly remaining: number;
  /** 這個模型現在總共有幾條向量、涵蓋幾個節點 */
  readonly rows: number;
  readonly owners: number;
  /** 這個專題裡還留著哪些**別的模型**的向量。換模型之後要說得出來 */
  readonly otherModels: readonly { readonly model: string; readonly rows: number }[];
  /** 這一批出了什麼錯。**有值就代表沒做完，而且再按一次多半還是一樣** */
  readonly code: ErrorCode | null;
}

/**
 * 回填一批。
 *
 * **不會重算已經有的** —— 判準是「這個模型的向量存不存在」，
 * 所以換模型之後全部都算「沒有」，而舊模型的那些**留著不刪**：
 * 刪掉的話中途停下來就變成兩邊都沒有，而語意檢索會安靜地少一半資料。
 */
export async function backfillVectors(
  dataRoot: string,
  slug: string,
  load: () => Promise<Providers> = loadProviders,
): Promise<Result<BackfillReport>> {
  const cid = correlationId();
  const providers = await load();
  const provider = providers.embed;

  const folder = join(casesDir(dataRoot), slug);
  const opened = await openCaseDatabase(join(folder, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new')
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  if (opened.kind === 'migrate-failed') return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { slug });
  if (opened.kind === 'missing') return err('CASE_NOT_FOUND', cid, { slug });

  const db = opened.db;
  try {
    if (readCase(db) === null) return err('CASE_NOT_FOUND', cid, { slug });

    if (provider === null) {
      // **沒設定模型不是錯誤，是一個狀態。** 回一份說得出「零」的報告，
      // 而不是一個讓畫面顯示紅字的錯誤 —— 使用者根本還沒要求語意檢索。
      return ok(
        {
          model: null,
          processed: 0,
          written: 0,
          remaining: 0,
          rows: 0,
          owners: 0,
          otherModels: vectors.vectorModels(db),
          code: null,
        },
        cid,
      );
    }

    const todo = vectors.itemsMissingVectors(db, provider.model, BATCH_ITEMS);
    const rows = loadItems(
      db,
      todo.map((t) => t.id),
    );

    let processed = 0;
    let written = 0;
    let code: ErrorCode | null = null;
    for (const item of rows) {
      const one = await embedOne(db, folder, item, provider);
      processed++;
      written += one.chunks;
      if (one.code !== null) {
        // **第一個錯誤就停。** 連不上 Ollama 的話，剩下的 59 份會用同樣的方式
        // 各失敗一次 —— 那是 59 次逾時，而且錯誤訊息完全一樣。
        code = one.code;
        break;
      }
    }

    const stats = vectors.vectorStats(db, provider.model);
    return ok(
      {
        model: provider.model,
        processed,
        written,
        remaining: vectors.countItemsMissingVectors(db, provider.model),
        rows: stats.rows,
        owners: stats.owners,
        otherModels: vectors.vectorModels(db).filter((m) => m.model !== provider.model),
        code,
      },
      cid,
    );
  } finally {
    db.close();
  }
}

/** 一次查詢用的 id。**段落級的向量 id 是 `<itemId>#<ord>`。** */
export function ownerOfVectorId(id: string): { itemId: string; ord: number } {
  const at = id.lastIndexOf('#');
  if (at < 0) return { itemId: id, ord: 0 };
  const ord = Number(id.slice(at + 1));
  return { itemId: id.slice(0, at), ord: Number.isFinite(ord) ? ord : 0 };
}

/** 產生一個新的向量 id —— **測試與未來的實體／點註向量會用到。** */
export function vectorIdFor(ownerId: string, ord: number): string {
  return `${ownerId}#${ord}`;
}
