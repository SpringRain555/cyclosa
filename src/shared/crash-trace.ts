/**
 * 程式自己死掉的時候，留下一行（v0.24.3）。
 *
 * ## 為什麼需要
 *
 * 2026-09-19 使用者按「儲存並測試」，四個任務都測過了，伺服器卻在那之後不見了 ——
 * 畫面說連不到、重新整理是「拒絕連線」，而 `server.log` 的最後一行是啟動的那一行。
 * **它怎麼死的，一個字都沒留下。** 同一個流程在複本上跑了 16 次（冷的、熱的模型都有），一次都沒重現。
 *
 * `log.ts` 寫著日誌檔存在的理由是「讓它自己死掉了留得下線索」，而那只對**經過 logger 的**那幾行成立。
 * 真正會讓一個背景程式安靜消失的兩條路，都不經過 logger：
 *
 * | 怎麼死 | Node 做什麼 | 以前留下什麼 |
 * |---|---|---|
 * | 沒接住的例外、沒接住的 rejection | 把堆疊印到 stderr，結束碼 1 | 什麼都沒有 —— 一鍵啟動的伺服器沒有主控台 |
 * | 原生層中止（libuv 的 assert、V8 的 fatal error）| 印一行到 stderr，然後 abort | 同上 |
 *
 * 所以這裡做三件事：
 *
 * 1. **沒接住的錯誤寫進 `server.log`**（`uncaughtExceptionMonitor`）。它只看、不改 Node 的預設行為 ——
 *    程式照樣結束。沒接住的 rejection 在 Node 15 之後也走這一條（`origin` 是 `unhandledRejection`）。
 * 2. **結束碼寫一行**（`exit`）。正常關閉是 0；不是 0 而前面沒有一行說為什麼，就是有人呼叫了
 *    `process.exit` 卻沒有說。
 * 3. **V8 的 fatal error 由 Node 寫一份診斷報告**到日誌旁邊。**不含環境變數**（金鑰在那裡）、
 *    不含網路介面。只有一鍵啟動（設了 `CYCLOSA_LOG_FILE`）才開 —— 測試與前景模式不需要。
 *
 * **原生層的 assert 這三件都攔不到**：它繞過 Node 直接 abort，只在 stderr 留一行。那一半是
 * `tools/Launch.ps1` 的事 —— 它把 stderr 導到 `server.err.log`。
 */
import { dirname } from 'node:path';

import { logger } from './log.js';

/**
 * `@types/node` 還沒有 `excludeNetwork`（Node 22.13／23.5 加的）；這台機器的 Node 24.15 有，
 * 而且寫得進去（2026-09-19 實測）。型別落後於執行環境，不是這個設定不存在。
 */
export type DiagnosticReport = typeof process.report & { excludeNetwork: boolean };

/** 堆疊留幾行。**要的是「在哪裡」，不是整份** —— 這一行會跟著日誌被整份貼出來。 */
const STACK_LINES = 12;
const REASON_CHARS = 300;

/** 一個沒接住的錯誤 → 日誌那一行的欄位。丟進來的不一定是 `Error`（`throw 'x'`、`reject(undefined)`）。 */
export function describeFatal(error: unknown, origin: string): Record<string, unknown> {
  const e = error instanceof Error ? error : null;
  const stack = e?.stack ?? '';
  return {
    origin,
    name: e?.name ?? typeof error,
    reason: (e?.message ?? String(error)).slice(0, REASON_CHARS),
    // 第一行是「名字：訊息」，上面兩欄已經有了。
    stack: stack
      .split('\n')
      .slice(1, 1 + STACK_LINES)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

export function onUncaught(error: unknown, origin: string): void {
  logger.error('程式因為一個沒接住的錯誤而結束', describeFatal(error, origin));
}

/** 欄位叫 `exitCode` 不叫 `code`：日誌的 `code` 是錯誤碼（`LogFields` 的型別這樣規定）。 */
export function onExit(code: number): void {
  if (code === 0) logger.info('行程結束', { exitCode: code });
  else logger.warn('行程結束', { exitCode: code });
}

/**
 * 裝上三件事。**只在入口（`main.ts`）呼叫一次** —— 測試直接叫上面兩支，不裝到測試行程上。
 */
export function installCrashTrace(env: NodeJS.ProcessEnv = process.env): void {
  process.on('uncaughtExceptionMonitor', onUncaught);
  process.on('exit', onExit);

  const logFile = env['CYCLOSA_LOG_FILE'];
  if (logFile === undefined || logFile.length === 0) return;
  const report = process.report as DiagnosticReport;
  report.directory = dirname(logFile);
  report.excludeEnv = true;
  report.excludeNetwork = true;
  report.reportOnFatalError = true;
}
