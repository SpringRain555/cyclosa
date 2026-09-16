/**
 * 來源網站清單：檢視、編輯、以及「先驗證再查」。
 *
 * ## 這個功能存在的理由是一個量到的數字
 *
 * 2026-09-08 第一次真的跑一次擴展：agent 找到 6 個學術來源，**5 個是付費牆**。
 * 成功率 17%，而每一次無效的嘗試都花了時間與錢。
 *
 * ## 判斷的主要依據是你自己的紀錄，不是探測
 *
 * 直覺的做法是「先探測一下這個站」。**那個做法對出版社幾乎沒有用** ——
 * 首頁一律回 200，文章回 403。
 *
 * 而真正的答案我們早就有了：**每一次擷取都寫進 `run_item`**
 * （網域、結果、錯誤碼）。「這個網域你抓過 12 次，9 次要登入」
 * 比任何探測都準，**而且不花任何一個請求**。
 *
 * 探測只補「你還沒抓過」的那些，而且探的是一篇代表性的東西 ——
 * 給不出那樣一個網址的來源就沒有探針（`catalog.ts`）。
 *
 * ## 這一頁不擋任何東西
 *
 * 清單影響的是**排序與給 agent 的建議**（`sourceHints`，`chooseAngles` 每次作業讀一次
 * 放進提示詞），不影響任何一條 URL 能不能被送進管線。
 * 一篇讀不到的重要論文仍然值得出現在待取得的清單上 ——
 * **擋掉它等於假裝那篇論文不存在。**
 *
 * > 「給 agent 的建議」這句話從 v0.7.0 就寫在這裡，而 `preferredHosts()` 在 v0.20.0 之前
 * > **零個呼叫點** —— 清單算出來的偏好只給設定頁看。跟 v0.17.4 的 `sampleExists()` 同一種洞。
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  EMPTY_SOURCE_HINTS,
  MAX_SOURCE_HINTS_PER_GROUP,
  type SourceHints,
} from '../domain/provider/index.js';
import {
  accessFromCode,
  preferenceOf,
  verdictOf,
  type SiteAccess,
  type SiteHistory,
  type SiteVerdict,
} from '../domain/sources/status.js';
import { openCaseDatabase } from '../infrastructure/db/database.js';
import { Crawler } from '../infrastructure/fetch/crawler.js';
import { configuredIntervalMs } from './fetch-policy.js';
import {
  CATALOG,
  SOURCE_CATEGORIES,
  SOURCE_KINDS,
  normaliseFields,
  normaliseHost,
  type CatalogEntry,
  type SourceCategory,
  type SourceKind,
} from '../infrastructure/sources/catalog.js';
import {
  readSourcesConfig,
  writeSourcesConfig,
  type ProbeRecord,
  type SourcesConfig,
  type UserSource,
} from '../infrastructure/sources/config.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';

const CASE_DB_FILE = 'case.sqlite';

export interface SourceRow {
  readonly host: string;
  readonly nameZh: string;
  readonly kind: SourceKind;
  readonly category: SourceCategory;
  /** 領域標籤，多值（`catalog.ts` 檔頭「兩條正交的軸」）。 */
  readonly fields: readonly string[];
  readonly probe: string | null;
  readonly noteZh: string;
  readonly enabled: boolean;
  /** 內建的那幾列刪不掉，只能關掉 —— **刪了它下次升級又會回來**，那更混亂。 */
  readonly builtIn: boolean;
  /**
   * 這一列是從你的抓取紀錄長出來的，不是清單上的。
   *
   * **它的分類與型別是填的，不是知道的** —— 所以畫面上不顯示那兩格。
   * 顯示一個猜的分類會讓它看起來像一條被整理過的資料。
   */
  readonly discovered: boolean;
  /** 一般而言讀不讀得到。**只是起點，不是判斷。** */
  readonly expected: 'open' | 'login' | 'mixed' | null;
  readonly history: SiteHistory;
  readonly lastProbe: ProbeRecord | null;
  readonly verdict: SiteVerdict;
  readonly preference: 'prefer' | 'neutral' | 'deprioritise';
}

// ── 自己的紀錄 ────────────────────────────────────────────

/**
 * 把每個專題的 `run_item` 聚合成每個網域的紀錄。
 *
 * **跨專題聚合，而且是即時算的。**
 * 另外存一份計數器會快一點，而那一份會跟 `run_item` 分岔 ——
 * 而這是一個設定頁，不是熱路徑。
 */
