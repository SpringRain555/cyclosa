/**
 * 嵌入模型評測的**語料**：抓一批真實頁面，切成段落。
 *
 * ## 為什麼是這樣的三組
 *
 * 評測要問的是「繁中查詢找不找得到英文原文」，而如果同一個主題
 * 中英兩篇都在語料裡，**答案就有兩個** —— 模型把中文那一段排第一
 * 其實對使用者也是對的，卻會被判錯。所以語料刻意分三組：
 *
 * | 組 | 抓什麼 | 用來問什麼 |
 * |---|---|---|
 * | `paired` | 中英**都抓** | 同語言檢索、同義改寫 |
 * | `en-only` | **只抓英文** | **繁中查詢 → 英文原文**（唯一解，沒有中文可退） |
 * | `zh-only` | 只抓中文 | 中文檢索，兼作干擾項 |
 *
 * ## 為什麼抓 `/wiki/` 的 HTML 而不是 `/w/api.php`
 *
 * **第一版用的是 API，被自己的 robots 檢查擋下來了**（2026-09-09）：
 * Wikipedia 的 `robots.txt` 對 `User-agent: *` 寫著 `Disallow: /w/` 與
 * `Disallow: /api/`，只放行 `action=mobileview` 與 `load.php`。
 * 34 個請求全部回 `FETCH_ROBOTS_DISALLOWED` —— **那是守門成功，不是故障**，
 * 所以改路徑而不是改檢查。`/wiki/<Title>` 在放行範圍內。
 *
 * 換過來反而更貼近真實：走的是 `Crawler` → `decodeHtml` → `extractHtml`
 * （Readability）**整條匯入管線**，而不是一個吐好純文字的 API。
 * 量測如果走另一條路，量到的就不是使用者會遇到的東西。
 *
 * 語料**不進 repo**（CC BY-SA 的散播義務不該落在一個 MIT 專案上），
 * 所以「重現」靠的是頁面清單 ＋ `wgCurRevisionId` ＋ SHA-256。
 *
 * 用法：
 *   npx tsx tools/research/fetch-eval-corpus.ts <輸出目錄>
 */
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import { charsetOf } from '../../src/domain/ingest/media-type.js';
import { chunkText } from '../../src/domain/search/chunk.js';
import { Crawler } from '../../src/infrastructure/fetch/crawler.js';
import { decodeHtml } from '../../src/infrastructure/extract/decode.js';
import { extractHtml } from '../../src/infrastructure/extract/html.js';
import { sha256Of } from '../../src/infrastructure/fs/case-files.js';

const MANIFEST = 'docs/research/sources/manifest.jsonl';

/**
 * 中文頁面走**繁體變體**的路徑。
 *
 * `zh.wikipedia.org/wiki/<標題>` 會依 `Accept-Language` 給簡體或繁體，
 * 而這個工具的介面與使用者都是繁中 —— 語料是簡體的話，量到的
 * 會混進「模型對簡繁的處理」，那不是這次要問的問題。
 * `/zh-tw/` 不在 robots.txt 的 `Disallow` 清單裡（那份只擋 `/w/`、`/api/`、`/trap/` 與 `Special:`）。
 */
const ZH_PATH = 'zh-tw';

/** 中英都抓：同語言檢索與同義改寫用。 */
const PAIRED: readonly (readonly [string, string])[] = [
  ['蜘蛛', 'Spider'],
  ['光合作用', 'Photosynthesis'],
  ['板塊構造論', 'Plate_tectonics'],
  ['大型語言模型', 'Large_language_model'],
  ['知識圖譜', 'Knowledge_graph'],
  ['SQLite', 'SQLite'],
  ['區塊鏈', 'Blockchain'],
  ['免疫系統', 'Immune_system'],
  ['臺灣高速鐵路', 'Taiwan_High_Speed_Rail'],
  ['節氣', 'Solar_term'],
];

/** **只抓英文** —— 繁中查詢要命中它們的唯一解就是英文那一段。 */
const EN_ONLY: readonly string[] = [
  'Orb-weaver_spider',
  'Spider_web',
  'Retrieval-augmented_generation',
  'Word_embedding',
  'Full-text_search',
  'Tropical_cyclone',
  'Coral_reef',
  'Mycorrhiza',
];

/** 只抓中文：中文檢索，兼作干擾項。 */
const ZH_ONLY: readonly string[] = [
  '颱風假',
  '臺灣鐵路管理局',
  '珊瑚白化',
  '共生',
  '向量資料庫',
  '開放原始碼',
];

export interface Passage {
  readonly id: string;
  readonly lang: 'zh' | 'en';
  readonly group: 'paired' | 'en-only' | 'zh-only';
  readonly page: string;
  readonly text: string;
}

const crawler = new Crawler({ intervalMs: 4_000 });

interface PageText {
  readonly title: string;
  readonly revid: string | null;
  readonly text: string;
}

