/**
 * 範例專題。
 *
 * ## 它為什麼存在
 *
 * 第一次啟動之後畫面上是一個空清單，而這個工具做的事
 * （帶出處的關聯網、待查證的裁決佇列、投影三段）**沒有一項在空清單上看得見**。
 * 範例專題是那些東西的第一個實例。
 *
 * ## 語料是真的，出處也是真的
 *
 * 八條中華民國法律的**條文原文**，來自全國法規資料庫的官方大量下載。
 * 兩個獨立的授權依據都成立 —— 著作權法第 9 條（條文原文不是著作權標的）
 * 與政府資料開放授權條款第 1 版。完整查證在
 * `docs/research/sample-corpus-licence.md`。
 *
 * **每一份都帶著它自己那一條的網址**，不是整部法規的 ——
 * 那正是這個工具在講的事。
 *
 * ## 已確認的那四條關聯是範例資料
 *
 * 它們**不是誰真的裁決過的紀錄**。這句話寫在專題的說明欄裡，
 * 使用者在清單上第一眼就看得到。
 *
 * ## 走真的管線，不是直接寫資料庫
 *
 * 每一條條文都走 `ingestBytes` —— 寫快照到 `sources\`、抽正文到 `derived\`、
 * 寫全文索引。所以閱讀器讀得到、搜尋找得到，而且**引文的字元位置是
 * 產生器自己在正文裡找出來的**，不是寫死在語料檔裡（ADR-0021）。
 *
 * 唯一沒走的是向量：那需要一個嵌入模型，
 * 而**第一次啟動不該打網路**。使用者之後按一次「重建索引」就有了。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { openCaseDatabase } from '../infrastructure/db/database.js';
import { readCase, updateCaseStatus } from '../infrastructure/db/repositories/case-repo.js';
import * as edges from '../infrastructure/db/repositories/edge-repo.js';
import * as entities from '../infrastructure/db/repositories/entity-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import { reindexTitleRank } from '../infrastructure/index/writer.js';
import { caseDir, casesDir } from '../infrastructure/fs/paths.js';
import { readDerived } from '../infrastructure/fs/case-files.js';
import type { EdgeOrigin, EntityType } from '../domain/graph/types.js';
import { correlationId, newId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';
import { createCase, type CaseSummary } from './case-service.js';
import { ingestBytes } from './ingest-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 全形空白（U+3000），用來隔開同一行上的兩個欄位。
 *
 * **寫成常數不是為了討好 lint。** 一個看不出跟半形空白有什麼不同的字元
 * 直接躺在字串裡，下一個人改那幾行的時候會把它換成半形 ——
 * 而且不會知道自己換了東西。
 */
const WIDE = '　';

/** `dist/application/…` 與 `src/application/…` 都是往上一層再進 `assets`。 */
function corpusPath(): string {
  return join(HERE, '..', 'assets', 'sample-corpus.json');
}

interface CorpusArticle {
  readonly key: string;
  readonly law: string;
  readonly article: string;
  readonly text: string;
  readonly url: string;
}

interface CorpusEntity {
  readonly key: string;
  readonly type: EntityType;
  readonly name: string;
}

interface CorpusEdge {
  readonly from: string;
  readonly to: string;
  readonly rel: string;
  readonly origin: EdgeOrigin;
  readonly confidence?: number;
  /** 出處長在哪一份上。**預設是 `from`，而它不一定是** —— 見下面的註解。 */
  readonly evidenceFrom?: string;
  readonly quote: string;
}

interface Corpus {
  readonly version: number;
  readonly caseName: string;
  readonly seed: string;
  readonly source: Readonly<Record<string, string>>;
  readonly articles: readonly CorpusArticle[];
  readonly entities: readonly CorpusEntity[];
  readonly edges: readonly CorpusEdge[];
}

let cached: Corpus | null = null;

async function loadCorpus(): Promise<Corpus> {
  if (cached !== null) return cached;
  const raw = await readFile(corpusPath(), 'utf8');
  cached = JSON.parse(raw) as Corpus;
  return cached;
}

/**
 * 一條條文變成一份 Markdown。
 *
 * **出處寫進內容本身**，不只寫在資料庫欄位裡 ——
 * 一份被複製出去的快照，光看它自己就要說得出它是哪來的。
 * 這也是「註明出處」那個授權義務的履行方式。
 */