export async function historyByHost(dataRoot: string): Promise<ReadonlyMap<string, SiteHistory>> {
  const out = new Map<
    string,
    {
      attempts: number;
      byAccess: Map<SiteAccess, number>;
      lastAt: number | null;
      lastCode: string | null;
    }
  >();
  const dir = casesDir(dataRoot);

  let slugs: string[];
  try {
    slugs = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return new Map();
  }

  for (const slug of slugs) {
    const opened = await openCaseDatabase(join(dir, slug, CASE_DB_FILE), {
      backupDir: backupsDir(dataRoot),
      backupLabel: slug,
    });
    if (opened.kind !== 'ok') continue;
    try {
      const rows = opened.db
        .prepare(
          `SELECT host, code, outcome, COUNT(*) AS n, MAX(at) AS last_at
           FROM run_item
           WHERE host IS NOT NULL AND outcome NOT IN ('queued','running','cancelled')
           GROUP BY host, code, outcome`,
        )
        .all() as Record<string, unknown>[];

      for (const row of rows) {
        const host = normaliseHost(String(row['host'] ?? ''));
        if (host.length === 0) continue;
        const code = row['code'] === null || row['code'] === undefined ? null : String(row['code']);
        const n = Number(row['n'] ?? 0);
        const lastAt = row['last_at'] === null ? null : Number(row['last_at']);

        const bucket = out.get(host) ?? {
          attempts: 0,
          byAccess: new Map<SiteAccess, number>(),
          lastAt: null,
          lastCode: null,
        };
        const access = accessFromCode(code);
        bucket.attempts += n;
        bucket.byAccess.set(access, (bucket.byAccess.get(access) ?? 0) + n);
        if (lastAt !== null && (bucket.lastAt === null || lastAt > bucket.lastAt)) {
          bucket.lastAt = lastAt;
          bucket.lastCode = code;
        }
        out.set(host, bucket);
      }
    } finally {
      opened.db.close();
    }
  }

  const result = new Map<string, SiteHistory>();
  for (const [host, b] of out) {
    result.set(host, {
      attempts: b.attempts,
      byAccess: Object.fromEntries(b.byAccess) as Readonly<Partial<Record<SiteAccess, number>>>,
      lastAt: b.lastAt,
      lastCode: b.lastCode,
    });
  }
  return result;
}

// ── 清單 ──────────────────────────────────────────────────

const EMPTY: SiteHistory = { attempts: 0, byAccess: {}, lastAt: null, lastCode: null };

function mergeRows(
  config: SourcesConfig,
  history: ReadonlyMap<string, SiteHistory>,
): readonly SourceRow[] {
  const rows = new Map<string, SourceRow>();

  const put = (
    host: string,
    base: {
      nameZh: string;
      kind: SourceKind;
      category: SourceCategory;
      fields: readonly string[];
      probe: string | null;
      noteZh: string;
      enabled: boolean;
      builtIn: boolean;
      discovered?: boolean;
      expected: 'open' | 'login' | 'mixed' | null;
    },
  ): void => {
    const h = history.get(host) ?? EMPTY;
    const probe = config.probes[host] ?? null;
    const verdict = verdictOf(h, probe);
    rows.set(host, {
      host,
      discovered: false,
      ...base,
      history: h,
      lastProbe: probe,
      verdict,
      preference: preferenceOf(verdict),
    });
  };

  for (const entry of CATALOG) {
    const host = normaliseHost(entry.host);
    put(host, {
      nameZh: entry.nameZh,
      kind: entry.kind,
      category: entry.category,
      fields: entry.fields,
      probe: entry.probe,
      noteZh: entry.noteZh,
      enabled: true,
      builtIn: true,
      expected: entry.expected,
    });
  }

  // 使用者的設定蓋在上面。**內建那一列的 `builtIn` 留著** ——
  // 「這一列是工具帶來的」與「這一列是我改過的」都要看得出來。
  for (const [host, user] of Object.entries(config.sources)) {
    const existing = rows.get(host);
    put(host, {
      nameZh: user.nameZh,
      kind: user.kind,
      category: user.category,
      fields: user.fields,
      probe: user.probe,
      noteZh: user.noteZh,
      enabled: user.enabled,
      builtIn: existing?.builtIn ?? false,
      expected: existing?.expected ?? null,
    });
  }

  // **抓過但不在清單上的網域也列出來。** 那正是「我到底都在抓哪裡」的答案，
  // 而它比任何一份內建清單都貼近實際。
  for (const [host, h] of history) {
    if (rows.has(host) || h.attempts === 0) continue;
    const verdict = verdictOf(h, config.probes[host] ?? null);
    rows.set(host, {
      host,
      nameZh: host,
      kind: 'site',
      category: 'reference',
      fields: [],
      probe: null,
      noteZh: '',
      enabled: true,
      builtIn: false,
      discovered: true,
      expected: null,
      history: h,
      lastProbe: config.probes[host] ?? null,
      verdict,
      preference: preferenceOf(verdict),
    });
  }

  return [...rows.values()].sort(
    (a, b) => b.history.attempts - a.history.attempts || a.host.localeCompare(b.host),
  );
}