async function fetchPage(host: string, prefix: string, title: string): Promise<PageText | null> {
  const url = `https://${host}/${prefix}/${encodeURIComponent(title)}`;
  const { outcome } = await crawler.fetch(url);
  if (outcome.kind !== 'ok') {
    console.error(`  ✗ ${title} → ${outcome.code}`);
    return null;
  }
  const decoded = decodeHtml(outcome.bytes, charsetOf(outcome.contentType));
  const revid =
    decoded.kind === 'ok'
      ? (/"wgCurRevisionId"\s*:\s*(\d+)/.exec(decoded.text)?.[1] ?? null)
      : null;
  /**
   * **版本編號寫進 manifest**（2026-09-29 補）。
   *
   * `embedding-choice.md` 寫「重現靠頁面清單 ＋ `wgCurRevisionId` ＋ SHA-256」，而 09-09 那一輪的版本編號
   * 只寫進了 `pages.json` —— 那一份跟語料一起留在暫存目錄、沒有留下來。**manifest 是唯一進版控的那一份**，
   * 所以版本編號要在這裡；沒有它，下一輪就釘不回同一版頁面（HTML 每次都不同，雜湊比不了）。
   */
  await appendFile(
    MANIFEST,
    `${JSON.stringify({
      url,
      fetched_at: new Date().toISOString(),
      status: outcome.status,
      content_type: outcome.contentType,
      sha256: sha256Of(outcome.bytes),
      bytes: outcome.bytes.byteLength,
      revid,
    })}\n`,
    'utf8',
  );

  if (decoded.kind !== 'ok') {
    console.error(`  ✗ ${title} → 解碼失敗`);
    return null;
  }
  const extracted = extractHtml(decoded.text, outcome.finalUrl);
  if (extracted.text.length < 500) {
    console.error(`  ✗ ${title} → 正文只有 ${extracted.text.length} 字`);
    return null;
  }
  return { title: extracted.title, revid, text: extracted.text };
}

/**
 * 切段。**用出貨的那一支**（`domain/search/chunk.ts`）。
 *
 * 這裡曾經有一份自己的實作，v0.11.0 把它拿掉了：
 * **量測用一支、出貨用另一支的話，量出來的分數對出貨的東西不成立** ——
 * 而兩份程式碼長得很像的時候，沒有任何地方會報錯。
 *
 * 傳 `Infinity` 是刻意的：出貨那一側有每份文件 6 段的上限（那是效能預算），
 * 而語料要的是「這一頁全部切出來長什麼樣」——
 * 帶著上限去抓的話，34 頁會從 1955 段掉到 204 段。
 *
 * `lang` 這個參數也不見了：**參數由文字本身決定**（`cjkRatio`），
 * 因為語言偵測會給出自信而錯誤的答案。對這份語料兩者結果相同
 * （中文頁幾乎全是 CJK、英文頁幾乎沒有），所以那個改動不影響可比性。
 */
function chunk(text: string): string[] {
  return chunkText(text, Infinity).map((c) => c.text);
}

async function collect(
  host: string,
  prefix: string,
  lang: 'zh' | 'en',
  group: Passage['group'],
  titles: readonly string[],
  passages: Passage[],
  pages: Record<string, unknown>[],
): Promise<void> {
  for (const title of titles) {
    const page = await fetchPage(host, prefix, title);
    if (page === null) continue;
    const parts = chunk(page.text);
    parts.forEach((text, i) => {
      passages.push({ id: `${lang}:${title}#${i}`, lang, group, page: page.title, text });
    });
    pages.push({
      host,
      title,
      resolved: page.title,
      revid: page.revid,
      lang,
      group,
      passages: parts.length,
    });
    console.error(`  ✓ ${page.title} (rev ${page.revid ?? '?'}) → ${parts.length} 段`);
  }
}

const outDir = process.argv[2];
if (outDir === undefined) {
  console.error('用法：npx tsx tools/research/fetch-eval-corpus.ts <輸出目錄>');
  process.exit(2);
}
await mkdir(outDir, { recursive: true });

const passages: Passage[] = [];
const pages: Record<string, unknown>[] = [];

console.error('paired（中英都抓）');
await collect(
  'zh.wikipedia.org',
  ZH_PATH,
  'zh',
  'paired',
  PAIRED.map(([zh]) => zh),
  passages,
  pages,
);
await collect(
  'en.wikipedia.org',
  'wiki',
  'en',
  'paired',
  PAIRED.map(([, en]) => en),
  passages,
  pages,
);
console.error('en-only（繁中查詢的唯一解）');
await collect('en.wikipedia.org', 'wiki', 'en', 'en-only', EN_ONLY, passages, pages);
console.error('zh-only（中文檢索與干擾項）');
await collect('zh.wikipedia.org', ZH_PATH, 'zh', 'zh-only', ZH_ONLY, passages, pages);

await writeFile(
  join(outDir, 'corpus.jsonl'),
  passages.map((p) => JSON.stringify(p)).join('\n') + '\n',
  'utf8',
);
await writeFile(join(outDir, 'pages.json'), JSON.stringify(pages, null, 2) + '\n', 'utf8');

const zh = passages.filter((p) => p.lang === 'zh').length;
console.error(
  `\n${pages.length} 頁 → ${passages.length} 段（中文 ${zh}、英文 ${passages.length - zh}）`,
);
