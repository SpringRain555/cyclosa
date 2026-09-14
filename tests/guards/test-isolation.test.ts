/**
 * 守門：**測試行程從頭到尾看不到真的 `%LOCALAPPDATA%`。**
 *
 * ## 為什麼需要這一條
 *
 * 指標檔是 `%LOCALAPPDATA%\Cyclosa\system_paths.json`，而它的位置在**寫入的那一刻**
 * 才從 `process.env` 推導（`pointerFilePath()`）。e2e 測試各自把 `LOCALAPPDATA`
 * 換成沙箱、`afterEach` 再換回來 —— 只要「換回來」換回的是真的值，任何比
 * `afterEach` 晚到的寫入就會寫進使用者真正的指標檔。
 *
 * 2026-09-13 就這樣發生了：一條 e2e 測試逾時，`afterEach` 照跑，還沒回應的
 * 「設定資料根」請求在那之後才寫指標檔。真的指標檔從此指著那條測試的沙箱
 * （`%LOCALAPPDATA%\Temp\cyclosa-e2e-…\DataRoot`），而宣告的資料根一直是空的 ——
 * **下一次正式啟動，使用者的專題會建在一個會被清掉的暫存資料夾裡**。
 * 同一件事 2026-09-08 已經發生過一次（`D:\Projects` CONVENTIONS §11 記著）。
 *
 * 所以隔離不靠每一條測試記得換回來，靠 `vitest.config.ts` 讓整個測試行程的
 * `LOCALAPPDATA` 本來就在 `tmp/vitest/` 裡。
 */
import { describe, expect, it } from 'vitest';
import { isAbsolute, relative } from 'node:path';

import { pointerFilePath } from '../../src/infrastructure/fs/paths.js';
import { SANDBOX_ROOT } from '../../vitest.config.js';

function insideSandbox(p: string | undefined): boolean {
  if (!p) return false;
  const rel = relative(SANDBOX_ROOT, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

describe('測試行程的 LOCALAPPDATA', () => {
  it('在 tmp/vitest/ 底下 —— 換回來的也只會是沙箱', () => {
    expect(insideSandbox(process.env['LOCALAPPDATA']), String(process.env['LOCALAPPDATA'])).toBe(
      true,
    );
  });

  it('所以不帶參數推導出來的指標檔也在沙箱裡', () => {
    expect(insideSandbox(pointerFilePath()), pointerFilePath()).toBe(true);
  });

  it('判準認得出真的位置 —— 注入一次', () => {
    // 上面兩條對現況是綠的。餵一個沙箱外面的路徑，確認判準真的會紅。
    expect(insideSandbox('C:\\Users\\someone\\AppData\\Local')).toBe(false);
    expect(
      insideSandbox(pointerFilePath({ LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' })),
    ).toBe(false);
    expect(insideSandbox(SANDBOX_ROOT)).toBe(false);
    expect(insideSandbox(undefined)).toBe(false);
  });
});
