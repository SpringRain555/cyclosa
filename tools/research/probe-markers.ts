/**
 * 探針：看某個頁面的 HTML 裡有哪些單頁應用的骨架標記。
 *
 * **它留在 repo 裡是因為它是一個結論的證據**：
 * 2026-09-07 拿三個實際是 JS 渲染的頁面跑這一支，那張標記清單**命中 0 次**，
 * 於是 `looksJsOnly` 整條改寫（`docs/research/extraction-confidence.md`）。
 * 下一次有人想「補幾個標記進去」的時候，先跑這一支。
 */
import { Crawler } from '../../src/infrastructure/fetch/crawler.js';
import { decodeHtml } from '../../src/infrastructure/extract/decode.js';
import { charsetOf } from '../../src/domain/ingest/media-type.js';

const CANDIDATES = [
  '__next_data__',
  '__next_f',
  'data-reactroot',
  'id="root"',
  'id="app"',
  'ng-app',
  'data-server-rendered',
  'nuxt',
  '_nuxt',
  'astro-island',
  'svelte',
  '<noscript',
  'javascript',
  'turbo-frame',
  'data-sveltekit',
];

const crawler = new Crawler({ intervalMs: 3_000 });
for (const url of process.argv.slice(2)) {
  const { outcome } = await crawler.fetch(url);
  if (outcome.kind !== 'ok') {
    console.log(`${url} → ${outcome.code}`);
    continue;
  }
  const decoded = decodeHtml(outcome.bytes, charsetOf(outcome.contentType));
  const html = decoded.kind === 'ok' ? decoded.text.toLowerCase() : '';
  const hits = CANDIDATES.filter((c) => html.includes(c));
  console.log(`${url}\n  bytes=${outcome.bytes.byteLength} hits=${JSON.stringify(hits)}`);
  const m = /<noscript[^>]*>([\s\S]{0,200})/i.exec(html);
  if (m !== null) console.log(`  noscript: ${(m[1] ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
}
