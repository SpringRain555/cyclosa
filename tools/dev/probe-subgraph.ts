/**
 * 一次子圖查詢的時間**花在哪一段**。
 *
 * ```
 * npx tsx tools/dev/probe-subgraph.ts --data-root <資料根> --slug <專題> --focus itm-43286
 * ```
 *
 * ## 為什麼不是加在 `graph-service.ts` 裡
 *
 * 那樣要在產品程式碼裡永久留一組計時器，而它們**平常一次都不會被讀**。
 * 這一支是拆解用的：`measure-scale.ts` 回答「多久」，這一支回答「哪一段」。
 * 兩個問題的答案壽命不一樣 —— 前者要進報告，後者用完就知道了。
 *
 * ⚠️ 開發工具。**產品程式碼不 import 它。**
 */
import { join } from 'node:path';

import { DEFAULT_PROJECTION_THRESHOLDS } from '../../src/domain/graph/projection.js';
import { normalizeFilters, RENDER_LIMIT } from '../../src/domain/graph/subgraph.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import * as graph from '../../src/infrastructure/db/repositories/graph-repo.js';
import { loadItems } from '../../src/infrastructure/db/repositories/item-repo.js';
import { casesDir } from '../../src/infrastructure/fs/paths.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

function stamp(label: string, from: number): number {
  const now = performance.now();
  console.log(
    '  ' + label.padEnd(28) + String(Math.round((now - from) * 100) / 100).padStart(9) + ' ms',
  );
  return now;
}

async function main(): Promise<number> {
  const dataRoot = arg('data-root');
  const slug = arg('slug');
  const focus = arg('focus');
  if (dataRoot === null || slug === null || focus === null) {
    console.error('用法：--data-root <資料根> --slug <專題> --focus <節點 id>');
    return 2;
  }

  const opened = await openCaseDatabase(join(casesDir(dataRoot), slug, 'case.sqlite'));
  if (opened.kind !== 'ok') {
    console.error('打不開：' + opened.kind);
    return 1;
  }
  const db = opened.db;
  const filters = normalizeFilters({});

  try {
    for (const round of [1, 2, 3]) {
      console.log('第 ' + round + ' 輪（focus=' + focus + '）');
      let t = performance.now();

      const traversal = graph.traverse(
        db,
        focus,
        2,
        filters,
        DEFAULT_PROJECTION_THRESHOLDS,
        RENDER_LIMIT,
      );
      t = stamp('traverse（' + traversal.visible.size + ' 個節點）', t);

      const realEdges = graph.loadEdgesAmong(db, traversal.visible, filters);
      t = stamp('loadEdgesAmong（' + realEdges.length + ' 條）', t);

      const ids = [...traversal.visible];
      const items = loadItems(db, ids);
      t = stamp('loadItems（' + items.length + ' 筆）', t);

      const entityIds = ids.filter((id) => traversal.expandedEntities.has(id) || id === focus);
      const itemIds = new Set(items.map((i) => i.id));
      const entities = graph.loadEntities(
        db,
        entityIds.filter((id) => !itemIds.has(id)),
      );
      t = stamp('loadEntities（' + entities.length + ' 個）', t);

      graph.mentionCounts(
        db,
        entities.map((e) => e.id),
      );
      t = stamp('mentionCounts', t);

      graph.evidenceOf(
        db,
        realEdges.map((e) => e.id),
      );
      t = stamp('evidenceOf', t);

      graph.derivedGroups(db, [...traversal.visible]);
      stamp('derivedGroups', t);
      console.log('');
    }
  } finally {
    db.close();
  }
  return 0;
}

process.exitCode = await main();
