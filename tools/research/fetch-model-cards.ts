/**
 * 把候選模型的 README（model card）抓下來，**為了查一件事：前綴**。
 *
 * 好幾個嵌入模型要求查詢與文件各自加一段前綴
 * （`query: `、`search_document: `、`Instruct: …`），
 * **少加就等於把那個模型的分數量低**，而那不是模型的問題，是量測的問題。
 *
 * 所以前綴要從**模型自己的 model card** 讀，不是憑印象填。
 *
 * 用法：
 *   npx tsx tools/research/fetch-model-cards.ts <輸出目錄>
 */
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Crawler } from '../../src/infrastructure/fetch/crawler.js';
import { sha256Of } from '../../src/infrastructure/fs/case-files.js';

const MANIFEST = 'docs/research/sources/manifest.jsonl';

const REPOS: readonly string[] = [
  'BAAI/bge-m3',
  'Qwen/Qwen3-Embedding-0.6B',
  'Snowflake/snowflake-arctic-embed-l-v2.0',
  'ibm-granite/granite-embedding-278m-multilingual',
  'nomic-ai/nomic-embed-text-v2-moe',
  'sentence-transformers/paraphrase-multilingual-mpnet-base-v2',
];

const [outDir, ...pick] = process.argv.slice(2);
const targets = pick.length > 0 ? pick : REPOS;
if (outDir === undefined) {
  console.error('用法：npx tsx tools/research/fetch-model-cards.ts <輸出目錄>');
  process.exit(2);
}
await mkdir(outDir, { recursive: true });

const crawler = new Crawler({ intervalMs: 4_000 });
for (const repo of targets) {
  const url = `https://huggingface.co/${repo}/raw/main/README.md`;
  const { outcome } = await crawler.fetch(url);
  if (outcome.kind !== 'ok') {
    console.error(`✗ ${repo} → ${outcome.code}`);
    continue;
  }
  await appendFile(
    MANIFEST,
    `${JSON.stringify({
      url,
      fetched_at: new Date().toISOString(),
      status: outcome.status,
      content_type: outcome.contentType,
      sha256: sha256Of(outcome.bytes),
      bytes: outcome.bytes.byteLength,
    })}\n`,
    'utf8',
  );
  const text = new TextDecoder().decode(outcome.bytes);
  const name = repo.replace('/', '__');
  await writeFile(join(outDir, `${name}.md`), text, 'utf8');
  console.error(`✓ ${repo} → ${text.length} 字`);
}
