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

import type { MdBlock } from '../../domain/text/markdown-blocks.js';

/**
 * 抽取器版本。**改了抽取邏輯就要 +1** ——
 * `derived/` 的檔名帶著它，所以舊的產物不會被誤認成新的。
 *
 * | 版 | 改了什麼 |
 * |---|---|
 * | 1 | 第一版 |
 * | 2 | PDF 重排成段落（`extract/pdf-reflow.ts`，v0.24.0）。HTML 與圖片沒變 |
 * | 3 | Markdown 解析成 `{ text, blocks }`（`extract/markdown.ts`，v1.1.0，ADR-0039）。`.txt` 抽出來一字不差 |
 *
 * **升版之後舊產物由 App 升級，不留著讀**（ADR-0039 第五節）：第一次碰到一個專題時
 * （`application/case-upgrade.ts`），改過的種類從快照重抽、沒改過的換成新版號；`readDerived` 只讀現行版。
 */
export const EXTRACTOR_VERSION = 3;

/**
 * 每一版**改了哪幾種資料**的抽取。升級時只重抽真的改過的那幾種 —— 網頁在 v2、v3 都沒變，
 * 重抽它只是白花時間（Readability 的結果萬一跟當年差一個空白，點註就得重解一次）。
 *
 * **升 `EXTRACTOR_VERSION` 就要在這裡加一列**（`tests/guards/extractor-version.test.ts` 守著）。
 */
export const EXTRACTOR_CHANGES: Readonly<Record<number, readonly DerivedPayload['kind'][]>> = {
  2: ['pdf'],
  3: ['text'],
};

/** 用 `fromVersion` 抽的這一種資料，**那一版之後的抽取有沒有改過**（有就要從快照重抽）。 */
export function changedSince(kind: DerivedPayload['kind'], fromVersion: number): boolean {
  for (let version = fromVersion + 1; version <= EXTRACTOR_VERSION; version++) {
    if (EXTRACTOR_CHANGES[version]?.includes(kind) === true) return true;
  }
  return false;
}

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
  /**
   * **Markdown 專用**：結構與位置（ADR-0039），其餘種類是 `null`。必填 —— 升級時沒改過的種類換版號也補上 `null`，
   * 所以讀到的每一份都有這一欄。
   */
  readonly blocks: readonly MdBlock[] | null;
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

/**
 * 讀衍生物。**只讀現行版**（ADR-0039 第五節）：舊版的由升級換掉（`application/case-upgrade.ts`），
 * 不留「找不到新版就退回舊版」的路 —— 那條路讓同一個專題半新半舊，而且每一個讀的人都得記得分辨。
 */
export async function readDerived(
  caseFolder: string,
  itemId: string,
): Promise<DerivedPayload | null> {
  return readDerivedAt(caseFolder, itemId, EXTRACTOR_VERSION);
}

/** 讀某一版的衍生物。**只給升級用**：它要讀舊版的正文，才能把引文與點註換到新正文上。 */
export async function readDerivedAt(
  caseFolder: string,
  itemId: string,
  version: number,
): Promise<DerivedPayload | null> {
  try {
    const raw = await readFile(derivedPath(caseFolder, itemId, version), 'utf8');
    return JSON.parse(raw) as DerivedPayload;
  } catch {
    return null;
  }
}

/**
 * 刪掉一份資料的衍生物，**每一版都刪**。
 *
 * 只刪現在這一版的話，抽取器升版之前留下的舊檔會變成沒有列指向它的孤兒
 * （2026-09-19 升到 v2 的當下，那時的 `readDerived` 還會退回讀舊版，一條「正文檔案不在」的測試就這樣變成了「命中」）。
 */
export async function removeDerived(caseFolder: string, itemId: string): Promise<void> {
  for (let version = EXTRACTOR_VERSION; version >= 1; version--) {
    await rm(derivedPath(caseFolder, itemId, version), { force: true });
  }
}

/** 整批重算前把舊的清掉。**只動 `derived/`，永遠不碰 `sources/`。** */
export async function clearDerived(caseFolder: string): Promise<void> {
  await rm(derivedDir(caseFolder), { recursive: true, force: true });
  await mkdir(derivedDir(caseFolder), { recursive: true });
}