export async function listSources(dataRoot: string | null): Promise<Result<readonly SourceRow[]>> {
  const cid = correlationId();
  const config = await readSourcesConfig();
  // 沒有資料根就沒有紀錄可以聚合 —— **那不是錯誤**，清單照樣列得出來。
  const history =
    dataRoot === null ? new Map<string, SiteHistory>() : await historyByHost(dataRoot);
  return ok(mergeRows(config, history), cid);
}

/**
 * 給 agent 的來源提示（`chooseAngles` 每次作業讀一次，放進 `sourcesUser`）。
 *
 * 三段而不是一段：「讀得到」是優先看的；「多半要登入」**仍然要給**，agent 找到時標明就好 ——
 * 不給的話它會照樣找到、而我們照樣抓不到，只是少了一句提醒；
 * 「還沒抓過」是使用者自己列上去而清單還沒有依據的，那是他說的話，要讓 agent 聽見。
 *
 * **只看 `enabled`，而且不列從紀錄長出來的那幾列**（`discovered`）——
 * 它們是「你抓過哪裡」的事實，不是「你想往哪裡找」的偏好。
 *
 * **使用者自己加的排在內建的前面。** 每段有上限，而內建清單一長（39 列），
 * 「還沒抓過」那一段光是內建的就塞滿了 —— 使用者自己加的那一列反而擠不進去，
 * 而那一列正是他最明確說過的話。
 */
export async function sourceHints(dataRoot: string | null): Promise<SourceHints> {
  const listed = await listSources(dataRoot);
  if (!listed.ok) return EMPTY_SOURCE_HINTS;
  const rows = listed.data
    .filter((r) => r.enabled && !r.discovered)
    .sort((a, b) => Number(a.builtIn) - Number(b.builtIn));
  const hosts = (pick: (r: SourceRow) => boolean): readonly string[] =>
    rows
      .filter(pick)
      .slice(0, MAX_SOURCE_HINTS_PER_GROUP)
      .map((r) => r.host);
  return {
    readable: hosts((r) => r.preference === 'prefer'),
    loginWalled: hosts((r) => r.preference === 'deprioritise'),
    untried: hosts((r) => r.preference === 'neutral' && r.verdict.basis === 'none'),
  };
}

// ── 編輯 ──────────────────────────────────────────────────

export interface SourceInput {
  readonly host: string;
  readonly nameZh?: string;
  readonly kind?: SourceKind;
  readonly category?: SourceCategory;
  readonly fields?: readonly string[];
  readonly probe?: string | null;
  readonly noteZh?: string;
  readonly enabled?: boolean;
}

/**
 * 存一列（新增或覆寫）。
 *
 * **回的清單要帶 `dataRoot`。** 2026-09-16 之前這裡回 `listSources(null)`：
 * 沒有資料根就沒有紀錄可以聚合，於是每存一次，從紀錄長出來的那幾列就從畫面上消失，
 * 重新整理才回來 —— 而畫面上「顯示 40／40 列」正是那種安靜的錯。
 * 呼叫端不知道資料根的時候（測試）給 `null`，那是刻意的降級不是預設。
 */
export async function saveSource(
  input: SourceInput,
  dataRoot: string | null = null,
): Promise<Result<readonly SourceRow[]>> {
  const cid = correlationId();
  const host = normaliseHost(input.host);
  if (host.length === 0 || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    return err('FETCH_BAD_URL', cid, { why: 'not-a-host' });
  }

  const config = await readSourcesConfig();
  const builtIn = CATALOG.find((e) => normaliseHost(e.host) === host) ?? null;
  const existing: UserSource | CatalogEntry | null = config.sources[host] ?? builtIn;

  // **不認得的型別與類型退回預設，不是原樣存**：這一支同時收設定檔與 HTTP 請求，
  // 一個打錯的類型存進去之後，讀回來會再被 `readSource` 退回「參考」—— 寫的時候就退，畫面上才看得到。
  const kind =
    input.kind !== undefined && SOURCE_KINDS.includes(input.kind) ? input.kind : undefined;
  const category =
    input.category !== undefined && SOURCE_CATEGORIES.includes(input.category)
      ? input.category
      : undefined;
  const next: UserSource = {
    host,
    nameZh: input.nameZh ?? existing?.nameZh ?? host,
    kind: kind ?? existing?.kind ?? 'site',
    category: category ?? existing?.category ?? 'reference',
    fields: input.fields === undefined ? (existing?.fields ?? []) : normaliseFields(input.fields),
    probe: input.probe === undefined ? (existing?.probe ?? null) : input.probe,
    noteZh: input.noteZh ?? existing?.noteZh ?? '',
    enabled: input.enabled ?? config.sources[host]?.enabled ?? true,
  };

  await writeSourcesConfig({ ...config, sources: { ...config.sources, [host]: next } });
  return listSources(dataRoot);
}

