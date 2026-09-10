/**
 * **量六項效能預算**（roadmap「Stage 13 的效能預算」）。
 *
 * ```
 * npx tsx tools/dev/measure-scale.ts --data-root <資料根> --slug <專題>
 * npx tsx tools/dev/measure-scale.ts --data-root <資料根> --slug <專題> --json out.json
 * ```
 *
 * ## 「沒有量測條件的數字不算數」
 *
 * roadmap 那一句是這支工具的全部設計。所以它印出來的不只是毫秒，
 * 還有**那個毫秒是在什麼上面量到的**：
 *
 * - **語料的形狀** —— 幾筆、幾個字、bigram 幾列、向量幾條、資料庫幾 MB
 * - **焦點是哪一個** —— 度數最高的那個與中位數的那個是兩個不同的問題，
 *   只量其中一個等於只回答一半。**平均的那個節點是最好走的那條路。**
 * - **查詢詞的貼文串多長** —— 「中文 2 字詞 < 300 ms」裡的那個詞是哪一個，
 *   決定了這個數字有沒有意義。查一個只出現在 3 份文件裡的詞，
 *   任何實作都會很快
 * - **重複幾次、取哪個百分位** —— 單次量測會量到 JIT 還沒暖、
 *   或者剛好一次 GC
 *
 * ## 兩件它**不**量的
 *
 * **一 · 互動 fps。** 那是瀏覽器裡的事，量它要一個真的 GPU 與一個真的視窗。
 * 做法寫在 `docs/operations/release-checklist.md`，由人跑。
 *
 * **二 · 檢索品質。** 合成語料的詞是從字池抽出來組的、向量是亂數 ——
 * 掃得多快是真的，找得準不準完全不是。
 *
 * ⚠️ 開發工具。**產品程式碼不 import 它。**
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cpus, totalmem } from 'node:os';

import type { DatabaseSync } from 'node:sqlite';

import { defaultFocus, subgraph, subgraphSize } from '../../src/application/graph-service.js';
import { searchCase } from '../../src/application/search-service.js';
import { normalizeFilters } from '../../src/domain/graph/subgraph.js';
import { DEFAULT_PROJECTION_THRESHOLDS } from '../../src/domain/graph/projection.js';
import { normalized } from '../../src/domain/search/similarity.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { semanticCandidates } from '../../src/infrastructure/index/vector-reader.js';
import { casesDir } from '../../src/infrastructure/fs/paths.js';
import { rng } from './scale-fixture.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

/**
 * 有沒有帶這個旗標。
 *
 * **不能用 `arg(name) === null` 判斷** —— 那一支對「沒帶」與
 * 「帶了但後面沒有值」回同一個 `null`，而一個布林旗標後面本來就沒有值。
 * 2026-09-10 實際踩到：`--skip-embed` 放在最後一個位置時完全沒有作用，
 * 而症狀是**它照跑**，不是報錯。
 */
function flag(name: string): boolean {
  return process.argv.includes('--' + name);
}

