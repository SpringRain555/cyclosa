/**
 * 一支假的 `claude` CLI，給研究的兩份端對端測試用（規劃對話走 Claude Code、找候選來源）。
 *
 * ## 它只是一支 node 腳本
 *
 * `providers.json` 的 `cli.command` 設成 `process.execPath`、`args` 是這支腳本的路徑 ——
 * `args` 那個欄位存在的理由就是這種包裝（`expansion-flow.test.ts` 的同一個做法）。
 * **子程序真的被 spawn、stream-json 真的被逐行解析、沙箱真的被掃**，假的只有模型本身。
 *
 * ## 行為由環境變數決定
 *
 * 那是唯一一個「測試設定得到、子程序讀得到」的管道（子程序繼承 `process.env`）。
 *
 * | 變數 | 意思 |
 * |---|---|
 * | `CYCLOSA_FAKE_CLAUDE_MODE` | `ok`（預設）、`fail`、`sandbox`（往工作目錄寫一個檔 ＝ 違規）、`slow` |
 * | `CYCLOSA_FAKE_CLAUDE_SLOW_KEY` | 提示詞裡有這一段字的那一次**等 60 秒**（等著被取消）—— 其餘照常 |
 * | `CYCLOSA_FAKE_CLAUDE_CANDIDATES` | `{ "提示詞裡的一段字": [候選, …] }` —— 找得到哪一段就回哪一份 |
 * | `CYCLOSA_FAKE_CLAUDE_PLAN` | 規劃對話要回的那一份規劃（JSON）；**有設就回它，不回候選** |
 * | `CYCLOSA_FAKE_CLAUDE_LOG` | 每一次呼叫附加一行 `{cwd, prompt}` 到這個檔（**沙箱外面**）|
 * | `CYCLOSA_FAKE_CLAUDE_COST` | 回報的 `total_cost_usd`（預設 0.05）|
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FAKE_CLAUDE_SCRIPT = `
import { appendFile, writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('9.9.9-fake\\n');
  process.exit(0);
}

const prompt = argv[argv.indexOf('-p') + 1] ?? '';
const log = process.env['CYCLOSA_FAKE_CLAUDE_LOG'];
if (log) await appendFile(log, JSON.stringify({ cwd: process.cwd(), prompt, argv }) + '\\n', 'utf8');

const mode = process.env['CYCLOSA_FAKE_CLAUDE_MODE'] ?? 'ok';
// **這是違規的那一種**：agent 自己把一份網頁存進沙箱。
if (mode === 'sandbox' || mode === 'sandbox-fail') await writeFile('grabbed.html', '<html>不該在這裡</html>', 'utf8');
const slowKey = process.env['CYCLOSA_FAKE_CLAUDE_SLOW_KEY'];
if (mode === 'slow' || (slowKey && prompt.includes(slowKey))) {
  await new Promise((r) => setTimeout(r, 60000));
}

const cost = Number(process.env['CYCLOSA_FAKE_CLAUDE_COST'] ?? '0.05');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');

if (mode === 'fail' || mode === 'sandbox-fail') {
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: cost }) + '\\n',
  );
  process.exit(0);
}

let body;
const plan = process.env['CYCLOSA_FAKE_CLAUDE_PLAN'];
if (plan) {
  body = JSON.parse(plan);
} else {
  const table = JSON.parse(process.env['CYCLOSA_FAKE_CLAUDE_CANDIDATES'] ?? '{}');
  const key = Object.keys(table).find((k) => prompt.includes(k));
  body = { candidates: key === undefined ? [] : table[key] };
}
process.stdout.write(
  JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: cost, result: JSON.stringify(body) }) + '\\n',
);
`;

export const FAKE_CLAUDE_ENV = [
  'CYCLOSA_FAKE_CLAUDE_MODE',
  'CYCLOSA_FAKE_CLAUDE_SLOW_KEY',
  'CYCLOSA_FAKE_CLAUDE_CANDIDATES',
  'CYCLOSA_FAKE_CLAUDE_PLAN',
  'CYCLOSA_FAKE_CLAUDE_LOG',
  'CYCLOSA_FAKE_CLAUDE_COST',
] as const;

/** 把假的 CLI 寫進沙箱，回傳腳本的路徑（`cli.args` 用它）。 */
export async function writeFakeClaude(dir: string): Promise<string> {
  const path = join(dir, 'fake-claude.mjs');
  await writeFile(path, FAKE_CLAUDE_SCRIPT, 'utf8');
  return path;
}

/** 測試結束時把環境變數清乾淨 —— 下一條測試不該繼承上一條的模式。 */
export function clearFakeClaudeEnv(): void {
  for (const name of FAKE_CLAUDE_ENV) delete process.env[name];
}
