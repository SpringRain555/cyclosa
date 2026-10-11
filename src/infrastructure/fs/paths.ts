/**
 * 指標檔與資料根。
 *
 * **「運作的地方」與「儲存的地方」是分開的**（ADR-0004）——
 * 這個 repo 公開時只會公開程式，不會公開任何蒐集來的資料。
 *
 * **資料根照上游 CONVENTIONS §11 的四步找**（ADR-0037）：指標檔 → 程式資料夾的 `userdata` →
 * 使用者資料夾的 `data` → 都沒有就由畫面問。機制在共用套件 `@local-app/lifecycle` 的
 * `data-location`；這裡只放 Cyclosa 的政策：marker 是哪個檔、版面長什麼樣、程式資料夾在哪。
 *
 * 版面的權威是 `docs/architecture/storage-layout.md`。
 *
 * ⚠️ **這個檔案裡不能出現任何實際的私人路徑。** 預設值一律從環境推導。
 */
import { readFileSync, type Dirent } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as location from '@local-app/lifecycle/data-location';

/** `%LOCALAPPDATA%` 底下屬於 Cyclosa 的資料夾：指標檔、設定檔與「使用者資料夾」那個選項都在裡面。 */
export const APP_DIR = 'Cyclosa';

/**
 * 資料根的 marker：**頂層的 `data-root.json`**。
 *
 * Cyclosa 沒有天然的 marker —— 資料庫一個專題一個（`cases\<專題>\case.sqlite`），
 * 而專題可以被刪光。一個「專題刪光了就認不得」的資料根，在指標檔遺失時會被當成沒有資料。
 * 所以另外放一個檔，**建版面的那一刻就寫**，正常使用不會刪掉它（上游 CONVENTIONS §11）。
 */
export const DATA_ROOT_MARKER = 'data-root.json';
const MARKERS = [DATA_ROOT_MARKER] as const;

/**
 * 資料根底下的頂層資料夾。
 *
 * `exports` 是 v0.8.0 加的，而它**刻意在專題資料夾外面**：
 * 一個專題資料夾的規矩是「整個複製走，在另一台機器上打得開」（REQ-0001），
 * 而證據包是**要拿出去的東西** —— 放進那個資料夾只會讓要複製的東西
 * 隨著每次匯出變大，而且下一次匯出還會把上一次的一起帶走。
 */
export const TOP_LEVEL_DIRS = ['cases', 'backups', 'logs', 'tmp', 'exports'] as const;

/**
 * 資料根是從四步裡的哪一步找到的。**只有 `pointer` 真的有指標檔** ——
 * 另外兩種每次啟動從固定位置找 marker。Cyclosa 沒有開發用的資料根覆寫
 * （測試換的是 `LOCALAPPDATA` 與 `CYCLOSA_PROGRAM_DIR`），所以沒有第 0 步。
 */
export type DataRootSource = 'pointer' | 'program-folder' | 'user-folder';

/** 第一次啟動的三選一。 */
export type DataRootChoice = location.DataLocationChoice;

export const DATA_ROOT_CHOICES: readonly DataRootChoice[] = [
  'program-folder',
  'user-folder',
  'other',
];

/**
 * `%LOCALAPPDATA%\Cyclosa\system_paths.json`。
 *
 * 非 Windows 上退到 `~/.local/share/Cyclosa/` —— 這個工具目前只在 Windows 上用，
 * 但**寫死 `%LOCALAPPDATA%` 會讓測試只能在 Windows 上跑**，而那不值得。
 * **每次呼叫才推導**，所以換掉 `LOCALAPPDATA` 的測試行程碰不到真的那一個。
 */
export function pointerFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return location.pointerFilePath({ appDir: APP_DIR, env });
}

/**
 * 「放在這台電腦的使用者資料夾」那個選項：**指標檔的隔壁**（`…\Cyclosa\data`）。
 *
 * 2026-10-11 之前，沒有指標檔時程式**不問就建在這裡**（v0.17.0「開箱即用」）。
 * 那些資料根都有指標檔指著，所以照樣走第 1 步；開過一次之後也補上了 marker（`ensureDataRootLayout`）。
 */
