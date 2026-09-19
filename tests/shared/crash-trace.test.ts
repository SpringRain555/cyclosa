/**
 * 程式自己死掉的時候留下一行（`shared/crash-trace.ts`，v0.24.3）。
 *
 * 2026-09-19 伺服器在一次「儲存並測試」之後消失，`server.log` 一個字都沒有 ——
 * 沒接住的錯誤不經過 logger。這一份測兩件事：那幾行真的寫得進日誌檔，
 * 以及**這個設計依賴的 Node 行為真的成立**（沒接住的 rejection 也會觸發 `uncaughtExceptionMonitor`）。
 * 後者是 Node 的事，但整個設計靠它 —— 一句沒量過的「Node 會這樣做」不能當前提。
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  describeFatal,
  installCrashTrace,
  onExit,
  onUncaught,
  type DiagnosticReport,
} from '../../src/shared/crash-trace.js';

let sandbox = '';
let logFile = '';
let savedLevel: string | undefined;
let savedFile: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-crash-'));
  logFile = join(sandbox, 'server.log');
  savedLevel = process.env['CYCLOSA_LOG_LEVEL'];
  savedFile = process.env['CYCLOSA_LOG_FILE'];
  // 全域設定是 silent（vitest.config.ts）—— 這一份要真的寫出東西才測得到。
  process.env['CYCLOSA_LOG_LEVEL'] = 'info';
  process.env['CYCLOSA_LOG_FILE'] = logFile;
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedLevel === undefined) delete process.env['CYCLOSA_LOG_LEVEL'];
  else process.env['CYCLOSA_LOG_LEVEL'] = savedLevel;
  if (savedFile === undefined) delete process.env['CYCLOSA_LOG_FILE'];
  else process.env['CYCLOSA_LOG_FILE'] = savedFile;
  await rm(sandbox, { recursive: true, force: true });
});

async function lines(): Promise<Record<string, unknown>[]> {
  const text = await readFile(logFile, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('describeFatal', () => {
  it('Error：名字、訊息、堆疊（不含第一行、去掉縮排、最多 12 行）', () => {
    const e = new Error('boom');
    e.stack = [
      'Error: boom',
      ...Array.from({ length: 20 }, (_, i) => `    at f${i} (x.js:${i})`),
    ].join('\n');
    const d = describeFatal(e, 'uncaughtException');
    expect(d['origin']).toBe('uncaughtException');
    expect(d['name']).toBe('Error');
    expect(d['reason']).toBe('boom');
    expect(d['stack']).toHaveLength(12);
    expect((d['stack'] as string[])[0]).toBe('at f0 (x.js:0)');
  });

  it('丟進來的不是 Error 也說得出是什麼', () => {
    expect(describeFatal('x', 'unhandledRejection')).toMatchObject({ name: 'string', reason: 'x' });
    expect(describeFatal(undefined, 'unhandledRejection')).toMatchObject({
      name: 'undefined',
      reason: 'undefined',
      stack: [],
    });
  });

  it('很長的訊息截在 300 字', () => {
    const d = describeFatal(new Error('a'.repeat(1000)), 'uncaughtException');
    expect((d['reason'] as string).length).toBe(300);
  });
});

describe('寫進日誌檔', () => {
  it('沒接住的錯誤 → 一行 error，帶著 origin 與原因', async () => {
    onUncaught(new TypeError('cannot read x'), 'unhandledRejection');
    const [line] = await lines();
    expect(line?.['level']).toBe('error');
    expect(line?.['msg']).toBe('程式因為一個沒接住的錯誤而結束');
    expect(line?.['origin']).toBe('unhandledRejection');
    expect(line?.['name']).toBe('TypeError');
    expect(line?.['reason']).toBe('cannot read x');
  });

  it('結束碼：0 是 info，其餘是 warn', async () => {
    onExit(0);
    onExit(1);
    const got = (await lines()).map((l) => [l['level'], l['exitCode']]);
    expect(got).toEqual([
      ['info', 0],
      ['warn', 1],
    ]);
  });
});

describe('installCrashTrace', () => {
  it('設了 CYCLOSA_LOG_FILE：診斷報告寫到日誌旁邊，而且不含環境變數與網路介面', () => {
    const report = process.report as DiagnosticReport;
    const saved = {
      directory: report.directory,
      excludeEnv: report.excludeEnv,
      excludeNetwork: report.excludeNetwork,
      reportOnFatalError: report.reportOnFatalError,
    };
    const before = {
      uncaught: process.listeners('uncaughtExceptionMonitor').length,
      exit: process.listeners('exit').length,
    };
    try {
      installCrashTrace({ CYCLOSA_LOG_FILE: logFile });
      expect(report.directory).toBe(sandbox);
      // **金鑰在環境變數裡** —— 報告要是帶著環境變數，一次當掉就把金鑰寫進檔案。
      expect(report.excludeEnv).toBe(true);
      expect(report.excludeNetwork).toBe(true);
      expect(report.reportOnFatalError).toBe(true);
      expect(process.listeners('uncaughtExceptionMonitor')).toContain(onUncaught);
      expect(process.listeners('exit')).toContain(onExit);
    } finally {
      process.removeListener('uncaughtExceptionMonitor', onUncaught);
      process.removeListener('exit', onExit);
      Object.assign(report, saved);
    }
    expect(process.listeners('uncaughtExceptionMonitor').length).toBe(before.uncaught);
    expect(process.listeners('exit').length).toBe(before.exit);
  });
});

/**
 * **這個設計靠的 Node 行為，對著真的 Node 跑一次。** 一支子程序掛上同一種監聽、
 * 丟一個沒人接的 rejection：監聽要被叫到（origin 是 unhandledRejection），而程式照樣以碼 1 結束
 * —— 監聽不改變「沒接住就結束」這件事，那正是我們要的。
 */
describe('Node 本身的行為', () => {
  it('沒接住的 rejection 也會觸發 uncaughtExceptionMonitor，而且程式照樣結束', () => {
    const out = join(sandbox, 'seen.txt');
    const script = [
      "const fs = require('node:fs');",
      "process.on('uncaughtExceptionMonitor', (e, origin) => fs.appendFileSync(process.env.OUT, origin + ':' + e.message));",
      "process.on('exit', (code) => fs.appendFileSync(process.env.OUT, ';exit=' + code));",
      "Promise.reject(new Error('nobody-caught-me'));",
    ].join('\n');
    const r = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, OUT: out },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    return readFile(out, 'utf8').then((seen) => {
      expect(seen).toBe('unhandledRejection:nobody-caught-me;exit=1');
    });
  });
});
