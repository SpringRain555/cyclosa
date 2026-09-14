/**
 * 測試的沙箱住在 repo 自己的 `tmp/vitest/`，不住使用者的 Temp。
 *
 * ## 為什麼
 *
 * 25 個測試檔用 `mkdtemp(join(tmpdir(), …))` 建沙箱（e2e 每一條測試都起一個 server
 * ＋ 一個資料根）。2026-09-13 在這台機器上量到：同樣五個 e2e 檔，沙箱在
 * `%LOCALAPPDATA%\Temp` 要 182 秒，搬到 D: 上的 `tmp/vitest/` 是 58 秒 ——
 * 兩顆是同型號的 NVMe，差的是 C: 上每一個新檔案都要過即時掃描。整包 933 條
 * 一起跑的時候 `beforeEach` 因此超過 10 秒的 hookTimeout，**看起來像測試壞了**。
 *
 * 所以 `vitest.config.ts` 把 `TMP`／`TEMP` 指到這裡（Node 的 `os.tmpdir()` 在 Windows
 * 上讀的就是這兩個），這一支只負責在任何 worker 起來之前把資料夾建好 ——
 * `mkdtemp` 不會替你建父層。
 *
 * 測試檔一個字都不用改，而且沙箱留在看得到的地方：某一條測試沒清乾淨，
 * `git status` 看不到（`tmp/` 在 .gitignore），但 `ls tmp/vitest` 看得到。
 */
import { mkdir } from 'node:fs/promises';

import { SANDBOX_LOCALAPPDATA, SANDBOX_ROOT } from '../vitest.config.js';

export default async function setup(): Promise<void> {
  await mkdir(SANDBOX_ROOT, { recursive: true });
  await mkdir(SANDBOX_LOCALAPPDATA, { recursive: true });
}
