/**
 * agent 子程序的沙箱：先建好、事後一定掃（ADR-0006 第 4／5 條）。
 *
 * ## 為什麼「先建好」要單獨寫成一支
 *
 * 子程序的工作目錄不存在的話，`spawn` 直接失敗 —— 而 Claude Code 那一支把 spawn 的錯誤
 * 報成 `PROVIDER_NOT_CONFIGURED`（「沒設定」），**畫面上看起來是設定壞了**。
 * Stage 19 的規劃對話就是這樣：工作目錄從來沒建過，走 Claude Code 的每一輪都會失敗，
 * 而驗收時用的是本機 Ollama（它不看工作目錄），所以沒有被看見（2026-09-23 補）。
 *
 * ## 為什麼成功失敗都要掃
 *
 * 真正執行「agent 不自己抓」的是 `--tools WebSearch` 與只給 `web_search` 一個工具；
 * 沙箱是備援。一個「抓了一堆東西然後才失敗」的子程序正是最該被查到的那一種，
 * 所以掃描不看呼叫成不成功（`expand-service.ts` 的同一條規則）。
 */
import { mkdir, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { sandboxViolations } from '../domain/provider/index.js';

/** 建好沙箱（已經在就什麼都不做）。 */
export async function prepareSandbox(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** 沙箱裡違規的檔案（相對路徑）。**空陣列 ＝ 乾淨**；讀不到資料夾也當乾淨（它本來就可能是空的）。 */
export async function scanSandbox(dir: string): Promise<readonly string[]> {
  let files: readonly string[];
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    files = entries.filter((e) => e.isFile()).map((e) => relative(dir, join(e.parentPath, e.name)));
  } catch {
    files = [];
  }
  return sandboxViolations(files);
}
