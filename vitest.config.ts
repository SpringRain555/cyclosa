import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 測試的沙箱根。**指到 repo 自己的 `tmp/`，不是使用者的 Temp** ——
 * 理由與量測數字在 `tests/global-setup.ts`（它負責把這個資料夾建好）。
 */
export const SANDBOX_ROOT = fileURLToPath(new URL('./tmp/vitest/', import.meta.url));

/**
 * 測試行程看到的 `%LOCALAPPDATA%`。**整個測試行程都不給真的那一個** ——
 * 指標檔（`%LOCALAPPDATA%\Cyclosa\system_paths.json`）是從它推導的。
 *
 * e2e 測試各自把 `LOCALAPPDATA` 換成自己的沙箱、`afterEach` 再換回來，但「換回來」
 * 換回的原本是真的值。2026-09-13 一條 e2e 測試逾時，`afterEach` 照跑，而還沒回應的
 * 「設定資料根」請求在那之後才寫指標檔 —— 寫的是**真的**指標檔，指著那條測試的沙箱。
 * 現在換回來的是這個資料夾，晚到的寫入也落在 `tmp/vitest/` 裡
 * （`tests/guards/test-isolation.test.ts` 守著）。
 */
export const SANDBOX_LOCALAPPDATA = fileURLToPath(
  new URL('./tmp/vitest/LocalAppData/', import.meta.url),
);

/**
 * **GitHub Actions 上的時間上限放寬到 60 秒，本機照舊。**
 *
 * GitHub 的 Windows runner 只有 4 核，e2e 慢兩到四倍：每條測試的 `beforeEach` 都要起一個 server，
 * 第一次啟動還會走真的匯入管線建範例專題。2026-10-09 第一次跑 CI，「hook 超過 10 秒」約 250 次，
 * 接著清理時刪不掉還開著的 `case.sqlite`（`EBUSY`），一路連帶失敗了 21 個檔 —— 本機同一份 clone 全綠。
 * **本機不放寬**：開發機上變慢是要被看見的訊號，不該被一個為了 CI 調大的上限吃掉。
 */
const ON_CI = process.env['GITHUB_ACTIONS'] === 'true';

/**
 * 測試。**與 vite 同一套 pipeline**，所以版本要跟著走
 * （`docs/environment/versions.md` 的「三組要一起升」第一組）。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 守門測試會掃整棵原始碼樹，比純函式測試慢一點
    testTimeout: ON_CI ? 60_000 : 20_000,
    // 預設 10 秒；e2e 的 beforeEach 在 CI 上撐不過（見上面的 ON_CI）
    hookTimeout: ON_CI ? 60_000 : 10_000,
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
      // 指標檔從這個推導 —— 理由在上面的 SANDBOX_LOCALAPPDATA。
      LOCALAPPDATA: SANDBOX_LOCALAPPDATA,
    },
  },
});
