/**
 * 寫入超過一頁的合成單一出處關聯，供 D11 人工驗收分頁與關聯面板。
 *
 * ```
 * npx tsx tools/dev/seed-single-evidence-list.ts --data-root <資料根> --slug <空專題>
 * ```
 *
 * 只往空專題寫 6 份合成 Markdown，每份 19 條關聯，共 114 條。
 * 每條引文都由 `applyExtraction` 在該份正文裡定位，沒有模型呼叫。
 *
 * ⚠️ 開發工具。資料只寫在明確指定的專題；不要對含有資料或研究的專題執行。
 */
import { join } from 'node:path';

import { applyExtraction } from '../../src/application/extraction-service.js';
import { ingestBytes } from '../../src/application/ingest-service.js';
import { normalizeExtraction } from '../../src/domain/provider/index.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import * as items from '../../src/infrastructure/db/repositories/item-repo.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import { readDerived } from '../../src/infrastructure/fs/case-files.js';
import { newId } from '../../src/shared/id.js';

const BATCH_COUNT = 6;
const RELATIONS_PER_BATCH = 19;
const SUBJECT = '合成單一出處主體';

interface SyntheticBatch {
  readonly itemId: string;
  readonly requestedUrl: string;
  readonly title: string;
  readonly body: string;
  readonly entities: readonly { readonly name: string; readonly type: 'concept' }[];
  readonly relations: readonly {
    readonly subject: string;
    readonly rel: string;
    readonly object: string;
    readonly quote: string;
  }[];
}

