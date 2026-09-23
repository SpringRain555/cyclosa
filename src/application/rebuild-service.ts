/**
 * `derived/` 整批重算。
 *
 * ## 為什麼這件事要有一顆按鈕
 *
 * 這個專案有兩層資料，而**只有一層是可以丟掉的**：
 *
 * | | 可不可以重生 |
 * |---|---|
 * | `sources/` | **不行。** 那是抓回來的原始位元組，網站關了就沒了 |
 * | `derived/` | **可以。** 它是抽取的結果，而抽取會改版（ADR-0003）|
 *
 * 「可以重生」如果沒有一條真的跑得起來的路，那就只是一句話。
 * 而它同時是 v0.6.0 的驗收條件：
 * **`derived/` 整批重算前後，每個點註的解析結果差異必須為 0。**
 *
 * 所以這支回的不是「完成」，是**三個數字**：對得上幾則、位移了幾則、
 * 對不上幾則。使用者按完看到的就是那條驗收本身。
 *
 * ## 重算不碰兩樣東西
 *
 * 1. **`sources/`** —— 一個位元組都不動，只讀。
 * 2. **人的判定** —— `status` 不重設（`markReextracted` 而不是 `markParsed`），
 *    `origin='human'` 的邊不看也不動。
 *
 * 第 2 條是這個專案反覆出現的同一條規則：**機器永遠不得覆寫人工判定。**
 * 「重算」聽起來最無害，而它正是最容易把那條規則洗掉的動作 ——
 * 因為它處理的是「衍生物」，而一份被排除的資料看起來也像衍生物。
 */
import { join } from 'node:path';

import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import { detectLanguage } from '../infrastructure/extract/language.js';
import {
  clearDerived,
  readDerived,
  readSnapshot,
  writeDerived,
  type DerivedPayload,
} from '../infrastructure/fs/case-files.js';
import * as edges from '../infrastructure/db/repositories/edge-repo.js';
import { checkQuote } from '../domain/export/verify.js';
import { dropVectorsFor } from '../infrastructure/db/repositories/vector-repo.js';
import { indexText } from '../infrastructure/index/writer.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';
import { extract } from './ingest-service.js';
import { reresolveAll } from './note-service.js';

const CASE_DB_FILE = 'case.sqlite';

/**
 * 把每一條引文的位置對到**現在的正文**上。
 *
 * `domain/export/verify.ts` 的檔頭寫著「重算之後要把位置對回去是 rebuild 的事」，
 * 而 v0.24.0 之前 rebuild 沒有做 —— 匯出每一次都自己重找一遍，資料庫裡的位置一直是舊的，
 * 關聯面板上那一行「字元 a–b」也是。v0.24.0 的 PDF 重排讓每一份 PDF 的位置都會變，
 * 所以這一步不能再省。
 *
 * - 對得上（含只差空白、就在原位）→ 不動
 * - 引文還在、位置變了 → **只改位置**，引文本身不動（它是寫進去那一刻的事實）
 * - 找不到 → 原樣留著、數出來。**不刪** —— 一條找不到出處的引文要讓人看見，
 *   匯出時它會被標成回溯不到（`EXPORT_EVIDENCE_MISSING`）
 */
async function reanchorEvidence(
  db: DatabaseSync,
  folder: string,
): Promise<RebuildReport['evidence']> {
  const texts = new Map<string, string | null>();
  const textOf = async (itemId: string): Promise<string | null> => {
    if (!texts.has(itemId)) texts.set(itemId, (await readDerived(folder, itemId))?.text ?? null);
    return texts.get(itemId) ?? null;
  };
  let exact = 0;
  let shifted = 0;
  let unresolved = 0;
  const rows = edges.allEvidence(db);
  for (const row of rows) {
    const check = checkQuote(await textOf(row.itemId), row.quote, row.charStart, row.charEnd);
    if (check.status === 'verified') exact++;
    else if (check.status === 'missing') unresolved++;
    else {
      edges.setEvidenceSpan(db, row.id, check.start, check.end);
      shifted++;
    }
  }
  return { checked: rows.length, exact, shifted, unresolved };
}
const HEX64 = /^[0-9a-f]{64}$/;

