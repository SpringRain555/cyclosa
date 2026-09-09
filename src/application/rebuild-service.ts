/**
 * `derived/` 整批重算（Stage 10）。
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
 * 而它同時是 Stage 10 的驗收條件：
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
  readSnapshot,
  writeDerived,
  type DerivedPayload,
} from '../infrastructure/fs/case-files.js';
import { dropVectorsFor } from '../infrastructure/db/repositories/vector-repo.js';
import { indexText } from '../infrastructure/index/writer.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';
import { extract } from './ingest-service.js';
import { reresolveAll } from './note-service.js';

const CASE_DB_FILE = 'case.sqlite';
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

      const kind = item.kind === 'paper' ? 'pdf' : item.kind;
      if (kind === 'note') continue;
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

    return ok({ items: ids.length, reextracted, failed, snapshotMissing, notes }, cid);
  } finally {
    db.close();
  }
}
