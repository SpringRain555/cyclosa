/**
 * open-questions **Q2** 的量測：「抽取信心值要怎麼算才不是又一個假數字」。
 *
 * **走的是真的擷取管線**（`Crawler`），不是另寫一個簡化版 ——
 * 量測如果走另一條路，量到的就不是使用者會遇到的東西。
 *
 * 用法（需要網路）：
 *   npx tsx tools/research/measure-extraction.ts <輸出.jsonl> [url ...]
 *
 * 不給 URL 就跑內建的那一批；給了就只跑那幾個並**接在檔案後面**
 * （補樣本用 —— 重跑整批會在十分鐘內對同一批網站抓第二次）。
 *
 * 產出每個頁面的訊號 ＋ 正文開頭，**人工判讀那一欄要人自己填** ——
 * 這支腳本不判斷好壞，它只把要判斷的東西擺出來。
 */
import { appendFile, writeFile } from 'node:fs/promises';

import { assessExtraction, looksJsOnly } from '../../src/domain/ingest/extract-confidence.js';
import { classifyMime, charsetOf } from '../../src/domain/ingest/media-type.js';
import { Crawler } from '../../src/infrastructure/fetch/crawler.js';
import { decodeHtml } from '../../src/infrastructure/extract/decode.js';
import { extractHtml } from '../../src/infrastructure/extract/html.js';
import { detectLanguage } from '../../src/infrastructure/extract/language.js';
import { sha256Of } from '../../src/infrastructure/fs/case-files.js';

/**
 * 30 個真實頁面，刻意涵蓋會出錯的方向：
 * 長文、短文、導覽頁、列表頁、單頁應用、規格書、中文、日文、掃描不到的內容。
 *
 * **一個主機盡量只放一頁** —— 節流是同主機 3 秒，全放同一台會讓量測變成在等。
 */
const URLS: readonly string[] = [
  'https://en.wikipedia.org/wiki/Graph_theory',
  'https://zh.wikipedia.org/wiki/%E5%9C%96%E8%AB%96',
  'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/article',
  'https://nodejs.org/en/about',
  'https://www.rfc-editor.org/rfc/rfc9309.html',
  'https://example.com/',
  'https://news.ycombinator.com/',
  'https://github.com/mozilla/readability',
  'https://blog.rust-lang.org/',
  'https://docs.python.org/3/library/json.html',
  'https://www.w3.org/TR/annotation-model/',
  'https://sqlite.org/fts5.html',
  'https://vite.dev/',
  'https://www.python.org/',
  'https://arxiv.org/abs/1706.03762',
  'https://www.gutenberg.org/ebooks/84',
  'https://text.npr.org/',
  'https://www.mozilla.org/en-US/about/',
  'https://ollama.com/library/bge-m3',
  'https://fastify.dev/docs/latest/Reference/Server/',
  'https://vuejs.org/guide/introduction.html',
  'https://www.gov.uk/guidance/keeping-children-safe-in-education',
  'https://www.cna.com.tw/',
  'https://www.moe.gov.tw/',
  'https://www.ptt.cc/bbs/Gossiping/index.html',
  'https://ja.wikipedia.org/wiki/%E3%82%B0%E3%83%A9%E3%83%95%E7%90%86%E8%AB%96',
  'https://stackoverflow.com/questions/1732348/regex-match-open-tags-except-xhtml-self-contained-tags',
  'https://www.bbc.com/news',
  'https://openai.com/index/chatgpt/',
  'https://tw.stock.yahoo.com/',
  'https://www.wikidata.org/wiki/Q42',
  'https://httpbin.org/html',
];

interface Row {
  readonly url: string;
  readonly ok: boolean;
  readonly code: string | null;
  readonly mime: string | null;
  readonly lang: string | null;
  readonly title: string | null;
  readonly textLength: number | null;
  readonly htmlLength: number | null;
  readonly paragraphCount: number | null;
  readonly linkDensity: number | null;
  readonly hasArticleTag: boolean | null;
  readonly readabilityFailed: boolean | null;
  readonly lowConfidence: boolean | null;
  readonly reasons: readonly string[] | null;
  readonly jsOnly: boolean | null;
  /** 給人判讀用的開頭。**人工那一欄要人自己看這個之後填。** */
  readonly sample: string | null;
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (out === undefined) {
    console.error('用法：npx tsx tools/research/measure-extraction.ts <輸出.jsonl> [url ...]');
    process.exit(2);
    return;
  }

