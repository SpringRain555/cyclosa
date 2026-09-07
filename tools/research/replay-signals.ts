/**
 * 拿 `measure-extraction.ts` 存下來的訊號**重跑判定**，不再連網。
 *
 * 這支存在的理由：調門檻不該需要重新抓 34 個網站 ——
 * 那不只慢，還會對別人的伺服器多打一輪。**訊號存下來，判定隨時可以重放。**
 *
 * 用法：
 *   npx tsx tools/research/replay-signals.ts <訊號.jsonl> [人工判讀.json]
 *
 * 第二個參數是 `{ "<url>": "good" | "bad" }`。給了就順便算
 * 命中／誤報／漏報，沒給就只印判定。
 */
import { readFile } from 'node:fs/promises';

import {
  assessExtraction,
  looksJsOnly,
  type ExtractSignals,
} from '../../src/domain/ingest/extract-confidence.js';

interface Row extends Partial<ExtractSignals> {
  readonly url: string;
  readonly ok: boolean;
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('用法：npx tsx tools/research/replay-signals.ts <訊號.jsonl> [人工判讀.json]');
    process.exit(2);
    return;
  }

  const rows = (await readFile(path, 'utf8'))
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => r.ok);

  let truth: Record<string, string> = {};
  const truthPath = process.argv[3];
  if (truthPath !== undefined)
    truth = JSON.parse(await readFile(truthPath, 'utf8')) as Record<string, string>;

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (const row of rows) {
    const signals: ExtractSignals = {
      textLength: row.textLength ?? 0,
      htmlLength: row.htmlLength ?? 0,
      paragraphCount: row.paragraphCount ?? 0,
      linkDensity: row.linkDensity ?? 0,
      hasArticleTag: row.hasArticleTag ?? false,
      readabilityFailed: row.readabilityFailed ?? false,
    };
    const verdict = assessExtraction(signals);
    const human = truth[row.url];
    let mark = '';
    if (human !== undefined) {
      const bad = human === 'bad';
      if (verdict.lowConfidence && bad) {
        tp++;
        mark = '命中';
      } else if (verdict.lowConfidence && !bad) {
        fp++;
        mark = '**誤報**';
      } else if (!verdict.lowConfidence && bad) {
        fn++;
        mark = '**漏報**';
      } else {
        tn++;
        mark = '正確放行';
      }
    }
    console.log(
      `${verdict.lowConfidence ? '低信心' : '  OK  '} ${looksJsOnly(signals) ? 'JS' : '  '} ${mark.padEnd(10)} ${row.url}  [${verdict.reasons.join(',')}]`,
    );
  }

  if (truthPath !== undefined) {
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    console.log(
      `\n樣本 ${rows.length}\u3000命中 ${tp}\u3000誤報 ${fp}\u3000漏報 ${fn}\u3000正確放行 ${tn}` +
        `\n精確率 ${(precision * 100).toFixed(0)}%\u3000召回率 ${(recall * 100).toFixed(0)}%`,
    );
  }
}

await main();
