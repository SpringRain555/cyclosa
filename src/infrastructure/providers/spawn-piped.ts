/**
 * spawn 一個子程序、stdout／stderr 走管線 —— **兩條管線的錯誤一律接住**。
 *
 * ## 為什麼要有這一支（2026-09-23 實跑撞到的）
 *
 * 在 Windows 上，子程序的工作目錄**超過 258 字元**時，`spawn` 回一個 `ENOENT`（看起來像
 * 「找不到指令」，其實是目錄太長），**同時** stdout 與 stderr 兩條管線的 socket 各丟一個
 * `read ENOTCONN`。後者是那兩個 socket 上的 `error` 事件，而**沒有人掛監聽** ——
 * 於是它變成一個沒接住的例外，**整個伺服器停掉**，畫面上的分頁從此連不到伺服器。
 *
 * 蒐集那一段的沙箱原本在 `agent\research\<研究>\collect\<作業>\<第幾條>\`，放在一個夠深的
 * 資料根底下剛好超過那個長度（沙箱已經改短，見 `research-collect.ts`）。
 * 不存在的工作目錄、不存在的指令**不會**觸發管線的錯誤（同一天驗過）—— 只有太長的會。
 *
 * **子程序起不來是那一次呼叫的失敗，不該是伺服器的死因。** `error` 事件本身（`ENOENT`）由
 * 呼叫端處理成一個錯誤碼；這一支只保證那兩條管線不會把整個行程帶走。
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

/**
 * Windows 上工作目錄的上限（Win32 的目錄路徑上限，`MAX_PATH − 12`）。
 *
 * 2026-09-23 實測 `CreateProcess` 在 259 字元開始失敗；取 248 是那個有文件的邊界，
 * 比實測保守 10 個字元 —— 寧可早一點說「路徑太長」，也不要在邊界上時好時壞。
 */
export const WINDOWS_CWD_LIMIT = 248;

/** 這個工作目錄在這台機器上 spawn 得起來嗎（只有 Windows 有這個限制）。 */
export function cwdTooLong(cwd: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && cwd.length >= WINDOWS_CWD_LIMIT;
}

/**
 * **永遠不經過 `cmd.exe`**（2026-10-02）。`shell: true` 時 Node 把命令與參數**原樣接成一個字串**
 * 交給 `cmd.exe`（DEP0190）—— 參數裡有提示詞，提示詞裡有專題文件的段落（可能來自抓回來的網頁），
 * 那裡面的 `&`、`|`、`"` 會被當成指令。所以這一支不收 `shell` 參數，呼叫端想開也開不了
 * （`tests/guards/no-shell-spawn.test.ts` 守著整棵 `src/`）。
 */
export function spawnPiped(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string } = {},
): ChildProcessByStdio<null, Readable, Readable> {
  const child = spawn(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  // 接住就好：子程序起不來的那一種失敗由 `child.on('error')` 回報（呼叫端處理），
  // 這裡的錯誤是同一件事的另一個症狀，再報一次只是噪音。
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  return child;
}
