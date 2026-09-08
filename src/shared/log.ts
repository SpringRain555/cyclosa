/**
 * 日誌。**錯誤碼只進這裡，不進 UI**（REQ-0008）。
 *
 * 兩條規則：
 * 1. **一行一個 JSON**，因為之後要被程式讀（診斷匯出、節流間隔的驗收）。
 * 2. **不寫來源內容與筆記內容。** 診斷匯出要去識別化，
 *    而最省事的做法是一開始就不要把它們寫進日誌 ——
 *    事後過濾一份已經寫進去的日誌，永遠會漏掉一種欄位。
 */
import { appendFileSync } from 'node:fs';

import type { ErrorCode } from '../domain/errors/codes.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly correlationId?: string;
  readonly code?: ErrorCode;
  readonly caseId?: string;
  readonly runId?: string;
  readonly durationMs?: number;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/**
 * 這些欄位名一旦出現在日誌裡就是 bug —— 它們裝的是使用者蒐集來的東西。
 * **擋在寫入點，而不是在匯出時過濾。**
 */
const FORBIDDEN_FIELDS = new Set(['quote', 'content', 'text', 'body', 'note', 'title', 'snapshot']);

function sanitize(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = FORBIDDEN_FIELDS.has(k) ? '[redacted]' : v;
  }
  return out;
}

const ORDER: Readonly<Record<LogLevel | 'silent', number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 99,
};

/**
 * `CYCLOSA_LOG_LEVEL` 控制門檻，`silent` 就完全不寫。
 *
 * **測試會把它設成 `silent`**：那些測試刻意製造失敗（指標檔壞掉之類），
 * 於是 app 的 warn 會塞滿測試輸出 —— 而 **PowerShell 5.1 把原生指令的 stderr
 * 當成錯誤**（`NativeCommandError`），所以那些日誌還會讓 `Verify.ps1` 誤判成失敗。
 */
function threshold(): number {
  const raw = process.env['CYCLOSA_LOG_LEVEL'];
  if (raw !== undefined && raw in ORDER) return ORDER[raw as LogLevel | 'silent'];
  return ORDER.info;
}

/**
 * 同時寫一份到檔案（`CYCLOSA_LOG_FILE`）。
 *
 * **一鍵啟動之後 server 沒有主控台**（v0.9.1 起它跑在背景），
 * 所以 stdout 寫到哪裡都沒有人看得到。啟動器把這個變數指到
 * `%LOCALAPPDATA%\Cyclosa\logs\server.log`，讓「它自己死掉了」留得下線索。
 *
 * 三件事是刻意的：
 *
 * · **同步寫。** 要看的就是程式當掉之前的最後一行，而非同步的那一行會掉。
 *   這個工具的日誌量是一秒幾行，不是一秒幾千行。
 * · **寫不出去就靜靜放棄。** 日誌寫不了不該讓程式起不來 ——
 *   而且這裡丟例外的話，第一個受害者是「正在回報另一個錯誤」的那條路。
 * · 走的是同一個 `sanitize`。**檔案不是另一條規則比較鬆的路。**
 *
 * 每次讀一次環境變數而不是快取：跟 `threshold()` 同一個做法，
 * 這樣測試設得動它，而代價只是一次 map 查詢。
 */
function appendToFile(line: string): void {
  const path = process.env['CYCLOSA_LOG_FILE'];
  if (path === undefined || path.length === 0) return;
  try {
    appendFileSync(path, line + '\n', 'utf8');
  } catch {
    // 見上面第二點
  }
}

function write(level: LogLevel, msg: string, fields: LogFields = {}): void {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...sanitize(fields) });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
  appendToFile(line);
}

export const logger: Logger = {
  debug: (m, f) => write('debug', m, f),
  info: (m, f) => write('info', m, f),
  warn: (m, f) => write('warn', m, f),
  error: (m, f) => write('error', m, f),
};

export { FORBIDDEN_FIELDS, sanitize };
