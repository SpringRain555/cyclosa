/**
 * 把一次合成的研究寫進一個**空的**專題，停在指定的那一步 —— 給 D10 截研究的中間狀態用（B4）。
 *
 * ```
 * npx tsx tools/dev/seed-research.ts --data-root <一個臨時資料根> --slug <空專題> --state <狀態>
 * ```
 *
 * 狀態：`planning`／`collecting`／`awaiting-user`／`reviewing`／`building`／`done`／`abandoned`
 * （每一步畫面上有什麼，見 `research-fixture.ts` 的檔頭）。**一個狀態一個專題** ——
 * 同一個專題同時只有一次研究沒結束（ADR-0033 D4），而且截圖要的是互不干擾的畫面。
 *
 * ## 三道防線（跟 `seed-graph.ts` 同一套）
 *
 * 1. **三個參數都必須明確給**，沒有預設值 —— 不會因為少打一個字就寫到別的地方
 * 2. **專題裡只要已經有一列 `item` 或一次研究就拒絕** —— 它只往空專題寫
 * 3. 寫進去的主題、方向、候選、正文都以「合成」開頭，**看得出來是編的**
 *
 * `collecting` 與 `building` 的作業寫成「執行中」：伺服器下一次打開這個專題時會把它們掃成
 * 「停在半路」（`run-sweep`），畫面給「繼續蒐集」／「繼續建圖」—— 那就是要截的樣子。
 * **不要對它們按「繼續」**：繼續會真的呼叫模型。
 *
 * ⚠️ 這是開發工具。**產品程式碼不 import 它**，一鍵啟動也不會碰到它。
 */
import { join } from 'node:path';

import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { SEED_STATES, writeResearchState, type SeedState } from './research-fixture.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

async function main(): Promise<number> {
  const dataRoot = arg('data-root');
  const slug = arg('slug');
  const state = arg('state');

  if (dataRoot === null || slug === null || state === null) {
    console.error(
      '用法：npx tsx tools/dev/seed-research.ts --data-root <資料根> --slug <空專題> --state <狀態>',
    );
    console.error('三個參數都必須明確給 —— 這支會寫入資料庫，不設預設值。');
    console.error(`狀態：${SEED_STATES.join('／')}`);
    return 2;
  }
  if (!SEED_STATES.includes(state as SeedState)) {
    console.error(`認不得的狀態「${state}」。可以用：${SEED_STATES.join('／')}`);
    return 2;
  }

  const folder = join(dataRoot, 'cases', slug);
  const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
  if (opened.kind !== 'ok') {
    console.error(`打不開專題資料庫（${opened.kind}）：${folder}`);
    return 1;
  }

  try {
    const count = (sql: string): number =>
      Number((opened.db.prepare(sql).get() as { n?: unknown } | undefined)?.n ?? 0);
    if (
      count('SELECT COUNT(*) AS n FROM item') > 0 ||
      count('SELECT COUNT(*) AS n FROM research') > 0
    ) {
      console.error('這個專題已經有資料或研究了，拒絕寫入合成資料。請開一個新的空專題。');
      return 1;
    }
    const summary = await writeResearchState(opened.db, folder, state as SeedState);
    console.log(`已寫入合成的研究：${slug}（停在 ${summary.state}）`);
    console.log(
      `內容：${summary.candidates} 列候選、${summary.items} 份資料、建圖寫進 ${summary.edges} 條關聯。`,
    );
  } finally {
    opened.db.close();
  }
  return 0;
}

process.exitCode = await main();