function articleMarkdown(a: CorpusArticle, source: Readonly<Record<string, string>>): string {
  return [
    `# ${a.law} ${a.article}`,
    '',
    a.text,
    '',
    '---',
    '',
    `出處：${a.law} ${a.article}（${a.url}）`,
    `資料集：${source['dataset']}${WIDE}提供機關：${source['agency']}`,
    `授權：${source['licence']}（${source['licenceUrl']}）`,
    `資料集更新日：${source['datasetUpdatedAt']}${WIDE}取得日：${source['retrievedAt']}`,
    '',
    source['alsoPublicDomain'] ?? '',
    '',
  ].join('\n');
}

/** 檔名不能有 `/`、`:` 這些字。**條號裡的空白也拿掉**，不然檔名會很難讀。 */
function fileNameOf(a: CorpusArticle): string {
  return `${a.law}-${a.article.replace(/\s+/g, '')}.md`;
}

export interface SampleResult {
  readonly slug: string;
  readonly items: number;
  readonly entities: number;
  readonly edges: number;
  /** 引文在正文裡找不到位置的條數。**正常是 0** —— 不是 0 就記日誌。 */
  readonly quotesUnplaced: number;
}

/**
 * 建立範例專題。
 *
 * 已經有同名專題就**什麼都不做**（回 `CASE_NAME_DUPLICATE`）——
 * 這一支會被「重建範例專題」那顆按鈕呼叫，而重建不該悄悄產生第二份。
 */
export async function createSampleCase(dataRoot: string): Promise<Result<SampleResult>> {
  const cid = correlationId();
  const corpus = await loadCorpus();

  const made = await createCase(dataRoot, { name: corpus.caseName, seed: corpus.seed });
  if (!made.ok) return made;
  const summary: CaseSummary = made.data;

  const folder = caseDir(dataRoot, summary.slug);
  const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
  // 剛建好的專題照理不會不見 —— 但如果真的不見了，那句話該是「找不到」，
  // 不是「migration 失敗」。
  if (opened.kind === 'missing') return err('CASE_NOT_FOUND', cid, { slug: summary.slug });
  if (opened.kind !== 'ok') return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { slug: summary.slug });

  try {
    const filled = await fill(opened.db, folder, corpus);
    logger.info('範例專題已建立', { slug: summary.slug, ...filled });
    return ok({ slug: summary.slug, ...filled }, cid);
  } finally {
    opened.db.close();
  }
}

async function fill(
  db: DatabaseSync,
  folder: string,
  corpus: Corpus,
): Promise<Omit<SampleResult, 'slug'>> {
  const now = Date.now();
  const runId = newId();

  // **一個 run 裝八條，不是八個 run。** 使用者在作業紀錄上看到的
  // 應該是「匯入了範例語料」這一件事，不是八件一模一樣的事。
  runs.insertRun(db, {
    id: runId,
    kind: 'import',
    label: '範例語料',
    total: corpus.articles.length,
    correlationId: 'sample',
    now,
  });
  runs.startRun(db, runId, now);

  const itemIdOf = new Map<string, string>();
  let failed = 0;

  for (const a of corpus.articles) {
    const runItemId = newId();
    const itemId = newId();
    runs.insertRunItem(db, { id: runItemId, runId, requested: a.url, host: 'law.moj.gov.tw' });
    items.insertPendingItem(db, {
      id: itemId,
      kind: 'text',
      requestedUrl: a.url,
      title: `${a.law} ${a.article}`,
      runId,
      now,
    });

    const outcome = await ingestBytes(db, folder, {
      runItemId,
      itemId,
      // **兩個都給那一條自己的網址** —— 沒有轉址，所以 requested 就是 final。
      requestedUrl: a.url,
      finalUrl: a.url,
      bytes: new TextEncoder().encode(articleMarkdown(a, corpus.source)),
      contentType: null,
      fileName: fileNameOf(a),
      hops: [],
      // **不載入 provider** —— 第一次啟動不打網路。向量之後按「重建索引」再補。
      providers: null,
    });
    if (outcome.counts === 'failed') failed += 1;
    else if (outcome.itemId !== null) itemIdOf.set(a.key, outcome.itemId);
  }

  runs.settleRunRow(db, {
    id: runId,
    status: failed === 0 ? 'done' : 'partial',
    succeeded: corpus.articles.length - failed,
    failed,
    now: Date.now(),
  });

  const entityIdOf = new Map<string, string>();
  for (const e of corpus.entities) {
    const id = newId();
    entities.insertEntity(db, { id, type: e.type, name: e.name, now });
    entityIdOf.set(e.key, id);
  }

  const quotes = await placeQuotes(folder, corpus, itemIdOf);
  let written = 0;
  for (const e of corpus.edges) {
    const source = itemIdOf.get(e.from) ?? entityIdOf.get(e.from);
    const target = itemIdOf.get(e.to) ?? entityIdOf.get(e.to);
    if (source === undefined || target === undefined) continue;

    const edgeId = edges.insertEdge(
      db,
      {
        source,
        target,
        rel: e.rel,
        layer: 'named',
        sourceKind: itemIdOf.has(e.from) ? 'item' : 'entity',
        targetKind: itemIdOf.has(e.to) ? 'item' : 'entity',
        origin: e.origin,
        confidence: e.confidence ?? 1,
        runId,
      },
      now,
    );
    written += 1;

    const placed = quotes.get(e);
    if (placed !== undefined) {
      edges.insertEvidence(db, edgeId, [placed], now);
    }

    // **已確認的那幾條要有稽核列**，否則面板上會出現一條
    // 「已確認」卻沒有任何人確認過的邊 —— 那正是這個工具最不該長出來的東西。
    if (e.origin === 'human') {
      edges.appendAudit(db, {
        edgeId,
        from: 'pending',
        to: 'confirmed',
        action: 'confirm',
        actor: 'human',
        runId: null,
        at: now,
      });
    }
  }

  reindexTitleRank(db);

  // **狀態要自己收尾。** `ingestBytes` 不碰專題狀態（那是 `importFile`
  // 在它外面做的），所以少了這一行會得到一個有 8 份資料、
  // 而狀態寫著「新建」的專題 —— 「新建」的意思是「還沒放東西進去」。
  if (readCase(db)?.status === 'new') updateCaseStatus(db, 'ready', Date.now());

  return {
    items: itemIdOf.size,
    entities: entityIdOf.size,
    edges: written,
    quotesUnplaced: corpus.edges.length - quotes.size,
  };
}

