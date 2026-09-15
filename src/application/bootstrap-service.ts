/**
 * 指標檔與資料根的啟動流程。
 *
 * **這一層的全部工作是把四種失敗轉成四個不同的錯誤碼**，
 * 因為使用者要做的事完全不同（REQ-0001：不要顯示一個空清單）。
 */
import { cp, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import {
  defaultDataRoot,
  ensureDataRootLayout,
  resolveDataRoot,
  writePointerFile,
  type ResolveOutcome,
} from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';
import { seedSampleIfEmpty } from './sample-service.js';

export interface DataRootInfo {
  readonly dataRoot: string;
  readonly pointerPath: string;
}

/**
 * 每一種失敗都帶著**指標檔在哪**，而路徑相關的那幾種還帶著**它指到哪**。
 *
 * 這些欄位會一路帶到 UI —— 訊息本身在 `web/src/i18n/zh-TW.ts`，
 * 這裡只提供它需要的變數。**碼不進 UI，訊息不進這裡。**
 */
export async function resolveDataRootOrExplain(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<DataRootInfo>> {
  const cid = correlationId();
  const outcome: ResolveOutcome = await resolveDataRoot(env);

  switch (outcome.kind) {
    case 'ok':
      return ok({ dataRoot: outcome.dataRoot, pointerPath: outcome.pointerPath }, cid);

    case 'pointer-missing':
      return err('IO_POINTER_MISSING', cid, { pointerPath: outcome.pointerPath });

    case 'pointer-malformed':
      return err('IO_POINTER_MALFORMED', cid, {
        pointerPath: outcome.pointerPath,
        reason: outcome.reason,
      });

    case 'data-root-missing':
      return err('IO_DATA_ROOT_MISSING', cid, {
        pointerPath: outcome.pointerPath,
        dataRoot: outcome.dataRoot,
      });

    case 'data-root-not-writable':
      return err('IO_DATA_ROOT_NOT_WRITABLE', cid, {
        pointerPath: outcome.pointerPath,
        dataRoot: outcome.dataRoot,
      });
  }
}

/**
 * 開箱即用：**第一次啟動不問任何問題。**
 *
 * ## 只有「指標檔不存在」走自動建立
 *
 * 這是這個函式唯一需要小心的地方，而它值得一段字。
 * 另外三種失敗**一律照原樣往上回**：
 *
 * - `pointer-malformed` —— 指標檔在，但讀不懂。它指到的地方可能有一整份資料
 * - `data-root-missing` —— 指標檔指到 `E:\...`，而那顆隨身碟沒插
 * - `data-root-not-writable` —— 指到的地方在，但寫不進去
 *
 * **這三種如果也自動建一個空的預設資料根，使用者會看到一個空的專題清單** ——
 * 而他上一次關掉程式的時候那裡有 20 個專題。那正是 REQ-0001
 * 花了四個錯誤碼在擋的那件事，不能被一個「貼心的預設值」從後門放進來。
 *
 * 「指標檔不存在」則是唯一一種**可以確定沒有任何舊資料**的狀態。
 */
export async function resolveOrCreateDataRoot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<DataRootInfo>> {
  const first = await resolveDataRootOrExplain(env);
  if (first.ok || first.code !== 'IO_POINTER_MISSING') return first;

  const made = await initDataRoot(defaultDataRoot(env), env);
  // **只有這一條路會放範例專案** —— 資料根是這一次才建出來的，
  // 所以「使用者刪過了」不需要另外記一個旗標。理由在 `seedSampleIfEmpty`。
  if (made.ok) await seedSampleIfEmpty(made.data.dataRoot);
  return made;
}

/**
 * 使用者選了一個資料根之後：建四個頂層資料夾，寫指標檔。
 *
 * **順序不能反** —— 先確認建得起來再寫指標檔，
 * 否則會留下一個指向建不起來的地方的指標檔，而下次啟動看到的是
 * `IO_DATA_ROOT_NOT_WRITABLE` 而不是「你上次選的地方不能用」。
 */
export async function initDataRoot(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<DataRootInfo>> {
  const cid = correlationId();
  try {
    await ensureDataRootLayout(dataRoot);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC') return err('IO_DISK_FULL', cid, { dataRoot });
    return err('IO_DATA_ROOT_NOT_WRITABLE', cid, { dataRoot });
  }

  try {
    const pointerPath = await writePointerFile(dataRoot, env);
    return ok({ dataRoot, pointerPath }, cid);
  } catch {
    return err('IO_UNEXPECTED', cid, { at: 'write-pointer' });
  }
}

/** Windows 的路徑比對不分大小寫，而這個工具就是在 Windows 上跑的。 */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `to` 是不是在 `from` 底下。**用分隔符結尾比對**，否則 `…\data2` 會被當成 `…\data` 的子孫。 */
function isInside(child: string, parent: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return samePath(child.slice(0, p.length), p);
}

async function isEmptyOrAbsent(p: string): Promise<boolean> {
  try {
    return (await readdir(p)).length === 0;
  } catch (e) {
    // 不存在就是可以用；其他錯（沒權限）留給搬那一步去報。
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * 換一個資料根，**而且既有的東西跟著過去**。
 *
 * ## 為什麼不是「只改指標檔」
 *
 * 只重指的話，使用者按下確定之後會看到一個空的專題清單 ——
 * 而他的 20 個專題還在舊資料夾裡。那正是 REQ-0001 要擋的畫面，
 * 只是這一次是我們自己造出來的。
 *
 * ## 順序：搬完才寫指標檔
 *
 * 與 `initDataRoot` 同一條理由。搬失敗的時候指標檔還指著舊的地方，
 * 而舊的地方**原封不動** —— 使用者按重新整理就回到搬之前的狀態。
 *
 * ## 三個先擋掉的目標
 *
 * `same` 什麼都不用做；`nested` 是**把一個資料夾搬進它自己底下**，
 * 而那在檔案系統上會變成一個沒有終點的動作；`not-empty` 會蓋掉別人的東西 ——
 * 那個「別人」很可能是使用者的另一份資料。
 */
export async function moveDataRoot(
  from: string,
  toRaw: string,
  activeRuns: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<DataRootInfo>> {
  const cid = correlationId();

  // **有作業在跑就不搬。** 搬家會把 `case.sqlite` 從一個正在寫它的行程底下抽走。
  if (activeRuns > 0) return err('IO_DATA_ROOT_BUSY', cid, { activeRuns });

  const to = resolve(toRaw.trim());
  const src = resolve(from);

  if (samePath(to, src)) return err('IO_DATA_ROOT_TARGET_INVALID', cid, { reason: 'same' });
  if (isInside(to, src)) return err('IO_DATA_ROOT_TARGET_INVALID', cid, { reason: 'nested' });
  if (!(await isEmptyOrAbsent(to))) {
    return err('IO_DATA_ROOT_TARGET_INVALID', cid, { reason: 'not-empty' });
  }

  try {
    await mkdir(dirname(to), { recursive: true });
    // **`rename` 不能覆蓋一個已經存在的資料夾，就算它是空的。**
    // 上面驗過它是空的，所以先把那個空殼移掉 —— 用 `rmdir` 而不是 `rm -r`：
    // 它**在目標不是空的時候會失敗**，那是上面那個檢查與這一步之間
    // 那段空隙的第二道保險（那段空隙裡使用者可能剛把檔案放進去）。
    await rmdir(to).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    await rename(src, to);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // **跨磁碟區搬不能用 `rename`** —— 這是唯一一種要退回「複製再刪」的情形。
    // 複製與刪舊**分開接失敗**，因為兩者失敗時該清的是不同的那一邊。
    if (code === 'EXDEV') {
      try {
        await cp(src, to, { recursive: true });
      } catch (e2) {
        // 複製到一半：舊的原封不動，清掉新位置那半份（上面驗過 `to` 是空的或不存在，
        // 所以裡面只有這一次放進去的東西）。
        await rm(to, { recursive: true, force: true }).catch(() => undefined);
        const c2 = (e2 as NodeJS.ErrnoException).code;
        logger.error('跨磁碟區搬資料根失敗', {
          correlationId: cid,
          reason: String((e2 as Error).message),
        });
        if (c2 === 'ENOSPC') return err('IO_DISK_FULL', cid, { dataRoot: to });
        return err('IO_DATA_ROOT_MOVE_BLOCKED', cid, { from: src, to });
      }
      // 複製完成之後，**新位置是唯一確定完整的一份**。刪舊的途中失敗（某個檔被別的程式開著）
      // 時舊的已經少了一部分 —— 這時候回頭刪新的，就是兩邊都不完整（2026-09-13 之前就是這樣寫的）。
      // 所以照常改指標檔，殘骸留在舊位置：失敗方向是「多一份垃圾」，不是「少一份資料」。
      await rm(src, { recursive: true, force: true }).catch((e3: unknown) => {
        logger.warn('資料根已搬到新位置，但舊位置沒刪乾淨', {
          correlationId: cid,
          reason: String((e3 as Error).message),
        });
      });
    } else {
      logger.warn('資料根搬不動', { correlationId: cid, reason: String((e as Error).message) });
      return err('IO_DATA_ROOT_MOVE_BLOCKED', cid, { from: src, to });
    }
  }

  // 搬過去的可能是一個舊版面（少了 `exports\`），所以補齊再寫指標檔。
  return initDataRoot(to, env);
}
