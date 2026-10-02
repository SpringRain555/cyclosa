/**
 * 孤兒作業的掃除。
 *
 * ## 它在修什麼
 *
 * 執行中的作業有兩份紀錄：`run-registry.ts` 那張**記憶體**表（誰還在跑、
 * 怎麼叫它停），與資料庫裡的 `run.status`。程式結束時記憶體那份就沒了，
 * 而資料庫那一列**留在 `running`**。
 *
 * 正常關閉會先取消（`shutdownSequence`），所以那些列會被寫成 `已取消`。
 * 但有一種情形不會：**程式沒有機會取消就死了** —— 工作管理員、當掉、斷電。
 *
 * 那些列在 2026-09-10 之前會永遠留在 `running`，症狀有兩個，而且都不像 bug：
 *
 * - 作業紀錄那顆徽章永遠寫「執行中」，而且**沒有取消鍵**（按鈕綁的是
 *   記憶體算出來的 `live`，重開之後是 false）。直接打取消端點會回
 *   `GRAPH_TRANSITION_INVALID / not-active` —— 也就是它連取消都取消不掉
 * - `hasRunningRun()` 讓**之後每一次搜尋**都掛一句「有作業還在跑，
 *   這次的結果可能不完整」
 *
 * ## 為什麼是「第一次打開這個專題時」而不是啟動時
 *
 * 啟動時掃要先列出所有專題再逐個開資料庫 —— 而開資料庫會跑 migration。
 * 那會把「開一個舊專題的成本」搬到每一次啟動上，而且**資料根在那個時間點
 * 不一定設定好了**（那正是 ADR-0025 把日誌放在資料根外面的同一個理由）。
 *
 * 所以改成 lazy：這個行程第一次打開某個專題時掃它一次，記在 `swept` 裡。
 *
 * ## 只掃 `執行中`，不掃 `排隊中`
 *
 * **第一版掃了兩種，而那是錯的** —— 既有的一條 e2e 當場變紅，
 * 它守的正是這件事：擴展的 `排隊` 的意思是「**在等你勾**」，
 * 而當時那個狀態撐得過重新啟動（舊角度確認流程只看資料庫裡的 `status`，
 * 不問記憶體裡有沒有這個 run）。當時掃掉它等於把一個使用者還沒回答的問題丟掉。
 *
 * 而且那個錯誤不只在重啟時發作：`排隊` 中的擴展作業本來就不在記憶體的執行表裡，
 * 所以它在**同一個行程裡**就會被自己的掃描殺掉。
 *
 * ## 為什麼呼叫點只有兩個
 *
 * 上面那兩個症狀分別出現在「作業紀錄」與「搜尋」，而它們各自只有一個
 * 開資料庫的地方（`run-service.ts` 與 `search-service.ts`）。
 * **掃描的成本要落在會看到症狀的那條路上**，不是每一次開資料庫都掃一遍。
 */
import type { DatabaseSync } from 'node:sqlite';

import { readCase, updateCaseStatus } from '../infrastructure/db/repositories/case-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import { logger } from '../shared/log.js';
import { isActive } from './run-registry.js';

/** 這個行程已經掃過的專題。**行程活著才有意義** —— 它記的正是「這個行程」。 */
const swept = new Set<string>();

/** 測試用：把「掃過了」忘掉。**正式路徑不呼叫它。** */
export function forgetSwept(): void {
  swept.clear();
}

/**
 * 掃一次這個專題的孤兒作業。回傳掃掉幾列。
 *
 * 同一個行程對同一個專題只掃一次；之後呼叫直接回 0。
 */
export function sweepStaleRuns(db: DatabaseSync, slug: string): number {
  if (swept.has(slug)) return 0;
  swept.add(slug);

  const running = runs.listRunningRunIds(db);
  // **本行程正在跑的不算孤兒。** 第一次打開這個專題的時候，
  // 使用者可能已經在同一個行程裡按過匯入了。
  const orphans = running.filter((id) => !isActive(id));

  const now = Date.now();
  for (const id of orphans) {
    runs.markRunEnded(db, { id, reason: 'stale', now });
    runs.cancelPendingItems(db, id, now);
  }
  if (orphans.length > 0) {
    logger.info('掃掉上一次沒有收尾的作業', { slug, count: orphans.length });
  }

  // **這一步在 `orphans.length === 0` 的時候也要跑** —— 見下面的註解。
  repairStuckCollecting(
    db,
    slug,
    running.some((id) => isActive(id)),
    now,
  );
  return orphans.length;
}

/**
 * 把卡在「蒐集中」的專題放回「就緒」。
 *
 * ## 這是一個第二個症狀，而它躲過了 v0.14.0
 *
 * 專題狀態在作業開始時被寫成 `collecting`，在作業結束時寫回 `ready`
 * （`ingest-service.ts`／`expand-service.ts`）。**兩邊都在行程裡** ——
 * 行程沒機會跑完第二步就死掉的話，那一列永遠留在 `collecting`。
 *
 * v0.14.0 修掉的是 `run.status`，而**專題狀態是另一個欄位、另一條路**：
 * 正常關閉會把作業寫成 `已取消`（所以孤兒掃描找不到東西可掃、直接早退），
 * 而專題仍然停在 `collecting`。也就是說**那條修好的路反而繞過了這個修復**。
 *
 * ## 為什麼它到 v0.17.0 才被看見
 *
 * 因為在這之前**沒有任何按鈕會讀這個欄位** —— 封存的 API 從 v0.1.0
 * 就在，而它零個呼叫點。`collecting` 不能封存，
 * 於是一個卡住的專題就是一個**永遠封存不了也說不出為什麼**的專題。
 *
 * 「沒有人呼叫過的程式碼裡沒有事實」，這是第二次。
 */
function repairStuckCollecting(
  db: DatabaseSync,
  slug: string,
  stillLive: boolean,
  now: number,
): void {
  // 這個行程真的還有作業在跑 —— 那 `collecting` 是對的，不要動它。
  if (stillLive) return;
  const row = readCase(db);
  if (row === null || row.status !== 'collecting') return;
  updateCaseStatus(db, 'ready', now);
  logger.info('把卡在蒐集中的專題放回就緒', { slug });
}
