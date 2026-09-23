/**
 * `spawnPiped`：子程序起不來的時候，**伺服器不能跟著死**（2026-09-23 實跑撞到的）。
 *
 * Windows 上工作目錄太長時，`spawn` 回 `ENOENT`，**同時** stdout／stderr 兩條管線各丟一個
 * `read ENOTCONN`。沒有人接那兩個錯誤的話，它們是沒接住的例外 —— 在伺服器裡就是整個行程停掉。
 * vitest 會把沒接住的例外記成這一輪失敗，所以「這一條是綠的」本身就是證明。
 */
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClaudeAgent } from '../../src/infrastructure/providers/agent-claude.js';
import {
  cwdTooLong,
  spawnPiped,
  WINDOWS_CWD_LIMIT,
} from '../../src/infrastructure/providers/spawn-piped.js';

let base = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'cyclosa-spawn-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 一個真的存在、而且比上限長的資料夾。 */
async function longDir(length: number): Promise<string> {
  let dir = base;
  let i = 0;
  while (dir.length < length) dir = join(dir, `seg${String(i++).padStart(3, '0')}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe('工作目錄的長度', () => {
  it('只有 Windows 有這個上限', () => {
    const long = 'C:\\' + 'x'.repeat(WINDOWS_CWD_LIMIT);
    expect(cwdTooLong(long, 'win32')).toBe(true);
    expect(cwdTooLong('C:\\short', 'win32')).toBe(false);
    expect(cwdTooLong(long, 'linux')).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('子程序起不來（Windows）', () => {
  it('工作目錄太長：子程序失敗，**管線的錯誤不會變成沒接住的例外**', async () => {
    const dir = await longDir(290);
    const outcome = await new Promise<string>((resolve) => {
      const child = spawnPiped(process.execPath, ['-e', '1'], { cwd: dir, shell: false });
      child.on('error', (e) => resolve(`error ${String((e as NodeJS.ErrnoException).code)}`));
      child.on('close', (code) => resolve(`close ${String(code)}`));
    });
    expect(outcome).toBe('error ENOENT');
    // 管線的錯誤是在下一輪事件迴圈才丟出來的 —— 給它時間浮上來（沒人接的話這一輪就紅了）。
    await new Promise((r) => setTimeout(r, 300));
  });

  it('Claude Code 那一支：直接回 `IO_PATH_TOO_LONG`，**連 spawn 都不做**（不是「沒設定」）', async () => {
    const marker = join(base, 'ran.txt');
    const script = join(base, 'would-run.mjs');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');`,
      'utf8',
    );
    const agent = createClaudeAgent({
      command: process.execPath,
      args: [script],
      model: '',
      schema: {},
      systemPrompt: '',
      maxCostUsd: null,
    });
    const dir = await longDir(WINDOWS_CWD_LIMIT + 10);
    const call = await agent.run({ prompt: 'x', cwd: dir, timeoutMs: 5000 });
    expect(call.kind).toBe('error');
    if (call.kind !== 'error') return;
    expect(call.code).toBe('IO_PATH_TOO_LONG');
    await expect(access(marker)).rejects.toThrow();
  });
});