/**
 * 拿掉一列。
 *
 * **內建那幾列拿不掉，只會被關掉** —— 刪了它下次升級又會回來，
 * 而一個「刪了又自己出現」的清單比一個關得掉的清單難用得多。
 */
export async function removeSource(
  rawHost: string,
  dataRoot: string | null = null,
): Promise<Result<readonly SourceRow[]>> {
  const host = normaliseHost(rawHost);
  const config = await readSourcesConfig();
  const builtIn = CATALOG.some((e) => normaliseHost(e.host) === host);

  if (builtIn) {
    const current = config.sources[host];
    const disabled: UserSource = {
      host,
      nameZh: current?.nameZh ?? host,
      kind: current?.kind ?? 'site',
      category: current?.category ?? 'reference',
      fields: current?.fields ?? [],
      probe: current?.probe ?? null,
      noteZh: current?.noteZh ?? '',
      enabled: false,
    };
    await writeSourcesConfig({ ...config, sources: { ...config.sources, [host]: disabled } });
    return listSources(dataRoot);
  }

  const { [host]: _removed, ...rest } = config.sources;
  await writeSourcesConfig({ ...config, sources: rest });
  return listSources(dataRoot);
}

// ── 探測 ──────────────────────────────────────────────────

export interface ProbeOutcome {
  readonly host: string;
  readonly record: ProbeRecord | null;
  /** 這一列沒有探針。**不是失敗** —— 見 `catalog.ts` 為什麼可以沒有。 */
  readonly skipped: boolean;
}

/**
 * 探一個網域。**走的是同一條擷取管線**（robots、同網域間隔、429／503 退避）。
 *
 * 不走那條路的話，這個功能就變成第二條抓取路徑 ——
 * 而 ADR-0006 第 5 條寫的是「開第二條路等於那一層不存在」。
 *
 * ## 一個網域一台 `Crawler`
 *
 * 2026-09-08 第一次真的按下「檢查全部」：Semantic Scholar 回了 429
 * （沒有金鑰時它的限流很緊），而共用一台 `Crawler` 的話那一下會把整台停掉 ——
 * 於是排在後面的 Europe PMC、PubMed、Unpaywall **一個都沒被檢查**，
 * 而畫面上它們顯示的是「還沒有依據」，看起來像沒事。
 *
 * 「收到 429 立刻停」保護的是**那一台伺服器**，而這個批次裡
 * 每一個目標都是不同的伺服器 —— 一台停掉別台，那條規則就從
 * 「不要打擾對方」變成了「懲罰自己」。
 *
 * 2026-09-13 起 `Crawler` 自己就是「哪個 host 被限流就放棄哪個，其他照跑」
 * （`docs/architecture/fetch-policy.md`），所以這裡一台或多台都對。
 * 維持一個網域一台是為了探測彼此完全獨立 —— 一個探針不該分到別的探針的退避等待。
 */
async function probeOne(host: string, url: string | null): Promise<ProbeOutcome> {
  if (url === null || url.length === 0) return { host, record: null, skipped: true };

  const crawler = new Crawler({ intervalMs: configuredIntervalMs() });
  const result = await crawler.fetch(url);
  const code = result.outcome.kind === 'error' ? result.outcome.code : null;
  const access: SiteAccess = accessFromCode(code);
  return { host, record: { access, code, at: Date.now(), url }, skipped: false };
}

/**
 * 探一批。**同時最多三個網域** —— 併發只跨網域，
 * 而每個網域自己那條同網域間隔由它自己那台 `Crawler` 守著。
 */
const PROBE_CONCURRENCY = 3;

export async function probeSources(
  dataRoot: string | null,
  hosts: readonly string[] | null,
): Promise<Result<readonly SourceRow[]>> {
  const cid = correlationId();
  const config = await readSourcesConfig();
  const listed = await listSources(dataRoot);
  if (!listed.ok) return listed;

  const wanted = new Set((hosts ?? []).map(normaliseHost));
  const targets = listed.data.filter(
    (r) => r.enabled && r.probe !== null && (wanted.size === 0 || wanted.has(r.host)),
  );

  const probes: Record<string, ProbeRecord> = { ...config.probes };
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const row = targets[cursor++];
      if (row === undefined) return;
      const outcome = await probeOne(row.host, row.probe);
      // **限流的那一個記成「對方限流中」，其餘照常檢查。**
      if (outcome.record !== null) probes[row.host] = outcome.record;
    }
  };

  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, worker));

  await writeSourcesConfig({ ...config, probes });
  logger.info('來源網站檢查完成', { correlationId: cid, checked: targets.length });
  return listSources(dataRoot);
}
