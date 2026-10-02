/**
 * 復原一次作業（v0.9.0）。
 *
 * ## 「取消」與「復原」是兩件事，而且刻意分開
 *
 * **取消不回滾** —— 40 個網址抓到第 38 個才按取消，前面 37 份不該跟著消失。
 * 那條規則從 v0.2.0 就在，而它保護的是**你已經付出去的時間與請求**。
 *
 * 但「我不想要這一批東西」是一個真實的需求，而它跟取消發生在不同的時刻：
 * 取消是「別再做下去了」，復原是**「剛剛那一整批，當作沒發生」**。
 * 把它們做成同一顆按鈕，就等於逼使用者在按取消的那一刻決定一件他還不知道的事。
 *
 * ## 這一支不碰兩樣東西
 *
 * **`sources\` 一個位元組都不動，人的判定一條都不動。**
 * 跟 `POST …/rebuild` 是同一句話 —— 而那不是巧合：
 * 兩者都是「機器大規模動既有資料」的動作，而這個工具對那種動作只有一條規則。
 *
 * `sources\` 留著還有一個好處：復原之後再匯入同一個網址不必重抓，
 * 那份位元組已經在那裡了。**「不可變」的意思是永不改寫，而不是永不失去指向它的列。**
 *
 * ## 為什麼要回報「留下了什麼」
 *
 * 一個回報「刪了 31 筆」的復原，跟一個回報「刪了 31 筆、留下 4 筆因為你動過」的復原，
 * 對使用者是兩件事。**後者才解釋得了為什麼圖上還有東西。**
 */
import { join } from 'node:path';

import { isOpen } from '../domain/research/index.js';
import { keptAnything, type UndoPlan } from '../domain/run/index.js';
import { applyUndoPlan, planUndoRuns } from '../infrastructure/db/undo-core.js';
import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as research from '../infrastructure/db/repositories/research-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import { removeDerived } from '../infrastructure/fs/case-files.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';
import { isActive } from './run-registry.js';

const CASE_DB_FILE = 'case.sqlite';

export interface UndoReport {
  readonly runId: string;
  readonly deletedItems: number;
  readonly deletedEdges: number;
  /** 刪完之後一條邊都沒有的實體。 */
  readonly deletedEntities: number;
  readonly keptItems: number;
  readonly keptEdges: number;
  /** 其中因為「有一條留下來的邊靠它當出處」而留下的。 */
  readonly keptAsEvidence: number;
  /** 有東西被留下來。**畫面上要說出這件事。** */
  readonly partial: boolean;
}

export async function undoRun(
  dataRoot: string,
  slug: string,
  runId: string,
): Promise<Result<UndoReport>> {
  const cid = correlationId();

  // **還在跑的不能復原。** 一邊寫一邊刪會留下一個誰都說不清楚的狀態，
  // 而使用者要做的事很明確：先取消，或等它跑完。
  if (isActive(runId)) return err('RUN_STILL_ACTIVE', cid, { runId });

  const folder = join(casesDir(dataRoot), slug);
  const opened = await openCaseDatabase(join(folder, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new')
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  if (opened.kind === 'migrate-failed') return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { slug });
  if (opened.kind === 'missing') return err('CASE_NOT_FOUND', cid, { slug });

  const db: DatabaseSync = opened.db;
  let plan: UndoPlan;
  let deletedEntities: number;
  try {
    if (readCase(db) === null) return err('CASE_NOT_FOUND', cid, { slug });
    const run = runs.getRun(db, runId);
    if (run === null) return err('RUN_NOT_FOUND', cid, { runId });
    /**
     * **一次還沒結束的研究，它的作業不能復原**（Stage 20）。
     *
     * 蒐集抓回來的候選就是資料節點（ADR-0033 D8），而候選表記著「這一列抓到了、是哪一份」。
     * 研究還在等你、還沒確認的時候把那幾份刪掉，候選表就會寫著「抓到了」而指著一份不存在的資料 ——
     * 確認那一步（Stage 22）會照著它去抽。研究做完或放棄之後，那幾份就只是資料，照常可以復原。
     */
    if (run.researchId !== null) {
      const owner = research.getResearch(db, run.researchId);
      if (owner !== null && isOpen(owner.status)) {
        return err('RUN_OWNED_BY_RESEARCH', cid, { runId, researchId: owner.id });
      }
    }

    // **一個交易。** 刪到一半斷掉會留下「有邊、沒有出處」的半套狀態，
    // 而那正好是一條看起來可以被確認、卻沒有東西支撐它的邊。
    db.exec('BEGIN IMMEDIATE');
    try {
      plan = planUndoRuns(db, [runId]);
      deletedEntities = applyUndoPlan(db, plan);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      logger.error('復原作業失敗', { correlationId: cid, reason: String((e as Error).message) });
      return err('RUN_UNEXPECTED', cid, { at: 'undo-delete' });
    }
  } finally {
    db.close();
  }

  // **衍生物跟著走。** 它們是可拋的（`derived\` 的定義），
  // 而留著會變成一堆沒有列指向它的孤兒檔。`sources\` 不在這裡，那是刻意的。
  for (const itemId of plan.deleteItems) {
    // **每一版都刪**（`removeDerived`）：只刪現在這一版的話，升版前抽的舊檔會留下來當孤兒。
    await removeDerived(folder, itemId).catch(() => undefined);
  }

  return ok(
    {
      runId,
      deletedItems: plan.deleteItems.length,
      deletedEdges: plan.deleteEdges.length,
      deletedEntities,
      keptItems: plan.keepItems.length,
      keptEdges: plan.keepEdges.length,
      keptAsEvidence: plan.keptAsEvidence.length,
      partial: keptAnything(plan),
    },
    cid,
  );
}
