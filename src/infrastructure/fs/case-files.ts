/**
 * 一個專題資料夾底下的檔案：`sources/`、`derived/`、`notes/`、`manifest.jsonl`。
 * 版面的權威是 `docs/architecture/storage-layout.md`。
 *
 * 兩件事這一層要負責到底：
 *
 * 1. **`sources/` 不可變。** 寫入用 `wx`（已存在就不動它），
 *    而不是「先檢查再寫」—— 那中間有一個時間差，而檔案系統不會等我們。
 * 2. **`derived/` 可以整批刪掉重算。** 所以它的檔名帶抽取器版本，
 *    重算的時候不必先猜哪些檔案是舊的。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 抽取器版本。**改了抽取邏輯就要 +1** ——
 * `derived/` 的檔名帶著它，所以舊的產物不會被誤認成新的。
 */
export const EXTRACTOR_VERSION = 1;

export function sourcesDir(caseFolder: string): string {
  return join(caseFolder, 'sources');
}
export function derivedDir(caseFolder: string): string {
  return join(caseFolder, 'derived');
}
export function notesDir(caseFolder: string): string {
  return join(caseFolder, 'notes');
}
export function manifestPath(caseFolder: string): string {
  return join(caseFolder, 'manifest.jsonl');
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `sources/<sha256>.<ext>` —— 依內容命名，所以同樣的內容永遠是同一個檔。 */
export function snapshotPath(caseFolder: string, sha256: string, ext: string): string {
  return join(sourcesDir(caseFolder), `${sha256}.${ext}`);
}

export interface SnapshotWritten {
  readonly sha256: string;
  readonly path: string;
  readonly byteSize: number;
  /** 這份內容已經在專題裡了。**不是失敗** —— 同一份東西不重複存。 */
  readonly alreadyExisted: boolean;
}

export async function writeSnapshot(
  caseFolder: string,
  bytes: Uint8Array,
  ext: string,
): Promise<SnapshotWritten> {
  const sha256 = sha256Of(bytes);
  const path = snapshotPath(caseFolder, sha256, ext);
  await mkdir(sourcesDir(caseFolder), { recursive: true });

  try {
    // `wx` = 只在檔案不存在時建立。**這就是「不可變」的實作點。**
    await writeFile(path, bytes, { flag: 'wx' });
    return { sha256, path, byteSize: bytes.byteLength, alreadyExisted: false };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return { sha256, path, byteSize: bytes.byteLength, alreadyExisted: true };
    }
    throw e;
  }
}

export async function readSnapshot(
  caseFolder: string,
  sha256: string,
  ext: string,
): Promise<Buffer> {
  return readFile(snapshotPath(caseFolder, sha256, ext));
}

// ── manifest.jsonl ────────────────────────────────────────

/**
 * 每次擷取寫一列（REQ-0003 的驗收條件）。
 *
 * **每行一個 JSON**，所以它在任何工具裡都讀得懂 —— 包括
 * 「把資料夾整個複製到一台沒有裝 Cyclosa 的機器」的那個標準。
 */
export interface ManifestEntry {
  readonly at: string;
  readonly url: string | null;
  readonly itemId: string;
  readonly status: 'ok' | 'failed';
  readonly code: string | null;
  readonly sha256: string | null;
  readonly byteSize: number | null;
  readonly contentType: string | null;
  /** 轉址經過哪些主機。**空陣列代表沒有轉址。** */
  readonly hops: readonly string[];
}

export async function appendManifest(caseFolder: string, entry: ManifestEntry): Promise<void> {
  await appendFile(manifestPath(caseFolder), `${JSON.stringify(entry)}\n`, 'utf8');
}

// ── derived/ ──────────────────────────────────────────────

/**
 * 抽取結果。**這是衍生物** —— 整批刪掉重算之後點註不受影響，
 * 因為點註錨在 `sources/`（ADR-0010）。
 */
export interface DerivedPayload {
  readonly extractorVersion: number;
  readonly kind: 'web' | 'pdf' | 'image' | 'text';
  readonly title: string;
  /** 純文字正文。**引文的字元位移以它為準。** PDF 的話是各頁串起來的版本。 */
  readonly text: string;
  /** 重構後的排版（HTML 片段）。PDF 與圖片沒有。 */
  readonly html: string | null;
  /** **PDF 專用**：每一頁的文字。頁碼是 1-based，`pages[0]` 是第 1 頁。 */
  readonly pages: readonly string[] | null;
  readonly excerpt: string;
  readonly lowConfidence: boolean;
  readonly reasons: readonly string[];
}

export function derivedPath(
  caseFolder: string,
  itemId: string,
  version = EXTRACTOR_VERSION,
): string {
  return join(derivedDir(caseFolder), `${itemId}.v${version}.json`);
}

export async function writeDerived(
  caseFolder: string,
  itemId: string,
  payload: DerivedPayload,
): Promise<string> {
  await mkdir(derivedDir(caseFolder), { recursive: true });
  const path = derivedPath(caseFolder, itemId, payload.extractorVersion);
  // 衍生物**可以覆寫** —— 這正是它與 `sources/` 的差別。
  await writeFile(path, JSON.stringify(payload), 'utf8');
  return path;
}

export async function readDerived(
  caseFolder: string,
  itemId: string,
): Promise<DerivedPayload | null> {
  try {
    const raw = await readFile(derivedPath(caseFolder, itemId), 'utf8');
    return JSON.parse(raw) as DerivedPayload;
  } catch {
    return null;
  }
}

/** 整批重算前把舊的清掉。**只動 `derived/`，永遠不碰 `sources/`。** */
export async function clearDerived(caseFolder: string): Promise<void> {
  await rm(derivedDir(caseFolder), { recursive: true, force: true });
  await mkdir(derivedDir(caseFolder), { recursive: true });
}