/**
 * 把每一段引文在**抽出來的正文**裡定位。
 *
 * **位置不寫在語料檔裡，是這裡自己找的**（ADR-0021 那條「模型給的位置一律
 * 不採信」的同一個判準）—— 因為 `derived/` 可以整批重算，
 * 而重算之後字元位移會平移。寫死的位置會產生一種特別糟的錯：
 * **每一條看起來都完整，而區間指到別的地方。**
 *
 * 找不到就**不寫那一條出處**，而不是寫一個猜的位置。
 */
async function placeQuotes(
  folder: string,
  corpus: Corpus,
  itemIdOf: ReadonlyMap<string, string>,
): Promise<Map<CorpusEdge, edges.NewEvidence>> {
  const text = new Map<string, string>();
  for (const [key, id] of itemIdOf) {
    const d = await readDerived(folder, id);
    if (d !== null) text.set(key, d.text);
  }

  const out = new Map<CorpusEdge, edges.NewEvidence>();
  for (const e of corpus.edges) {
    const key = e.evidenceFrom ?? e.from;
    const itemId = itemIdOf.get(key);
    const body = text.get(key);
    if (itemId === undefined || body === undefined) continue;
    const at = body.indexOf(e.quote);
    if (at < 0) {
      logger.warn('範例語料的引文在正文裡找不到', { key, quote: e.quote.slice(0, 20) });
      continue;
    }
    out.set(e, {
      itemId,
      quote: e.quote,
      charStart: at,
      charEnd: at + e.quote.length,
    });
  }
  return out;
}

/**
 * 資料根剛建好的時候放一份範例進去。**失敗不擋啟動。**
 *
 * ## 「刪掉之後不會自己回來」靠的是資料根本身
 *
 * 這一支只在**資料根是這一次才建出來的**時候被呼叫，
 * 所以不需要另外記一個「使用者刪過了」的旗標：
 *
 * - 刪掉範例 → 重啟 → 資料根已經在了 → 不會再建 ✓
 * - 搬資料根 → 資料夾跟著過去 → 一樣不會再建 ✓
 * - 整個 `%LOCALAPPDATA%\Cyclosa` 被清掉 → 那是一次全新安裝，該回來 ✓
 *
 * **一個少一份狀態的設計比一個記得住狀態的設計好** ——
 * 前者不會有「旗標與現實對不上」這種狀態。
 */
export async function seedSampleIfEmpty(dataRoot: string): Promise<void> {
  try {
    const { readdir } = await import('node:fs/promises');
    const existing = await readdir(casesDir(dataRoot)).catch(() => [] as string[]);
    if (existing.length > 0) return;

    const r = await createSampleCase(dataRoot);
    if (!r.ok) logger.warn('範例專題沒有建起來', { code: r.code });
  } catch (e) {
    // **這不是啟動失敗。** 沒有範例專題的 Cyclosa 仍然完全可用。
    logger.warn('建立範例專題時出了例外', { reason: String((e as Error).message) });
  }
}