function batches(): SyntheticBatch[] {
  return Array.from({ length: BATCH_COUNT }, (_, batchIndex) => {
    const first = batchIndex * RELATIONS_PER_BATCH + 1;
    const relations = Array.from({ length: RELATIONS_PER_BATCH }, (_, offset) => {
      const ordinal = String(first + offset).padStart(3, '0');
      const object = `合成單一出處目標 ${ordinal}`;
      const quote = `合成來源引文 ${ordinal} 支持這個主張。`;
      return { subject: SUBJECT, rel: '支持', object, quote };
    });
    return {
      itemId: newId(),
      requestedUrl: `https://synthetic.example/single-evidence-list/${String(batchIndex + 1)}`,
      title: `合成單一出處來源 ${String(batchIndex + 1).padStart(2, '0')}`,
      body: `# 合成單一出處來源\n\n${relations.map((relation) => relation.quote).join('\n\n')}`,
      entities: [
        { name: SUBJECT, type: 'concept' },
        ...relations.map((relation) => ({ name: relation.object, type: 'concept' as const })),
      ],
      relations,
    };
  });
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

async function main(): Promise<number> {
  const dataRoot = arg('data-root');
  const slug = arg('slug');
  if (dataRoot === null || slug === null) {
    console.error(
      '用法：npx tsx tools/dev/seed-single-evidence-list.ts --data-root <資料根> --slug <空專題>',
    );
    console.error('兩個參數都必須明確給 —— 這支只往空專題寫合成資料。');
    return 2;
  }

  const folder = join(dataRoot, 'cases', slug);
  const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
  if (opened.kind !== 'ok') {
    console.error(`打不開專題資料庫（${opened.kind}）：${folder}`);
    return 1;
  }

  const db = opened.db;
  try {
    const count = (sql: string): number =>
      Number((db.prepare(sql).get() as { n?: unknown } | undefined)?.n ?? 0);
    if (
      count('SELECT COUNT(*) AS n FROM item') > 0 ||
      count('SELECT COUNT(*) AS n FROM research') > 0 ||
      count('SELECT COUNT(*) AS n FROM entity') > 0 ||
      count('SELECT COUNT(*) AS n FROM edge') > 0 ||
      count('SELECT COUNT(*) AS n FROM run') > 0
    ) {
      console.error('這個專題已經有資料或研究了，拒絕寫入合成資料。請開一個新的空專題。');
      return 1;
    }

    const allBatches = batches();
    const importRunId = newId();
    const importNow = Date.now();
    runs.insertRun(db, {
      id: importRunId,
      kind: 'import',
      label: '合成單一出處來源 · 6 份',
      total: allBatches.length,
      correlationId: 'synthetic-single-evidence',
      now: importNow,
    });
    runs.startRun(db, importRunId, importNow);

    for (const [index, batch] of allBatches.entries()) {
      const runItemId = newId();
      items.insertPendingItem(db, {
        id: batch.itemId,
        kind: 'text',
        requestedUrl: batch.requestedUrl,
        title: batch.title,
        runId: importRunId,
        now: importNow,
      });
      runs.insertRunItem(db, {
        id: runItemId,
        runId: importRunId,
        requested: batch.requestedUrl,
        host: 'synthetic.example',
      });
      const result = await ingestBytes(db, folder, {
        runItemId,
        itemId: batch.itemId,
        requestedUrl: batch.requestedUrl,
        finalUrl: batch.requestedUrl,
        bytes: new TextEncoder().encode(batch.body),
        contentType: 'text/markdown',
        fileName: `synthetic-single-evidence-${String(index + 1).padStart(2, '0')}.md`,
        hops: [],
        providers: null,
      });
      if (result.itemId === null) throw new Error(`合成資料匯入失敗：${batch.title}`);
      runs.updateRunItem(db, {
        id: runItemId,
        outcome: 'ok',
        code: null,
        itemId: result.itemId,
        now: Date.now(),
      });
    }
    runs.settleRunRow(db, {
      id: importRunId,
      status: 'done',
      succeeded: allBatches.length,
      failed: 0,
      now: Date.now(),
    });

    const extractRunId = newId();
    const extractNow = Date.now();
    runs.insertRun(db, {
      id: extractRunId,
      kind: 'extract',
      label: '合成單一出處抽取',
      total: allBatches.length,
      correlationId: 'synthetic-single-evidence',
      now: extractNow,
      providers: JSON.stringify({
        chat: 'manual:single-evidence-fixture',
        json: { extract: 'manual' },
      }),
    });
    runs.startRun(db, extractRunId, extractNow);

    let namedRelations = 0;
    for (const batch of allBatches) {
      const runItemId = newId();
      runs.insertRunItem(db, {
        id: runItemId,
        runId: extractRunId,
        requested: batch.title,
        host: null,
        itemId: batch.itemId,
      });
      const extraction = normalizeExtraction({
        entities: batch.entities,
        relations: batch.relations,
      });
      if (
        extraction.entities.length !== batch.entities.length ||
        extraction.relations.length !== batch.relations.length
      ) {
        throw new Error(`合成清單超過目前抽取上限：${batch.title}`);
      }
      const derived = await readDerived(folder, batch.itemId);
      if (derived === null) throw new Error(`合成正文讀取失敗：${batch.title}`);
      const result = applyExtraction(db, batch.itemId, extractRunId, derived.text, extraction);
      if (result.code !== null) throw new Error(`合成引文無法定位：${batch.title}`);
      if (result.newEdges !== extraction.entities.length + extraction.relations.length) {
        throw new Error(`合成關聯數不符：${batch.title}`);
      }
      namedRelations += extraction.relations.length;
      runs.updateRunItem(db, {
        id: runItemId,
        outcome: 'ok',
        code: null,
        itemId: batch.itemId,
        now: Date.now(),
      });
      runs.setRunItemEdges(db, runItemId, result.newEdges);
    }
    runs.settleRunRow(db, {
      id: extractRunId,
      status: 'done',
      succeeded: allBatches.length,
      failed: 0,
      now: Date.now(),
    });
    console.log(
      `已寫入合成單一出處清單：${slug}（${namedRelations} 條具名關聯，每條都有可定位的引文）。`,
    );
    return 0;
  } finally {
    db.close();
  }
}

process.exitCode = await main();
