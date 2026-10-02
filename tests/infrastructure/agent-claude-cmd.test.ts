/**
 * 缺口評估「不給工具」：`--tools` 後面那個**空字串**真的送到 CLI（r1-4）。
 *
 * 原本這條測的是 `.cmd` 包裝經過 `cmd.exe` 時空字串會不會消失；2026-10-02 起子程序一律不經過 shell
 * （`.cmd`／`.bat` 直接說不支援，`spawn-piped.test.ts`），所以改成直接起一支假的 CLI 看它收到什麼。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createClaudeAgent } from '../../src/infrastructure/providers/agent-claude.js';

it('不給工具：--tools 後面是一個空字串，沒有 WebSearch', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'claude-notools-'));
  try {
    const script = join(folder, 'fake.cjs');
    await writeFile(
      script,
      `const fs = require('node:fs'); fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({ type: 'result', result: 'ok' }));`,
      'utf8',
    );
    const agent = createClaudeAgent({
      command: process.execPath,
      args: [script],
      model: 'fixture',
      systemPrompt: 'fixture',
      schema: {},
      maxCostUsd: null,
      tools: 'none',
    });
    const result = await agent.run({ prompt: 'fixture', cwd: folder, timeoutMs: 5000 });
    expect(result.kind, JSON.stringify(result)).toBe('ok');
    const args = JSON.parse(await readFile(join(folder, 'argv.json'), 'utf8')) as string[];
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--tools') + 2]).toBe('--json-schema');
    expect(args).not.toContain('WebSearch');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
