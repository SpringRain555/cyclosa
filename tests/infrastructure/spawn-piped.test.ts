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
      const child = spawnPiped(process.execPath, ['-e', '1'], { cwd: dir });
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

/**
 * **`.cmd`／`.bat` 不經過 `cmd.exe`**（2026-10-02）。那一條路上，提示詞（含專題文件的段落）
 * 會被原樣接成一個字串交給 `cmd.exe` —— 文件裡的 `&` 就是一個指令。
 * 所以那兩種副檔名直接說不支援，**連 spawn 都不做**：下面那支 `.cmd` 一被執行就會留下記號。
 */
describe('CLI 指令是 .cmd／.bat：不經過 cmd.exe', () => {
  async function wrapper(ext: 'cmd' | 'bat'): Promise<{ command: string; marker: string }> {
    const marker = join(base, `ran-${ext}.txt`);
    const command = join(base, `would-run.${ext}`);
    await writeFile(command, `@echo x > "${marker}"\r\n`, 'utf8');
    return { command, marker };
  }

  it.each(['cmd', 'bat'] as const)('.%s：探針說不支援、要改用原生安裝', async (ext) => {
    const { command, marker } = await wrapper(ext);
    const agent = createClaudeAgent({
      command,
      args: [],
      model: '',
      schema: {},
      systemPrompt: '',
      maxCostUsd: null,
    });
    const probe = await agent.probe();
    expect(probe.kind).toBe('unreachable');
    if (probe.kind !== 'unreachable') return;
    expect(probe.detail).toContain('claude.exe');
    await expect(access(marker)).rejects.toThrow();
  });

  it.each(['cmd', 'bat'] as const)(
    '.%s：執行回 PROVIDER_NOT_CONFIGURED，提示詞裡的 & 碰不到 cmd.exe',
    async (ext) => {
      const { command, marker } = await wrapper(ext);
      const agent = createClaudeAgent({
        command,
        args: [],
        model: '',
        schema: {},
        systemPrompt: '',
        maxCostUsd: null,
      });
      const call = await agent.run({ prompt: 'x" & echo pwned & "', cwd: base, timeoutMs: 5000 });
      expect(call.kind).toBe('error');
      if (call.kind !== 'error') return;
      expect(call.code).toBe('PROVIDER_NOT_CONFIGURED');
      expect(call.detail).toContain('claude.exe');
      await expect(access(marker)).rejects.toThrow();
    },
  );
});