export function userDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return location.userDataRoot({ appDir: APP_DIR, env });
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 程式資料夾：往上找 `name` 是 `cyclosa` 的 `package.json`
 * （`src/infrastructure/fs/` 與 `dist/infrastructure/fs/` 都在它底下三層）。
 * 找不到就是 `null`，「放在程式資料夾裡」那個選項不能用。
 *
 * `CYCLOSA_PROGRAM_DIR` **只給測試用**：`vitest.config.ts` 把它指到沙箱 ——
 * 否則第 2 步會去看真的 repo 底下的 `userdata\`。
 */
export function programRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env['CYCLOSA_PROGRAM_DIR'];
  if (override !== undefined && override.trim() !== '') return resolve(override);
  let dir = HERE;
  for (let i = 0; i < 5; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (pkg.name === 'cyclosa') return dir;
    } catch {
      // 這一層沒有 package.json，或讀不懂 —— 往上一層
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** 「放在程式資料夾裡」那個選項：`<程式資料夾>\userdata`（整個在 `.gitignore`，`Verify.ps1` 守著）。 */
export function programDataRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  return location.programDataRoot(programRoot(env));
}

/**
 * 四步裡的「找」。**只看，不建任何東西** —— 不建資料根、不建版面、不寫指標檔。
 *
 * 指標檔在但讀不懂、指到的不在、寫不進去，**一律停在那裡**，不往下找、不頂替：
 * 它們後面可能有一整份資料（REQ-0001）。錯誤碼的對映在 `bootstrap-service.ts`。
 */
export function detectDataRoot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<location.DetectedLocation> {
  return location.detectDataLocation({
    appDir: APP_DIR,
    env,
    markers: MARKERS,
    programRoot: programRoot(env),
  });
}

/**
 * 「其他位置」與搬家目標共用的擋法：整顆磁碟、程式資料夾裡面（**連 `userdata` 也擋**）、
 * 不是完整路徑。只看。
 */
export function inspectTargetFolder(
  folder: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<location.OtherFolderInspection> {
  return location.inspectOtherFolder({ folder, markers: MARKERS, programRoot: programRoot(env) });
}

/** 建版面失敗。**與寫指標檔失敗分得開**，因為兩者要給使用者的話不同。 */
export class LayoutError extends Error {
  constructor(
    readonly dataRoot: string,
    readonly errno: string | undefined,
  ) {
    super(`資料根的版面建不起來（${errno ?? 'unknown'}）`);
  }
}

/**
 * 三選一的「選」，照契約的順序：建資料夾 → 確認寫得進去 → 建版面與 marker →
 * **最後**才寫指標檔（只有「其他位置」寫）。建版面失敗就不寫，丟 `LayoutError`。
 */
export function prepareDataRoot(
  choice: DataRootChoice,
  folder: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<location.PreparedLocation> {
  return location.prepareLocation({
    appDir: APP_DIR,
    env,
    choice,
    markers: MARKERS,
    programRoot: programRoot(env),
    ...(folder === undefined ? {} : { folder }),
    initialize: async (dataRoot) => {
      try {
        await ensureDataRootLayout(dataRoot);
      } catch (e) {
        throw new LayoutError(dataRoot, (e as NodeJS.ErrnoException).code);
      }
    },
  });
}

/**
 * 建資料根底下的頂層資料夾與 marker。**已經在的什麼都不動**（marker 用 `wx`，不覆寫）。
 *
 * 打開既有的資料根時也會呼叫（`openDataRoot`）：2026-10-11 之前建的資料根沒有 marker，
 * 補上之後它在指標檔遺失時也認得出來。
 */
export async function ensureDataRootLayout(dataRoot: string): Promise<void> {
  for (const dir of TOP_LEVEL_DIRS) {
    await mkdir(join(dataRoot, dir), { recursive: true });
  }
  try {
    await writeFile(
      join(dataRoot, DATA_ROOT_MARKER),
      JSON.stringify({ app: 'cyclosa', version: 1 }, null, 2) + '\n',
      { encoding: 'utf8', flag: 'wx' },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/**
 * 一個資料夾實際佔多少位元組。**讀不到的略過，不讓整個數字失敗** ——
 * 這個數字是拿去給人看「你要刪掉多大的東西」，
 * 少算一個檔比整句話變成錯誤有用。
 */
export async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      total += await folderBytes(p);
    } else if (e.isFile()) {
      try {
        total += (await stat(p)).size;
      } catch {
        /* 讀不到就當 0 */
      }
    }
  }
  return total;
}

export function casesDir(dataRoot: string): string {
  return join(dataRoot, 'cases');
}

export function caseDir(dataRoot: string, caseId: string): string {
  return join(dataRoot, 'cases', caseId);
}

/**
 * migration 前的複本、以及被刪掉的專題資料夾。
 *
 * **不是版本歷史，也不是回收桶** —— 而那句話是關於 **app**：
 * 這裡沒有清單、沒有還原鍵，狀態機裡沒有「已刪除」（storage-layout `backups\`）。
 * 留給檔案總管的，不是留給程式的。
 */
export function backupsDir(dataRoot: string): string {
  return join(dataRoot, 'backups');
}

/**
 * 被刪掉的專題搬去哪。**時間戳在名字裡**，所以刪掉同名專題兩次不會互相蓋掉。
 *
 * 用 `-` 不用 `:`（Windows 檔名不收冒號）。
 */
export function deletedCaseDir(dataRoot: string, slug: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return join(backupsDir(dataRoot), `deleted-${slug}-${stamp}`);
}

/** **任何專題都不擁有它**，所以一次性的東西放這裡。 */
export function tmpDir(dataRoot: string): string {
  return join(dataRoot, 'tmp');
}

export function logsDir(dataRoot: string): string {
  return join(dataRoot, 'logs');
}

/**
 * 匯出的證據包：`<資料根>\exports\<專題>\<時間戳>\`。
 *
 * **一次匯出一個資料夾，不覆寫上一次。** 證據包是拿去給別人看的東西，
 * 而「我上禮拜寄出去的那一份」必須還在原地 ——
 * 覆寫掉的話，收到那份檔案的人手上拿的東西就再也對不回來了。
 */
export function exportsDir(dataRoot: string, slug?: string): string {
  return slug === undefined ? join(dataRoot, 'exports') : join(dataRoot, 'exports', slug);
}