  const extra = process.argv.slice(3);
  const targets = extra.length > 0 ? extra : URLS;
  if (extra.length === 0) await writeFile(out, '', 'utf8');
  const manifest = 'docs/research/sources/manifest.jsonl';
  const crawler = new Crawler({
    intervalMs: 3_000,
    onEvent: (e) => {
      console.log(`  ${e.host} 等了 ${e.waitedMs}ms（robots: ${e.robotsSource}）`);
    },
  });

  let n = 0;
  for (const url of targets) {
    n++;
    console.log(`[${n}/${targets.length}] ${url}`);

    const { outcome, rateLimited } = await crawler.fetch(url);
    if (outcome.kind === 'error') {
      console.log(`  失敗 ${outcome.code} ${JSON.stringify(outcome.detail)}`);
      const row: Row = {
        url,
        ok: false,
        code: outcome.code,
        mime: null,
        lang: null,
        title: null,
        textLength: null,
        htmlLength: null,
        paragraphCount: null,
        linkDensity: null,
        hasArticleTag: null,
        readabilityFailed: null,
        lowConfidence: null,
        reasons: null,
        jsOnly: null,
        sample: null,
      };
      await appendFile(out, `${JSON.stringify(row)}\n`, 'utf8');
      if (rateLimited) {
        // 退避重試過了還是被限流：這個 host 這一輪放棄，**其他 host 照量**。
        console.log(
          '  **對方回 429／503，退避重試後仍被限流；這個 host 這一輪不再碰，其餘照跑。**',
        );
      }
      continue;
    }

    await appendFile(
      manifest,
      `${JSON.stringify({
        url: outcome.finalUrl,
        fetched_at: new Date().toISOString(),
        status: outcome.status,
        content_type: outcome.contentType,
        sha256: sha256Of(outcome.bytes),
        bytes: outcome.bytes.byteLength,
        note: 'Q2 抽取信心量測',
      })}\n`,
      'utf8',
    );

    const media = classifyMime(outcome.contentType);
    if (media.kind !== 'ok' || media.itemKind !== 'web') {
      console.log(`  略過（不是網頁）：${media.kind === 'ok' ? media.mime : media.mime}`);
      continue;
    }

    const decoded = decodeHtml(outcome.bytes, charsetOf(outcome.contentType));
    if (decoded.kind !== 'ok') {
      console.log(`  解碼失敗：${decoded.charset}`);
      continue;
    }

    const extracted = extractHtml(decoded.text, outcome.finalUrl);
    const signals = extracted.signals;
    const verdict = assessExtraction(signals);
    const row: Row = {
      url: outcome.finalUrl,
      ok: true,
      code: null,
      mime: media.mime,
      lang: detectLanguage(extracted.text),
      title: extracted.title.slice(0, 120),
      textLength: signals.textLength,
      htmlLength: signals.htmlLength,
      paragraphCount: signals.paragraphCount,
      linkDensity: Number(signals.linkDensity.toFixed(3)),
      hasArticleTag: signals.hasArticleTag,
      readabilityFailed: signals.readabilityFailed,
      lowConfidence: verdict.lowConfidence,
      reasons: verdict.reasons,
      jsOnly: looksJsOnly(signals),
      sample: extracted.text.slice(0, 260).replace(/\s+/g, ' '),
    };
    await appendFile(out, `${JSON.stringify(row)}\n`, 'utf8');
    console.log(
      `  文字 ${signals.textLength} · 段落 ${signals.paragraphCount} · 連結密度 ${row.linkDensity} · article=${signals.hasArticleTag} → ${verdict.lowConfidence ? '低信心 ' + verdict.reasons.join(',') : 'OK'}`,
    );
  }

  console.log(`\n寫到 ${out}`);
}

await main();
