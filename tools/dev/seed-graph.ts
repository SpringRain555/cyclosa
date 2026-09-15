/**
 * 把 `graph-fixture.ts` 的合成圖寫進一個**空的**專題，給人工驗收用。
 *
 * ```
 * npx tsx tools/dev/seed-graph.ts --data-root <一個臨時資料夾> --slug <專題>
 * ```
 *
 * ## 為什麼需要它
 *
 * v0.3.0 交付關聯圖，但 **v0.2.0 的匯入不產生任何關聯** ——
 * 真實資料在這一階段畫出來是一團沒有線的點，四種畫法一種都看不到。
 * 要親眼確認「漸細」「等寬 ＋ 方塊」「點線」「摺起來」長得不一樣，
 * 就需要一份確實有那四種東西的資料。
 *
 * ## 三道防線
 *
 * 1. **兩個參數都必須明確給**，沒有預設值 —— 不會因為少打一個字就寫到別的地方
 * 2. **專題裡只要已經有一列 `item` 就拒絕** —— 它只往空專題寫
 * 3. 寫進去的每一列標題都以「合成」開頭，**看得出來是編的**
 *
 * ⚠️ 這是開發工具。**產品程式碼不 import 它**，一鍵啟動也不會碰到它。
 */
import { join } from 'node:path';

import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { writeSyntheticGraph } from './graph-fixture.js';

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
    console.error('用法：npx tsx tools/dev/seed-graph.ts --data-root <資料根> --slug <專題>');
    console.error('兩個參數都必須明確給 —— 這支會寫入資料庫，不設預設值。');
    return 2;
  }

  const dbPath = join(dataRoot, 'cases', slug, 'case.sqlite');
  const opened = await openCaseDatabase(dbPath);
  if (opened.kind !== 'ok') {
    console.error(`打不開專題資料庫（${opened.kind}）：${dbPath}`);
    return 1;
  }

  try {
    const existing = opened.db.prepare('SELECT COUNT(*) AS n FROM item').get() as
      { n?: unknown } | undefined;
    if (Number(existing?.n ?? 0) > 0) {
      console.error('這個專題已經有資料了，拒絕寫入合成資料。請開一個新的空專題。');
      return 1;
    }

    writeSyntheticGraph(opened.db);
    console.log(`已寫入合成的關聯圖：${slug}`);
    console.log('內容：9 個資料節點、3 個實體、四層關聯各至少一條、投影三段各一個實例。');
  } finally {
    opened.db.close();
  }
  return 0;
}

process.exitCode = await main();