export interface RebuildReport {
  /** 有快照、可以重抽的資料有幾份。 */
  readonly items: number;
  readonly reextracted: number;
  /** 這一次抽不出正文的。**原來的那一份已經沒了**，所以要說出來。 */
  readonly failed: number;
  /** 快照不見了或壞了 —— 那是 `sources/` 的問題，不是抽取的問題。 */
  readonly snapshotMissing: number;
  readonly notes: {
    readonly checked: number;
    readonly exact: number;
    readonly shifted: number;
    readonly unresolved: number;
  };
  /**
   * 關聯的引文。**同一件事的另一半**：點註錨在快照上、重算後重解；
   * 引文記的是「在正文的第幾個字」，正文一變就要對回去（v0.24.0 補上 ——
   * 在那之前只有匯出會重驗，資料庫裡的位置一直是舊的）。
   */
  readonly evidence: {
    readonly checked: number;
    readonly exact: number;
    readonly shifted: number;
    readonly unresolved: number;
  };
}

/**
 * 整批重算。
 *
 * **先清空再逐份重寫**：`derived/` 的檔名帶抽取器版本，
 * 但清空是為了另一件事 —— 一份這次抽不出來的資料，
 * 舊的那個檔留著的話會**看起來像重算成功了**。
 */
export async function rebuildDerived(
  dataRoot: string,
  slug: string,
): Promise<Result<RebuildReport>> {
  const cid = correlationId();
  const folder = join(casesDir(dataRoot), slug);
  const opened = await openCaseDatabase(join(folder, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new')
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  if (opened.kind === 'migrate-failed')
    return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { at: opened.at });
  if (opened.kind === 'missing') return err('CASE_NOT_FOUND', cid, { slug });

  const db: DatabaseSync = opened.db;
  try {
    if (readCase(db) === null) return err('CASE_NOT_FOUND', cid, { slug });

    const rows = db
      .prepare(
        `SELECT id FROM item
         WHERE sha256 IS NOT NULL AND source_ext IS NOT NULL AND kind != 'note'
         ORDER BY created_at`,
      )
      .all() as { id?: unknown }[];
    const ids = rows.map((r) => String(r['id']));

    await clearDerived(folder);

    let reextracted = 0;
    let failed = 0;
    let snapshotMissing = 0;

    for (const id of ids) {
      const item = items.getItem(db, id);
      if (item?.sha256 == null || item.sourceExt === null || !HEX64.test(item.sha256)) {
        snapshotMissing++;
        continue;
      }

      let bytes: Uint8Array;
      try {
        bytes = await readSnapshot(folder, item.sha256, item.sourceExt);
      } catch {
        snapshotMissing++;
        continue;
      }

      // 點註與書目節點沒有快照可以重抽（上面的查詢已經濾掉，這一行讓型別也說得出來）。
      const kind = item.kind;
      if (kind === 'note' || kind === 'reference') continue;
      const outcome = await extract(bytes, kind, item.mime, item.sourceUrl ?? item.title);
      if (outcome.kind === 'failed') {
        failed++;
        continue;
      }

      const payload: DerivedPayload = outcome.payload;
      await writeDerived(folder, id, payload);

      const lang = detectLanguage(payload.text);
      // **不是 `markParsed`。** 那一支會把 `status` 設回 `included`，
      // 而使用者排除掉的那幾份必須維持排除。
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
        now: Date.now(),
      });
      indexText(db, {
        ownerKind: 'item',
        ownerId: id,
        lang,
        title: payload.title,
        text: payload.text,
      });
      /**
       * **向量作廢，但不在這裡重算。**
       *
       * 重抽之後正文變了，舊的向量指的是一段可能已經不存在的文字 ——
       * 留著的話語意檢索會命中它，而點過去正文裡沒有。
       *
       * 不在這裡重算的理由有兩個，而第二個才是真正的那個：
       * 重算是純本機的（讀 `sources/`、跑抽取），**而嵌入要一個設定好的 provider**；
       * 把它接進來的話，「整批重算」這顆按鈕會在沒設嵌入模型時多一種失敗方式。
       * 而作廢之後那幾份就出現在「還沒有向量」的計數裡，
       * **回填是既有的一條路**，不必再發明一條。
       */
      dropVectorsFor(db, 'item', id);
      reextracted++;
    }

    // **重算完立刻重解錨點。** 分成兩顆按鈕的話，中間那段時間裡
    // `anchor_ok` 說的是上一次的事 —— 而那一欄的用途正是「現在對不對得上」。
    const notes = await reresolveAll(db, folder);
    const evidence = await reanchorEvidence(db, folder);

    return ok({ items: ids.length, reextracted, failed, snapshotMissing, notes, evidence }, cid);
  } finally {
    db.close();
  }
}
