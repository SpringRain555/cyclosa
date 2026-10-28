/**
 * 設定頁「儲存並測試」失敗時，帶回服務自己回的那一句（2026-10-28 試用回饋 1）。
 *
 * 試用時規劃的模型名稱不對，CLI 回了一句很清楚的「There's an issue with the selected model…」，
 * 而畫面只寫「超出預算」。子程序真的被 spawn、stream-json 真的被解析 —— 假的只有 CLI 本身。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testProvider } from '../../src/application/provider-service.js';

const MODEL_MISSING =
  "There's an issue with the selected model (no-such-model-cyclosa-probe). It may not exist or you may not have access to it. Run --model to pick a different model.";

let sandbox: string;
let saved: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-provider-detail-'));
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'LocalAppData');
  const dir = join(sandbox, 'LocalAppData', 'Cyclosa');
  await mkdir(dir, { recursive: true });

  // 一支假的 CLI：`--version` 回版本，其餘回真樣本形狀的失敗（subtype 是 success、is_error 是 true）。
  const script = join(sandbox, 'fake-claude.mjs');
  await writeFile(
    script,
    [
      "if (process.argv.includes('--version')) { process.stdout.write('9.9.9-fake\\n'); process.exit(0); }",
      `process.stdout.write(JSON.stringify(${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 404,
        result: MODEL_MISSING,
        total_cost_usd: 0,
      })}) + '\\n');`,
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(dir, 'providers.json'),
    JSON.stringify({
      version: 2,
      connections: {
        cli: { command: process.execPath, args: [script] },
        ollama: { baseUrl: 'http://127.0.0.1:59999', apiKeyEnv: null },
        openai: null,
      },
      tasks: {
        plan: { via: 'cli', model: 'no-such-model-cyclosa-probe' },
        'find-sources': { via: 'cli', model: '' },
        digest: { via: 'ollama', model: '' },
        extract: { via: 'ollama', model: '' },
        embed: { via: 'ollama', model: '' },
      },
      diagnostics: { logModelCalls: false },
    }),
    'utf8',
  );
});

afterEach(async () => {
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

it('模型名稱不對：測試失敗、碼是請求被拒，而且帶著 CLI 那一句', async () => {
  const tested = await testProvider(join(sandbox, 'DataRoot'), 'plan');
  expect(tested.ok, JSON.stringify(tested)).toBe(true);
  if (!tested.ok) return;
  expect(tested.data).toMatchObject({
    task: 'plan',
    ok: false,
    code: 'PROVIDER_REQUEST_REJECTED',
    detail: MODEL_MISSING,
  });
});
