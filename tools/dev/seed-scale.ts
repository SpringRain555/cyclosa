/**
 * 把規模合成資料寫進一個**空的**專題（Stage 13 的規模驗收）。
 *
 * ```
 * npx tsx tools/dev/seed-scale.ts --data-root <臨時資料夾> --slug <專題>
 * npx tsx tools/dev/seed-scale.ts --data-root <臨時資料夾> --slug <專題> --prune-chunks 3
 * ```
 *
 * ## 為什麼要另外一支，不用 `seed-graph.ts`
 *
 * 那一支寫的是 9 個節點的示範圖，**目的是看得完**。
 * 這一支寫的是 5 萬節點，**目的是量得到六項效能預算**（roadmap「Stage 13 的效能預算」）。
 * 兩者的取捨完全相反，合成一支會讓兩邊都不好用。
 *
 * ## 三道防線（與 `seed-graph.ts` 相同，理由也相同）
 *
 * 1. **兩個參數都必須明確給**，沒有預設值 —— 不會因為少打一個字就寫到別的地方
 * 2. **專題裡只要已經有一列 `item` 就拒絕** —— 它只往空專題寫
 * 3. 每一列的標題都以「合成」開頭，**看得出來是編的**（release-checklist A5）
 *
 * ## `--prune-chunks`
 *
 * 刪掉 `ord ≥ N` 的向量。存在的理由是 ADR-0026 留下的那個問題：
 * 每份文件 6 段是**從 5 萬條線性外推**到 35 萬條算出來的，
 * 而 5 萬到 35 萬之間有沒有別的東西變成瓶頸沒有量過。
 * 一次寫滿、逐段刪下來重量，就得到「每份幾段 → 幾條向量 → 幾毫秒」那條**真的**曲線，
 * 而且每一點都是同一支 `semanticCandidates` 掃同一張真的表。
 *
 * ⚠️ 開發工具。**產品程式碼不 import 它**，一鍵啟動也碰不到。
 */
import { join } from 'node:path';

import { createCase } from '../../src/application/case-service.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { casesDir } from '../../src/infrastructure/fs/paths.js';
import { writeScaleFixture } from './scale-fixture.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

function num(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<number> {
  const dataRoot = arg('data-root');
  const slug = arg('slug');

  if (dataRoot === null || slug === null) {
    console.error('用法：npx tsx tools/dev/seed-scale.ts --data-root <資料根> --slug <專題>');
    console.error('兩個參數都必須明確給 —— 這支會寫入資料庫，不設預設值。');
    return 2;
  }

  const folder = join(casesDir(dataRoot), slug);
  const dbPath = join(folder, 'case.sqlite');

  // 專題不存在就開一個。**走的是產品那一支 `createCase`** ——
  // 自己 CREATE TABLE 的話，量的就是一個 migration 沒跑過的資料庫。
  const created = await createCase(dataRoot, { name: slug });
  if (created.ok) {
    console.log('建立了新專題：' + created.data.slug);
  } else if (created.code !== 'CASE_NAME_DUPLICATE') {
    console.error('建立專題失敗：' + created.code);
    return 1;
  }

  const opened = await openCaseDatabase(dbPath);
  if (opened.kind !== 'ok') {
    console.error('打不開專題資料庫（' + opened.kind + '）：' + dbPath);
    return 1;
  }

  try {
    const prune = arg('prune-chunks');
    if (prune !== null) {
      const keep = Number(prune);
      if (!Number.isInteger(keep) || keep < 1) {
        console.error('--prune-chunks 要一個 ≥ 1 的整數（保留 ord 0..N-1）。');
        return 2;
      }
      const before = Number(
        (opened.db.prepare('SELECT COUNT(*) AS n FROM vector').get() as { n: number }).n ?? 0,
      );
      // `id` 是 `<itemId>#<ord>`。ord 是尾巴那一段。
      opened.db
        .prepare("DELETE FROM vector WHERE CAST(substr(id, instr(id, '#') + 1) AS INTEGER) >= ?")
        .run(keep);
      const after = Number(
        (opened.db.prepare('SELECT COUNT(*) AS n FROM vector').get() as { n: number }).n ?? 0,
      );
      console.log(
        JSON.stringify({ pruneChunks: keep, vectorsBefore: before, vectorsAfter: after }),
      );
      return 0;
    }

    const existing = Number(
      (opened.db.prepare('SELECT COUNT(*) AS n FROM item').get() as { n?: unknown } | undefined)
        ?.n ?? 0,
    );
    if (existing > 0) {
      console.error('這個專題已經有 ' + existing + ' 列資料了，拒絕寫入合成資料。');
      console.error('規模資料要一個乾淨的專題 —— 混進既有資料的話量到的不是這一份的數字。');
      return 1;
    }

    const spec = {
      items: num('items', 50_000),
      entities: num('entities', 12_000),
      edges: num('edges', 200_000),
      seed: num('seed', 20260910),
      vocabSize: num('vocab', 6_000),
      maxChunks: num('max-chunks', 6),
      embedModel: arg('embed-model') ?? 'qwen3-embedding:4b',
      embedDim: num('embed-dim', 2_560),
    };

    console.log('規格：' + JSON.stringify(spec));
    console.log('（這會跑好幾分鐘，而且會佔幾 GB 磁碟。）');
    const t0 = Date.now();
    const stats = await writeScaleFixture(opened.db, folder, spec, (line) =>
      console.log('  ' + line),
    );
    console.log('');
    console.log(JSON.stringify({ ...stats, totalMs: Date.now() - t0, spec }, null, 2));
  } finally {
    opened.db.close();
  }
  return 0;
}

process.exitCode = await main();
