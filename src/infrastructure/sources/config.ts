/**
 * 來源網站的使用者設定與探測快取：`%LOCALAPPDATA%\Cyclosa\sources.json`。
 *
 * ## 為什麼跟 `providers.json` 放在一起，而不是放在資料根裡
 *
 * 資料根的規矩是「整個複製走，在另一台機器上打得開」（REQ-0001），
 * 而**「哪些來源對我有用」是這個人的偏好，不是這批資料的一部分** ——
 * 同一批資料換一個人看，該問的網站可能完全不同。
 *
 * 探測快取跟著設定放，理由更直接：**它是這台機器從這個網路連出去的結果。**
 * 換一個網路（家裡／學校／VPN）答案就不一樣，跟著資料搬過去每一條都是錯的。
 *
 * ## 內建清單不在這裡
 *
 * 這一份**只存差異**：使用者自己加的、關掉的、改過探針的。
 * 內建那份跟著程式走（`catalog.ts`），所以升級工具會更新它，
 * **而不會蓋掉你改過的那幾條**。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { SiteAccess } from '../../domain/sources/status.js';
import { pointerFilePath } from '../fs/paths.js';
import {
  SOURCE_CATEGORIES,
  SOURCE_KINDS,
  normaliseFields,
  normaliseHost,
  type SourceCategory,
  type SourceKind,
} from './catalog.js';

/** 使用者自己加的一列，或對內建那一列的覆寫。 */
export interface UserSource {
  readonly host: string;
  readonly nameZh: string;
  readonly kind: SourceKind;
  readonly category: SourceCategory;
  /** 領域標籤（`catalog.ts` 檔頭）。**舊的設定檔沒有這一欄** —— 缺就是空的，不是壞掉。 */
  readonly fields: readonly string[];
  readonly probe: string | null;
  readonly noteZh: string;
  /** 關掉的不會進 agent 的建議清單。**仍然看得到，也仍然可以檢查。** */
  readonly enabled: boolean;
}

/** 一次探測留下的東西。**帶時間，因為它是某個時刻的事實。** */
export interface ProbeRecord {
  readonly access: SiteAccess;
  readonly code: string | null;
  readonly at: number;
  readonly url: string;
}

export interface SourcesConfig {
  readonly version: 1;
  /** 覆寫或新增，鍵是正規化過的網域。 */
  readonly sources: Readonly<Record<string, UserSource>>;
  /** 探測快取，鍵是正規化過的網域。 */
  readonly probes: Readonly<Record<string, ProbeRecord>>;
}

export const EMPTY_SOURCES: SourcesConfig = { version: 1, sources: {}, probes: {} };

export function sourcesFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(pointerFilePath(env)), 'sources.json');
}

// **型別與類型的清單只有 `catalog.ts` 那一份。** 這裡 2026-09-16 之前自己抄了一份，
// 加一個類型要改兩處 —— 漏掉的症狀是使用者存的分類被安靜地退回「參考」。
const KINDS: readonly SourceKind[] = SOURCE_KINDS;
const CATEGORIES: readonly SourceCategory[] = SOURCE_CATEGORIES;
const ACCESSES: readonly SiteAccess[] = [
  'open',
  'login',
  'challenged',
  'throttled',
  'unreachable',
  'disallowed',
  'js-only',
  'unknown',
];

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : fallback;
}

function readSource(host: string, raw: unknown): UserSource | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const kind = str(v['kind']) as SourceKind;
  const category = str(v['category']) as SourceCategory;
  const probe = str(v['probe']);
  return {
    host,
    nameZh: str(v['nameZh'], host),
    kind: KINDS.includes(kind) ? kind : 'site',
    category: CATEGORIES.includes(category) ? category : 'reference',
    fields: normaliseFields(v['fields']),
    probe: probe.length > 0 ? probe : null,
    noteZh: str(v['noteZh']),
    // **沒寫就是開著。** 少一個欄位不該讓一個來源安靜地消失。
    enabled: v['enabled'] !== false,
  };
}

function readProbe(raw: unknown): ProbeRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const access = str(v['access']) as SiteAccess;
  const at = Number(v['at']);
  if (!ACCESSES.includes(access) || !Number.isFinite(at) || at <= 0) return null;
  const code = v['code'];
  return {
    access,
    code: typeof code === 'string' && code.length > 0 ? code : null,
    at,
    url: str(v['url']),
  };
}

/**
 * 讀設定。**壞掉的檔案退回空的，不報錯。**
 *
 * 跟 `providers.json` 同一個判斷：來源清單壞掉只代表「這個功能暫時是空的」，
 * 讓整個程式打不開是不成比例的。
 */
export async function readSourcesConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SourcesConfig> {
  let raw: string;
  try {
    raw = await readFile(sourcesFilePath(env), 'utf8');
  } catch {
    return EMPTY_SOURCES;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const sources: Record<string, UserSource> = {};
    const probes: Record<string, ProbeRecord> = {};

    const rawSources = parsed['sources'];
    if (typeof rawSources === 'object' && rawSources !== null) {
      for (const [host, value] of Object.entries(rawSources as Record<string, unknown>)) {
        const key = normaliseHost(host);
        if (key.length === 0) continue;
        const entry = readSource(key, value);
        if (entry !== null) sources[key] = entry;
      }
    }

    const rawProbes = parsed['probes'];
    if (typeof rawProbes === 'object' && rawProbes !== null) {
      for (const [host, value] of Object.entries(rawProbes as Record<string, unknown>)) {
        const key = normaliseHost(host);
        if (key.length === 0) continue;
        const entry = readProbe(value);
        if (entry !== null) probes[key] = entry;
      }
    }
    return { version: 1, sources, probes };
  } catch {
    return EMPTY_SOURCES;
  }
}

/** 寫設定。**無 BOM 的 UTF-8**（`.json` 不要 BOM）。 */
export async function writeSourcesConfig(
  config: SourcesConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = sourcesFilePath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
