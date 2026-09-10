/**
 * 端對端：**設定頁那張「各任務模型」的表。**
 *
 * ## 為什麼是 e2e 而不是單元測試
 *
 * 這張表要回答的是「**每一件事實際會跑哪一個模型**」，而那個答案跨了三層：
 * 設定檔（`providers.json`）→ registry（逐任務挑模型並各自探一次）→
 * application（逐任務配對能力）。**中間任何一層漏接，症狀都是
 * 「覆寫設了沒有生效」**，而那在畫面上完全看不出來 ——
 * 它會安靜地用預設模型跑。
 *
 * 2026-09-10 這一輪就實際發生過一次同型的事：server 把 `chatReadiness`
 * 改名成 `taskReadiness`，**而全部 762 個測試照樣全過** ——
 * 因為沒有任何一條測試讀過那個欄位，而 `web/` 是另一份型別宣告。
 *
 * ## 完全隔離
 *
 * `LOCALAPPDATA` 指到臨時目錄，所以讀到的是一份**不存在的** `providers.json`
 * —— 那正是「還沒設定任何模型」這個要驗的狀態。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { MODEL_TASKS } from '../../src/domain/provider/index.js';

let sandbox: string;
let localAppData: string;
let app: FastifyInstance;
let savedLocalAppData: string | undefined;

interface TaskRow {
  task: string;
  role: string;
  model: string;
  overridden: boolean;
  ok: boolean;
  missing: string[];
}

async function tasks(): Promise<TaskRow[]> {
  const res = await app.inject({ method: 'GET', url: '/api/providers' });
  const body = res.json() as { ok: boolean; data: { taskReadiness: TaskRow[] } };
  expect(body.ok).toBe(true);
  return body.data.taskReadiness;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-tasks-'));
  localAppData = join(sandbox, 'LocalAppData');
  await mkdir(join(localAppData, 'Cyclosa'), { recursive: true });
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = localAppData;

  const built = await buildServer();
  app = built.app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

describe('各任務模型那張表', () => {
  it('四個任務全部都在，而且順序與角色跟 server 那份定義一致', async () => {
    const rows = await tasks();
    // **少一列使用者就找不到那件事的模型欄位**，而畫面上不會有任何提示。
    expect(rows.map((r) => r.task)).toEqual(MODEL_TASKS.map((t) => t.task));
    expect(rows.map((r) => r.role)).toEqual(MODEL_TASKS.map((t) => t.role));
  });

  it('什麼都沒設定的時候，不會宣稱任何一個模型「缺」什麼', async () => {
    const rows = await tasks();
    for (const row of rows) {
      expect(row.ok, row.task).toBe(false);
      /**
       * **這一條守的是一句話的正確性，不是一個布林。**
       *
       * 畫面上那句是「這個角色要跑的任務需要 X，**而目前設定的模型沒有**」。
       * 一個完全沒設定的角色能力宣告當然全空，所以配對一定回「缺 X」——
       * 而那句話對它是錯的：問題不是模型不夠好，是還沒選。
       */
      expect(row.missing, row.task).toEqual([]);
      expect(row.model, row.task).toBe('');
      expect(row.overridden, row.task).toBe(false);
    }
  });

  it('逐任務覆寫會反映在「實際會跑」那一欄，沒覆寫的跟著預設', async () => {
    // Ollama 連不連得上不影響這一條 —— 它問的是**挑模型那一步挑對了沒有**，
    // 而那一步在探測之前就決定了。
    await writeFile(
      join(localAppData, 'Cyclosa', 'providers.json'),
      JSON.stringify({
        version: 1,
        chat: {
          baseUrl: 'http://127.0.0.1:59999',
          model: '預設模型',
          apiKeyEnv: null,
          taskModels: { angles: '覆寫的模型', extract: '' },
        },
        agent: { command: 'claude', args: [], model: 'sonnet' },
        embed: { baseUrl: 'http://127.0.0.1:59999', model: '嵌入模型' },
      }),
      'utf8',
    );

    const byTask = new Map((await tasks()).map((r) => [r.task, r]));

    expect(byTask.get('angles')?.model).toBe('覆寫的模型');
    expect(byTask.get('angles')?.overridden).toBe(true);

    // **空字串是「跟著預設」，不是「沒有模型」** —— 兩者在畫面上要分得開。
    expect(byTask.get('extract')?.model).toBe('預設模型');
    expect(byTask.get('extract')?.overridden).toBe(false);

    // agent 的模型走 CLI 的 `--model`，形狀跟 chat 那兩個完全不同，
    // 而表格上它要跟其餘三列長得一樣。
    expect(byTask.get('find-sources')?.model).toBe('sonnet');
    expect(byTask.get('embed')?.model).toBe('嵌入模型');
  });

  it('角色層那一格是它底下所有任務的合併，不是自己算一次', async () => {
    await writeFile(
      join(localAppData, 'Cyclosa', 'providers.json'),
      JSON.stringify({
        version: 1,
        chat: {
          baseUrl: 'http://127.0.0.1:59999',
          model: '預設模型',
          apiKeyEnv: null,
          taskModels: { angles: '覆寫的模型', extract: '' },
        },
        agent: null,
        embed: null,
      }),
      'utf8',
    );

    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    const body = res.json() as {
      data: {
        readiness: { role: string; ok: boolean }[];
        taskReadiness: TaskRow[];
      };
    };
    const chatRole = body.data.readiness.find((r) => r.role === 'chat');
    const chatTasks = body.data.taskReadiness.filter((r) => r.role === 'chat');

    // 位址是通不了的，所以兩個任務都不 ok，而角色層也必須不 ok。
    // **它不能自己拿預設模型的能力算** —— 那樣一個覆寫成小模型的抽取
    // 會顯示成綠的，而設定頁上那個欄位裡寫的是預設模型的名字。
    expect(chatTasks.every((r) => !r.ok)).toBe(true);
    expect(chatRole?.ok).toBe(false);
  });
});
