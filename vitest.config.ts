import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 測試的沙箱根。**指到 repo 自己的 `tmp/`，不是使用者的 Temp** ——
 * 理由與量測數字在 `tests/global-setup.ts`（它負責把這個資料夾建好）。
 */
export const SANDBOX_ROOT = fileURLToPath(new URL('./tmp/vitest/', import.meta.url));

/**
 * 測試。**與 vite 同一套 pipeline**，所以版本要跟著走
 * （`docs/environment/versions.md` 的「三組要一起升」第一組）。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 守門測試會掃整棵原始碼樹，比純函式測試慢一點
    testTimeout: 20_000,
    globalSetup: ['tests/global-setup.ts'],
    env: {
      // e2e 測試刻意製造失敗（指標檔壞掉之類），app 的 warn 會塞滿輸出。
      // 而 **PowerShell 5.1 把原生指令的 stderr 當成錯誤**，
      // 所以那些日誌還會讓 Verify.ps1 誤判成失敗。
      CYCLOSA_LOG_LEVEL: 'silent',
      // 節流間隔一律用預設值：開發機上設了這個變數的話，e2e 的間隔量測與整包的時間都會跟著變。
      CYCLOSA_FETCH_INTERVAL_MS: '',
      // `os.tmpdir()` 在 Windows 上讀這兩個。沙箱一律進 repo 的 tmp/vitest/。
      TMP: SANDBOX_ROOT,
      TEMP: SANDBOX_ROOT,
    },
  },
});
