/**
 * 資料根的啟動流程：找、選、搬。
 *
 * **找**照上游 CONVENTIONS §11 的四步（ADR-0037）：指標檔 → 程式資料夾的 `userdata` →
 * 使用者資料夾的 `data` → 都沒有就回 `IO_POINTER_MISSING`，由畫面問三選一。
 * **這一層的工作是把每一種結果轉成一個錯誤碼**，因為使用者要做的事完全不同
 * （REQ-0001：不要顯示一個空清單）。
 */
import { cp, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type { DataLocationSource, PreparedLocation } from '@local-app/lifecycle/data-location';

import {
  DATA_ROOT_CHOICES,
  DATA_ROOT_MARKER,
  LayoutError,
  detectDataRoot,
  ensureDataRootLayout,
  inspectTargetFolder,
  pointerFilePath,
  prepareDataRoot,
  type DataRootChoice,
  type DataRootSource,
} from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';
import { seedSampleIfEmpty } from './sample-service.js';

export interface DataRootInfo {
  readonly dataRoot: string;
  /** 指標檔**會在**哪裡。`source` 不是 `pointer` 的時候它不存在 —— 那兩種不寫指標檔。 */
  readonly pointerPath: string;
  readonly source: DataRootSource;
}

export type { DataRootChoice };

/** 請求裡的 `choice` 認不認得。route 用它擋掉別的字串。 */
export function isDataRootChoice(value: unknown): value is DataRootChoice {
  return typeof value === 'string' && (DATA_ROOT_CHOICES as readonly string[]).includes(value);
}

/** Cyclosa 不傳覆寫給共用套件，所以 `override` 不會出現；型別上要把它收掉。 */
function sourceOf(source: DataLocationSource): DataRootSource {
  if (source === 'override') throw new Error('Cyclosa 沒有資料根覆寫，不該走到這裡');
  return source;
}

/**
 * 四步裡的「找」。**只看，不建任何東西。**
 *
 * 每一種失敗都帶著**指標檔在哪**（有指標檔的時候），路徑相關的那幾種還帶著**它指到哪**。
 * 這些欄位會一路帶到 UI —— 訊息本身在 `web/src/i18n/zh-TW.ts`，
 * 這裡只提供它需要的變數。**碼不進 UI，訊息不進這裡。**
 *
 * 「都沒有」回 `IO_POINTER_MISSING`，帶著三選一要顯示的兩個固定位置
 * （`programDataRoot` 是 `null` 的時候，程式資料夾那個選項不能用）。
 */
export async function resolveDataRootOrExplain(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<DataRootInfo>> {
  const cid = correlationId();
  const found = await detectDataRoot(env);

  switch (found.kind) {
    case 'found':
      return ok(
        {
          dataRoot: found.dataRoot,
          pointerPath: found.pointerPath,
          source: sourceOf(found.source),
        },
        cid,
      );

    case 'choose':
      return err('IO_POINTER_MISSING', cid, {
        pointerPath: found.pointerPath,
        programDataRoot: found.programDataRoot,
        userDataRoot: found.userDataRoot,
      });

    case 'error': {
      // 「指標檔在哪」只在真的有指標檔的時候說 —— 從固定位置找到的資料根沒有那個檔。
      const where = found.source === 'pointer' ? { pointerPath: found.pointerPath } : {};
      switch (found.code) {
        case 'pointer-malformed':
          return err('IO_POINTER_MALFORMED', cid, {
            pointerPath: found.pointerPath,
            reason: found.reason ?? '',
          });
        case 'data-root-missing':
          return err('IO_DATA_ROOT_MISSING', cid, { ...where, dataRoot: found.dataRoot ?? '' });
        case 'data-root-not-writable':
          return err('IO_DATA_ROOT_NOT_WRITABLE', cid, {
            ...where,
            dataRoot: found.dataRoot ?? '',
          });
      }
    }
  }
}

/**
 * 啟動時與清單頁進來時：找到了就**補齊版面與 marker**。
 *
 * 2026-10-11 之前建的資料根沒有 marker；補上之後，它在指標檔遺失時也認得出來。
 * **補不起來不擋** —— 那個資料根照樣能用，只是那一種情況下認不得它（日誌會說）。
 */
export async function openDataRoot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<DataRootInfo>> {
  const r = await resolveDataRootOrExplain(env);
  if (!r.ok) return r;
  try {
    await ensureDataRootLayout(r.data.dataRoot);
  } catch (e) {
    logger.warn('資料根的版面或 marker 補不起來', {
      correlationId: r.correlationId,
      reason: String((e as Error).message),
    });
  }
  return r;
}

/** 選完之後的結果，外加「這個資料根是不是這一次才建出來的」（決定要不要放範例專題）。 */
interface Prepared {
  readonly info: DataRootInfo;
  readonly fresh: boolean;
}

/** `PreparedLocation` 的失敗 → 錯誤碼。位置本身不能用的那幾種都是 `IO_DATA_ROOT_LOCATION_INVALID`。 */
function explainRejection(
  r: Extract<PreparedLocation, { ok: false }>,
  cid: string,
): Result<Prepared> {
  if (r.code === 'data-root-not-writable') {
    return err('IO_DATA_ROOT_NOT_WRITABLE', cid, { dataRoot: r.dataRoot ?? '' });
  }
  return err('IO_DATA_ROOT_LOCATION_INVALID', cid, {
    reason: r.code,
    ...(r.dataRoot === undefined ? {} : { dataRoot: r.dataRoot }),
  });
}

async function prepare(
  choice: DataRootChoice,
  folder: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<Result<Prepared>> {
  const cid = correlationId();
  let r: PreparedLocation;
  try {
    r = await prepareDataRoot(choice, folder, env);
  } catch (e) {
    if (e instanceof LayoutError) {
      if (e.errno === 'ENOSPC') return err('IO_DISK_FULL', cid, { dataRoot: e.dataRoot });
      return err('IO_DATA_ROOT_NOT_WRITABLE', cid, { dataRoot: e.dataRoot });
    }
    // 版面建好了、指標檔寫不進去。**資料根是好的**，只是下次啟動找不到它。
    logger.error('指標檔寫不進去', { correlationId: cid, reason: String((e as Error).message) });
    return err('IO_UNEXPECTED', cid, { at: 'write-pointer' });
  }
  if (!r.ok) return explainRejection(r, cid);
  return ok(
    {
      info: { dataRoot: r.dataRoot, pointerPath: pointerFilePath(env), source: r.source },
      fresh: !r.hasData,
    },
    cid,
  );
}

/**
 * 第一次啟動的三選一（上游 CONVENTIONS §11，ADR-0037）。
 *
 * - **程式資料夾**、**使用者資料夾**：不寫指標檔 —— 下次從同一個固定位置找到 marker 就用
 * - **其他位置**：那裡已經有 marker 就接上它，沒有就建一份新的。**版面建好才寫指標檔**
 *
 * **範例專題只放進這一次才建出來的資料根**（選之前沒有 marker）。接上既有的不放 ——
 * 「資料根是不是新的」就是那個旗標，不另外記（理由在 `seedSampleIfEmpty`）。
 *
 * `CYCLOSA_SKIP_SAMPLE=1` 只給測試用（`vitest.config.ts` 預設打開，測範例專題的那幾條自己關掉）：
 * e2e 換到自己的資料根之後用不到範例，卻佔掉 e2e 四成的時間 —— CI 的 4 核 runner 上一輪要 25～45 分鐘（2026-10-10 量的）。
 */
export async function chooseDataRoot(
  choice: DataRootChoice,
  folder: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<DataRootInfo>> {
  const r = await prepare(choice, folder, env);
  if (!r.ok) return r;
  if (r.data.fresh && env['CYCLOSA_SKIP_SAMPLE'] !== '1') {
    await seedSampleIfEmpty(r.data.info.dataRoot);
  }
  return ok(r.data.info, r.correlationId);
}

/**
 * 指定一個資料夾當資料根 ——「其他位置」那一種，**不放範例專題**。
 * 搬家的最後一步用它，測試也用它。
 *
 * **順序不能反**（共用套件守著）：先確認建得起來再寫指標檔，
 * 否則會留下一個指向建不起來的地方的指標檔，而下次啟動看到的是
 * `IO_DATA_ROOT_NOT_WRITABLE` 而不是「你上次選的地方不能用」。
 */
export async function initDataRoot(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<DataRootInfo>> {
  const r = await prepare('other', dataRoot, env);
  return r.ok ? ok(r.data.info, r.correlationId) : r;
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
 * 搬過去的地方一律寫指標檔（「其他位置」那一種），不管原本是從哪一步找到的。
 *
 * ## 先擋掉的目標
 *
 * 位置本身不能用的（整顆磁碟、程式資料夾裡面、不是完整路徑）與第一次啟動的「其他位置」同一套
 * （`IO_DATA_ROOT_LOCATION_INVALID`）。另外三種是搬家才有的：`same` 什麼都不用做；
 * `nested` 是**把一個資料夾搬進它自己底下**，而那在檔案系統上會變成一個沒有終點的動作；
 * `not-empty` 會蓋掉別人的東西 —— 那個「別人」很可能是使用者的另一份資料。
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

  const target = await inspectTargetFolder(toRaw.trim(), env);
  if (!target.ok) {
    return err('IO_DATA_ROOT_LOCATION_INVALID', cid, {
      reason: target.code,
      ...(target.dataRoot === undefined ? {} : { dataRoot: target.dataRoot }),
    });
  }
  // 兩邊都正規化過才比得了 —— 共用套件給的 `to` 已經 `resolve` 過。
  const to = target.dataRoot;
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
      //
      // **marker 先刪**：殘骸要是還帶著它，指標檔哪天遺失時，四步的第 2、3 步會把那半份當成資料根接上。
      await rm(join(src, DATA_ROOT_MARKER), { force: true }).catch(() => undefined);
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

  // 搬過去的可能是一個舊版面（少了 `exports\` 或 marker），所以補齊再寫指標檔。
  return initDataRoot(to, env);
}