function num(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ── 統計 ────────────────────────────────────────────────────

export interface Timing {
  readonly runs: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 一項最多量多久。**很慢的那一項重複 15 次會跑掉十幾分鐘**，
 * 而它慢這件事本身早就從前三次看得出來了。
 */
const PER_CASE_BUDGET_MS = 20_000;

/** 至少要幾個樣本才有 p95 可言。低於這個數就一路量到夠，不管超不超時。 */
const MIN_SAMPLES = 3;

/**
 * 跑 `warmup + runs` 次，前面幾次丟掉。
 *
 * **暖身不是作弊。** 使用者按下去的第一次確實比較慢，而那一次慢的是
 * JIT 與作業系統的檔案快取 —— 跟這支程式的資料結構無關。
 * 兩個都要看，所以**第一次的時間也單獨留著**（`cold`）。
 *
 * **回傳的 `runs` 是實際跑到的次數，不是要求的次數** ——
 * 超時提早收工的時候，報告上要看得出來那個 p95 是用幾個樣本算的。
 */
async function measure(
  label: string,
  fn: () => Promise<unknown> | unknown,
  runs: number,
  warmup = 3,
): Promise<Timing & { readonly label: string; readonly cold: number }> {
  const t0 = performance.now();
  await fn();
  const cold = performance.now() - t0;

  // **一次就要半分鐘的東西不必量第二次。** 它超不超預算已經有答案了，
  // 而重複 15 次只是把這支工具變成跑不完的東西。
  if (cold > PER_CASE_BUDGET_MS) {
    const only = round(cold);
    return { label, runs: 1, cold: only, min: only, p50: only, p95: only, max: only };
  }
  for (let i = 1; i < warmup; i += 1) await fn();

  const times: number[] = [];
  const until = performance.now() + PER_CASE_BUDGET_MS;
  for (let i = 0; i < runs; i += 1) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
    if (times.length >= MIN_SAMPLES && performance.now() > until) break;
  }
  times.sort((a, b) => a - b);
  return {
    label,
    runs: times.length,
    cold: round(cold),
    min: round(times[0] as number),
    p50: round(percentile(times, 50)),
    p95: round(percentile(times, 95)),
    max: round(times[times.length - 1] as number),
  };
}

// ── 語料的形狀 ──────────────────────────────────────────────

function one(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}

interface Corpus {
  readonly items: number;
  readonly entities: number;
  readonly edges: number;
  readonly edgesByLayer: Readonly<Record<string, number>>;
  readonly evidence: number;
  readonly bigramRows: number;
  readonly distinctGrams: number;
  readonly vectors: number;
  readonly vectorDim: number;
  readonly vectorModel: string;
  readonly dbBytes: number;
  readonly derivedBytes: number | null;
}

/** `derived/` 佔多少。**它不在資料庫裡，而全文檢索的驗證那一段要讀它** —— 那是檔案 I/O。 */
function derivedBytesOf(folder: string): number | null {
  try {
    let total = 0;
    for (const entry of readdirSync(join(folder, 'derived'), { withFileTypes: true })) {
      if (entry.isFile()) total += statSync(join(folder, 'derived', entry.name)).size;
    }
    return total;
  } catch {
    return null;
  }
}

function corpusOf(db: DatabaseSync, dbPath: string, folder: string): Corpus {
  const layers: Record<string, number> = {};
  for (const row of db.prepare('SELECT layer, COUNT(*) AS n FROM edge GROUP BY layer').all() as {
    layer: string;
    n: number;
  }[]) {
    layers[row.layer] = Number(row.n);
  }
  const vec = db
    .prepare('SELECT model, dim, COUNT(*) AS n FROM vector GROUP BY model, dim')
    .get() as { model?: string; dim?: number; n?: number } | undefined;
  return {
    items: one(db, 'SELECT COUNT(*) AS n FROM item'),
    entities: one(db, 'SELECT COUNT(*) AS n FROM entity'),
    edges: one(db, 'SELECT COUNT(*) AS n FROM edge'),
    edgesByLayer: layers,
    evidence: one(db, 'SELECT COUNT(*) AS n FROM edge_evidence'),
    bigramRows: one(db, 'SELECT COUNT(*) AS n FROM bigram'),
    distinctGrams: one(db, 'SELECT COUNT(DISTINCT gram) AS n FROM bigram'),
    vectors: Number(vec?.n ?? 0),
    vectorDim: Number(vec?.dim ?? 0),
    vectorModel: String(vec?.model ?? ''),
    dbBytes: statSync(dbPath).size,
    derivedBytes: derivedBytesOf(folder),
  };
}

/**
 * 焦點四個級距。
 *
 * **度數最高的那個不是代表值，中位數的那個也不是** —— 兩個都要量。
 * 一個 5 萬節點的圖裡，樞紐的 2 跳鄰域可能整個圖都進來，
 * 而那正是 `GRAPH_SUBGRAPH_TOO_LARGE` 存在的理由。
 */
function focusSamples(db: DatabaseSync): { klass: string; id: string; degree: number }[] {
  const rows = db
    .prepare(
      'SELECT id, degree FROM (' +
        "  SELECT source_id AS id, COUNT(*) AS degree FROM edge WHERE source_kind = 'item' GROUP BY source_id" +
        ') ORDER BY degree DESC',
    )
    .all() as { id: string; degree: number }[];
  if (rows.length === 0) return [];
  const at = (frac: number): { id: string; degree: number } =>
    rows[Math.min(rows.length - 1, Math.floor(rows.length * frac))] as {
      id: string;
      degree: number;
    };
  return [
    { klass: '度數最高', ...(rows[0] as { id: string; degree: number }) },
    { klass: 'p99', ...at(0.01) },
    { klass: '中位數', ...at(0.5) },
    { klass: 'p10', ...at(0.9) },
  ];
}

/**
 * 查詢詞四個級距，**依貼文串長度**。
 *
 * 「中文 2 字詞 < 300 ms」這句話裡，哪一個 2 字詞決定了整件事 ——
 * 一個只出現在 3 份文件裡的詞，任何實作都很快。
 */
function gramSamples(db: DatabaseSync): { klass: string; gram: string; postings: number }[] {
  const rows = db
    .prepare(
      'SELECT gram, COUNT(*) AS postings FROM bigram' +
        " WHERE owner_kind = 'item' AND length(gram) = 2" +
        ' GROUP BY gram ORDER BY postings DESC LIMIT 40000',
    )
    .all() as { gram: string; postings: number }[];
  if (rows.length === 0) return [];
  const at = (frac: number): { gram: string; postings: number } =>
    rows[Math.min(rows.length - 1, Math.floor(rows.length * frac))] as {
      gram: string;
      postings: number;
    };
  return [
    { klass: '最常見', ...(rows[0] as { gram: string; postings: number }) },
    { klass: 'p90', ...at(0.1) },
    { klass: '中位數', ...at(0.5) },
    { klass: '罕見', ...at(0.95) },
  ];
}

// ── 主流程 ──────────────────────────────────────────────────

async function main(): Promise<number> {
  const dataRoot = arg('data-root');
  const slug = arg('slug');
  if (dataRoot === null || slug === null) {
    console.error('用法：npx tsx tools/dev/measure-scale.ts --data-root <資料根> --slug <專題>');
    return 2;
  }

  const runs = num('runs', 15);
  const folder = join(casesDir(dataRoot), slug);
  const dbPath = join(folder, 'case.sqlite');

  const opened = await openCaseDatabase(dbPath);
  if (opened.kind !== 'ok') {
    console.error('打不開專題資料庫（' + opened.kind + '）：' + dbPath);
    return 1;
  }

  const corpus = corpusOf(opened.db, dbPath, folder);
  const focuses = focusSamples(opened.db);
  const grams = gramSamples(opened.db);

  console.log('── 語料 ' + '─'.repeat(50));
  console.log(JSON.stringify(corpus, null, 2));
  console.log('');
  console.log(
    '焦點取樣：' +
      focuses.map((f) => f.klass + ' ' + f.id + '（度數 ' + f.degree + '）').join('、'),
  );
  console.log(
    '查詢詞取樣：' +
      grams.map((g) => g.klass + ' 「' + g.gram + '」（' + g.postings + ' 份）').join('、'),
  );
  console.log('');

  /**
   * `--only <名稱>`：只跑其中一項。
   *
   * 存在的理由是 ADR-0026 留下的那個問題要**一條曲線**，不是一個點 ——
   * 而每量一個點都把子圖與全文重跑一次，那條曲線要跑幾十分鐘。
   * 名稱：`semantic`／`subgraph`／`size`／`search`。預設全部跑。
   */
  const only = arg('only');
  const want = (name: string): boolean => only === null || only === name;

  const results: Record<string, unknown> = {};

  // ── 1. 語意檢索：純掃描 ────────────────────────────────
  //
  // **這一項在資料庫還開著的時候量**，因為預算問的是「暴力比對要多久」，
  // 不是「一次 HTTP 請求要多久」。端對端那個數字在下面另外量。
  if (want('semantic') && corpus.vectors > 0) {
    const r = rng(1234);
    const q = new Float32Array(corpus.vectorDim);
    for (let i = 0; i < corpus.vectorDim; i += 1) q[i] = r() * 2 - 1;
    const unit = normalized(q);
    const scan = await measure(
      '語意：掃 ' + corpus.vectors + ' 條向量',
      () => semanticCandidates(opened.db, unit, { model: corpus.vectorModel, limit: 400 }),
      Math.min(runs, 8),
      2,
    );
    results['semanticScan'] = { ...scan, vectors: corpus.vectors, dim: corpus.vectorDim };
    console.log(line(scan, 500));
  }
  opened.db.close();

  // ── 2. 子圖查詢 hops ≤ 2 ───────────────────────────────
  //
  // 走的是**應用層那一支**，所以包含開資料庫、投影、摺疊、載入節點與邊 ——
  // 也就是一次 HTTP 請求真正做的事。
  const filters = normalizeFilters({});
  const subgraphRows: unknown[] = [];
  for (const f of want('subgraph') ? focuses : []) {
    for (const hops of [1, 2]) {
      const out = await measure(
        '子圖 hops=' + hops + '（' + f.klass + '，度數 ' + f.degree + '）',
        () =>
          subgraph(dataRoot, slug, {
            focus: f.id,
            hops,
            filters,
            thresholds: DEFAULT_PROJECTION_THRESHOLDS,
          }),
        runs,
      );
      // 回的是節點還是 413，**兩種都是結果** —— 太大而擋下來也要花時間走到那裡。
      const once = await subgraph(dataRoot, slug, {
        focus: f.id,
        hops,
        filters,
        thresholds: DEFAULT_PROJECTION_THRESHOLDS,
      });
      const outcome = once.ok
        ? once.data.nodes.length + ' 個節點／' + once.data.edges.length + ' 條線'
        : once.code;
      subgraphRows.push({ ...out, focusClass: f.klass, degree: f.degree, hops, outcome });
      console.log(line(out, hops <= 2 ? 200 : null) + '　→ ' + outcome);
    }
  }
  results['subgraph'] = subgraphRows;

  // ── 3. 節點預算估算 ────────────────────────────────────
  //
  // **它走到 MAX_HOPS，不是走到使用者選的那一格** —— 工具列上四格
  // 要同時顯示各自的代價。所以它比上面那一支貴，而預算卻更嚴（50 ms）。
  const sizeRows: unknown[] = [];
  for (const f of want('size') ? focuses : []) {
    const out = await measure(
      '節點預算（' + f.klass + '，度數 ' + f.degree + '）',
      () =>
        subgraphSize(dataRoot, slug, {
          focus: f.id,
          hops: 2,
          filters,
          thresholds: DEFAULT_PROJECTION_THRESHOLDS,
        }),
      runs,
    );
    const once = await subgraphSize(dataRoot, slug, {
      focus: f.id,
      hops: 2,
      filters,
      thresholds: DEFAULT_PROJECTION_THRESHOLDS,
    });
    const outcome = once.ok ? JSON.stringify(once.data.counts) : once.code;
    sizeRows.push({ ...out, focusClass: f.klass, degree: f.degree, outcome });
    console.log(line(out, 50) + '　→ ' + outcome);
  }
  results['subgraphSize'] = sizeRows;

  if (want('size')) {
    const focusPick = await measure(
      '打開分頁：defaultFocus',
      () => defaultFocus(dataRoot, slug),
      runs,
    );
    results['defaultFocus'] = focusPick;
    console.log(line(focusPick, null));
  }

  // ── 4. 全文檢索（中文 2 字詞）──────────────────────────
  const searchRows: unknown[] = [];
  for (const g of want('search') ? grams : []) {
    const out = await measure(
      '全文「' + g.gram + '」（' + g.klass + '，' + g.postings + ' 份）',
      () => searchCase(dataRoot, slug, { q: g.gram, mode: 'text' }),
      runs,
    );
    const once = await searchCase(dataRoot, slug, { q: g.gram, mode: 'text' });
    const outcome = once.ok ? once.data.hits.length + ' 筆' : once.code;
    searchRows.push({ ...out, klass: g.klass, gram: g.gram, postings: g.postings, outcome });
    console.log(line(out, 300) + '　→ ' + outcome);
  }
  results['search'] = searchRows;

  // ── 5. 語意檢索：端對端 ────────────────────────────────
  //
  // **這一項需要 Ollama 開著**，而且量到的裡面有一段是網路往返。
  // 拿不到向量不是錯誤（`searchCase` 會降級成全文並在 `notices` 說出來）——
  // 所以這裡要**看回來的東西是不是真的語意結果**，不能只看有沒有出錯。
  if (want('semantic') && !flag('skip-embed') && corpus.vectors > 0) {
    const probe = await searchCase(dataRoot, slug, { q: '合成公司的收購案', mode: 'semantic' });
    const usable = probe.ok && probe.data.hits.some((h) => h.check === 'semantic');
    if (!usable) {
      console.log('端對端語意：跳過 —— 拿不到查詢向量（Ollama 沒開，或模型與這批資料不符）。');
      results['semanticEndToEnd'] = { skipped: 'no-query-vector' };
    } else {
      const out = await measure(
        '語意端對端（含嵌入往返）',
        () => searchCase(dataRoot, slug, { q: '合成公司的收購案', mode: 'semantic' }),
        Math.min(runs, 6),
        1,
      );
      results['semanticEndToEnd'] = out;
      console.log(line(out, null));
    }
  }

  const report = {
    generatedAt: new Date().toISOString().slice(0, 10),
    machine: {
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCores: cpus().length,
      totalMemGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    corpus,
    focuses,
    grams,
    runs,
    results,
  };

  const out = arg('json');
  if (out !== null) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log('寫進 ' + out);
  }
  return 0;
}

/** 一行結果。`budget` 給了就標過或不過 —— **看的是 p95，不是中位數。** */
function line(
  t: Timing & { readonly label: string; readonly cold: number },
  budget: number | null,
): string {
  const mark = budget === null ? '　' : t.p95 <= budget ? '✅' : '❌';
  return (
    mark +
    ' ' +
    t.label.padEnd(42) +
    ' p50 ' +
    String(t.p50).padStart(9) +
    '  p95 ' +
    String(t.p95).padStart(9) +
    '  冷 ' +
    String(t.cold).padStart(9) +
    (budget === null ? '' : '  預算 ' + budget)
  );
}

process.exitCode = await main();
