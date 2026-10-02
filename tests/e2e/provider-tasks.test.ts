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
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { MODEL_TASKS } from '../../src/domain/provider/index.js';

let sandbox: string;
let localAppData: string;
let app: FastifyInstance;
let savedLocalAppData: string | undefined;

/** v2（ADR-0032）：每一列各自說走哪一條連線、用哪個模型、跑不跑得動。 */
interface TaskRow {
  task: string;
  role: string;
  via: string;
  model: string;
  state: string;
  ok: boolean;
  missing: string[];
}

async function tasks(): Promise<TaskRow[]> {
  const res = await app.inject({ method: 'GET', url: '/api/providers' });
  const body = res.json() as { ok: boolean; data: { tasks: TaskRow[] } };
  expect(body.ok).toBe(true);
  return body.data.tasks;
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
  it('舊擴展、選角度與刪草稿的 HTTP 入口都已退場', async () => {
    for (const route of [
      { method: 'POST' as const, url: '/api/cases/test/runs' },
      { method: 'POST' as const, url: '/api/cases/test/runs/test/angles' },
      { method: 'DELETE' as const, url: '/api/cases/test/runs/test' },
    ]) {
      expect((await app.inject(route)).statusCode).toBe(404);
    }
  });
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
      expect(row.state, row.task).toBe('not-configured');
    }
  });

  it('v1 的逐任務覆寫升版之後反映在每一列的模型，沒覆寫的跟著預設', async () => {
    // Ollama 連不連得上不影響這一條 —— 它問的是**挑模型那一步挑對了沒有**，
    // 而那一步在探測之前就決定了。寫的是 v1 的檔案：讀到就原地升版。
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

    expect(byTask.has('angles')).toBe(false);

    // v1 的空字串是「跟著預設」—— 升版之後每一列都寫實際會跑的那一個。
    expect(byTask.get('extract')?.model).toBe('預設模型');
    expect(byTask.get('extract')?.via).toBe('ollama');

    // agent 的模型走 CLI 的 `--model`，形狀跟 chat 那兩個完全不同，
    // 而表格上它要跟其餘三列長得一樣。
    expect(byTask.get('find-sources')?.model).toBe('sonnet');
    expect(byTask.get('find-sources')?.via).toBe('cli');
    expect(byTask.get('embed')?.model).toBe('嵌入模型');
    expect(byTask.get('embed')?.via).toBe('ollama');
  });

  /**
   * **v2 的形狀：兩個對話任務各接一條連線。** 這是 2026-09-18 使用者要的那一格
   * （歸納留在本機、抽取走線上），v1 明寫不准。
   */
  it('v2：初讀走 Ollama、抽取走 OpenAI 相容端點，各自帶自己的連線', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        version: 2,
        connections: {
          cli: null,
          ollama: { baseUrl: 'http://127.0.0.1:59999', apiKeyEnv: null },
          openai: { baseUrl: 'http://127.0.0.1:59998/v1', apiKeyEnv: null },
        },
        tasks: {
          'find-sources': { via: 'cli', model: '' },
          digest: { via: 'ollama', model: '本機模型' },
          extract: { via: 'openai', model: '線上模型' },
          embed: { via: 'ollama', model: '' },
        },
        diagnostics: { logModelCalls: false },
      },
    });
    const body = res.json() as { ok: boolean; data: { tasks: TaskRow[] } };
    expect(body.ok).toBe(true);
    const byTask = new Map(body.data.tasks.map((r) => [r.task, r]));
    expect(byTask.get('digest')).toMatchObject({ via: 'ollama', model: '本機模型' });
    expect(byTask.get('extract')).toMatchObject({ via: 'openai', model: '線上模型' });
    // 兩條連線都通不了，所以兩列都不 ok —— 而且各自說自己連不上，不是替對方說。
    expect(byTask.get('digest')?.state).toBe('unreachable');
    expect(byTask.get('extract')?.state).toBe('unreachable');
    // 存進去的檔案是 v2。
    const file = JSON.parse(
      await readFile(join(localAppData, 'Cyclosa', 'providers.json'), 'utf8'),
    ) as { version: number; tasks: Record<string, { via: string }> };
    expect(file.version).toBe(2);
    expect(file.tasks['extract']?.via).toBe('openai');
  });

  /**
   * **「連線並列出模型」不存檔就列。** 填了位址按下去就要有清單（或說列不出來），
   * 不用先按儲存 —— 存了才列的話畫面上會先出現一個空的下拉選單。
   */
  it('POST /api/providers/connections/:kind/models 不動設定檔', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/connections/ollama/models',
      payload: { baseUrl: 'http://127.0.0.1:59999' },
    });
    const body = res.json() as { ok: boolean; data: { kind: string; models: string[] | null } };
    expect(body.ok).toBe(true);
    expect(body.data.kind).toBe('ollama');
    // 通不了 → null（不是空陣列：「列不出來」與「一個都沒有」是兩件事）。
    expect(body.data.models).toBeNull();
    await expect(
      readFile(join(localAppData, 'Cyclosa', 'providers.json'), 'utf8'),
    ).rejects.toThrow();

    const bad = await app.inject({
      method: 'POST',
      url: '/api/providers/connections/cli/models',
      payload: { baseUrl: 'x' },
    });
    expect((bad.json() as { ok: boolean }).ok).toBe(false);
  });

  it('每一列各自對著自己的模型算，沒有任何「角色層」替它們代答', async () => {
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

    const rows = await tasks();
    const chatTasks = rows.filter((r) => r.role === 'chat' && r.task !== 'digest');

    // 位址是通不了的，所以兩個任務都不 ok、都說連不上。
    // **它不能拿別列的能力算** —— 那樣一個覆寫成小模型的抽取
    // 會顯示成綠的，而設定頁上那個欄位裡寫的是預設模型的名字。
    expect(chatTasks.map((entry) => entry.task)).toEqual(['extract']);
    expect(chatTasks.every((r) => !r.ok && r.state === 'unreachable')).toBe(true);

    // **初讀是 v0.25.0 才有的，v1 的檔案升上來它是「還沒設定」** —— 不從 chat 那一格抄：
    // 抽取可能走會花錢的端點，而初讀每一份候選都讀（`upgradeV1` 的註解）。
    const digest = rows.find((r) => r.task === 'digest');
    expect(digest?.state).toBe('not-configured');
  });

  /**
   * **規劃對話走的是它自己那一條服務**（ADR-0033 D5）。
   *
   * 它跟找候選來源同一個角色（`agent`），而 registry 有兩支：`agentFor` 問的是找來源那一條。
   * 2026-09-20 第一版的「儲存並測試」對規劃對話叫的就是 `agentFor` ——
   * 於是那一列測的是另一個任務的設定，**而畫面上會寫「可以用」**。
   * 那是最糟的一種錯：它說的是另一件事的結果。
   */
  it('規劃對話：狀態與測試都對著它自己那一條服務，不是找來源那一條', async () => {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        version: 2,
        connections: {
          cli: null,
          ollama: { baseUrl: 'http://127.0.0.1:59999', apiKeyEnv: null },
          openai: null,
        },
        tasks: {
          // 規劃對話走本機 Ollama（三個服務都可以，ADR-0033 D5），找來源留在沒設定的 CLI。
          plan: { via: 'ollama', model: '規劃用的模型' },
          'find-sources': { via: 'cli', model: '' },
          angles: { via: 'ollama', model: '本機模型' },
          extract: { via: 'ollama', model: '本機模型' },
          embed: { via: 'ollama', model: '' },
        },
        diagnostics: { logModelCalls: false },
      },
    });
    expect(saved.statusCode).toBe(200);

    const byTask = new Map((await tasks()).map((r) => [r.task, r]));
    // 走 Ollama（位址通不了），**不是** CLI 的「還沒設定」。
    expect(byTask.get('plan')).toMatchObject({
      via: 'ollama',
      model: '規劃用的模型',
      state: 'unreachable',
    });
    expect(byTask.get('find-sources')?.state).toBe('not-configured');

    // 「儲存並測試」那一顆：規劃對話要打到它自己那條（連不上），
    // 而不是回 CLI 那條的「還沒設定」。
    const tested = await app.inject({
      method: 'POST',
      url: '/api/providers/test',
      payload: { task: 'plan' },
    });
    const body = tested.json() as { ok: boolean; code?: string; data?: { ok: boolean } };
    if (body.ok) expect(body.data?.ok).toBe(false);
    else expect(body.code).not.toBe('PROVIDER_NOT_CONFIGURED');
  });
});
