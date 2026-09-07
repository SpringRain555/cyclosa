/**
 * 指標檔與資料根。
 *
 * **「運作的地方」與「儲存的地方」是分開的**（ADR-0004）——
 * 這個 repo 公開時只會公開程式，不會公開任何蒐集來的資料。
 *
 * 版面的權威是 `docs/architecture/storage-layout.md`。
 *
 * ⚠️ **這個檔案裡不能出現任何實際的私人路徑。** 預設值一律從環境推導。
 */
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SystemPaths {
  readonly version: 1;
  readonly dataRoot: string;
  readonly updatedAt: string;
}

/** 資料根底下的四個頂層資料夾。 */
export const TOP_LEVEL_DIRS = ['cases', 'backups', 'logs', 'tmp'] as const;

/**
 * `%LOCALAPPDATA%\Cyclosa\system_paths.json`。
 *
 * 非 Windows 上退到 `~/.local/share/cyclosa/` —— 這個工具目前只在 Windows 上用，
 * 但**寫死 `%LOCALAPPDATA%` 會讓測試只能在 Windows 上跑**，而那不值得。
 */
export function pointerFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env['LOCALAPPDATA'] ?? join(env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'));
  return join(base, 'Cyclosa', 'system_paths.json');
}

/**
 * 指標檔的四種失敗。**四種訊息完全不同，因為使用者要做的事完全不同**
 * （REQ-0001 的驗收條件：不要顯示一個空清單）。
 */
export type ResolveOutcome =
  | { readonly kind: 'ok'; readonly dataRoot: string; readonly pointerPath: string }
  | { readonly kind: 'pointer-missing'; readonly pointerPath: string }
  | { readonly kind: 'pointer-malformed'; readonly pointerPath: string; readonly reason: string }
  | { readonly kind: 'data-root-missing'; readonly pointerPath: string; readonly dataRoot: string }
  | {
      readonly kind: 'data-root-not-writable';
      readonly pointerPath: string;
      readonly dataRoot: string;
    };

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writable(p: string): Promise<boolean> {
  try {
    await access(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 讀指標檔，並確認它指到的地方真的能用。
 *
 * **每一種失敗都帶著「指標檔在哪」** —— 那是 ADR-0004 那條「多一層間接」的代價，
 * 而付這個代價的方式就是把訊息寫清楚。
 */
export async function resolveDataRoot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolveOutcome> {
  const pointerPath = pointerFilePath(env);

  let raw: string;
  try {
    raw = await readFile(pointerPath, 'utf8');
  } catch {
    return { kind: 'pointer-missing', pointerPath };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { kind: 'pointer-malformed', pointerPath, reason: String((e as Error).message) };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { dataRoot?: unknown }).dataRoot !== 'string' ||
    (parsed as { dataRoot: string }).dataRoot.length === 0
  ) {
    return { kind: 'pointer-malformed', pointerPath, reason: '缺少 dataRoot 欄位' };
  }

  const dataRoot = (parsed as { dataRoot: string }).dataRoot;

  if (!(await exists(dataRoot))) return { kind: 'data-root-missing', pointerPath, dataRoot };
  if (!(await writable(dataRoot))) return { kind: 'data-root-not-writable', pointerPath, dataRoot };

  return { kind: 'ok', dataRoot, pointerPath };
}

/** 寫指標檔。**只有在使用者明確選了一個資料根之後才呼叫。** */
export async function writePointerFile(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const pointerPath = pointerFilePath(env);
  await mkdir(dirname(pointerPath), { recursive: true });
  const payload: SystemPaths = {
    version: 1,
    dataRoot,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(pointerPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return pointerPath;
}

/** 建資料根底下的四個頂層資料夾。已經存在就什麼都不做。 */
export async function ensureDataRootLayout(dataRoot: string): Promise<void> {
  for (const dir of TOP_LEVEL_DIRS) {
    await mkdir(join(dataRoot, dir), { recursive: true });
  }
}

export function casesDir(dataRoot: string): string {
  return join(dataRoot, 'cases');
}

export function caseDir(dataRoot: string, caseId: string): string {
  return join(dataRoot, 'cases', caseId);
}

/** migration 前的複本放這裡。**不是版本歷史，也不是回收桶**（storage-layout）。 */
export function backupsDir(dataRoot: string): string {
  return join(dataRoot, 'backups');
}

export function logsDir(dataRoot: string): string {
  return join(dataRoot, 'logs');
}
