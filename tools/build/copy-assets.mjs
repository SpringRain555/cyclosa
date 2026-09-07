/**
 * 把 `src/` 底下非 TypeScript 的執行期資產複製到 `dist/`。
 *
 * **為什麼需要這一步**：`tsc` 只處理 `.ts`。migration 是 `.sql` 檔，
 * 而 `dist/main.js` 執行時要讀得到它們 —— 少了這一步，
 * **build 出來的東西在第一次開資料庫時才會炸**，而錯誤訊息是「找不到檔案」，
 * 看不出真正的原因是建置漏了一種副檔名。
 *
 * 刻意保留 `.sql` 而不是把 SQL 內嵌進 `.ts`：
 * schema 是這個專案最需要被人讀的東西之一，而它在 `.sql` 檔裡才有語法高亮，
 * 也才 diff 得清楚。
 */
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** [來源, 目的]，兩者都相對於 repo 根。 */
const ASSETS = [['src/infrastructure/db/migrations', 'dist/infrastructure/db/migrations']];

for (const [from, to] of ASSETS) {
  const dest = join(root, to);
  await mkdir(dirname(dest), { recursive: true });
  await cp(join(root, from), dest, { recursive: true });
  console.log(`  copy  ${from} -> ${to}`);
}
