/**
 * provider 設定檔的讀寫。
 *
 * **這一份是 2026-09-09 補 `embed` 那一格時才建的，而在那之前這個檔案沒有測試。**
 * 補的當下就踩到它要守的東西：`embed` 是新欄位，
 * 所以**每一份既有的 `providers.json` 都缺它** —— 而缺欄位的處理方式
 * 決定了升級之後那一格是「有位址、等你選模型」還是「整格空的」。
 */
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHAT_TASKS } from '../../src/domain/provider/index.js';
import {
  DEFAULT_CONFIG,
  RECOMMENDED_CHAT_MODEL,
  RECOMMENDED_TASK_MODELS,
  apiKeyEnvOf,
  chatModelFor,
  emptyTaskModels,
  providersFilePath,
  readProvidersConfig,
  writeProvidersConfig,
} from '../../src/infrastructure/providers/config.js';

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cyclosa-cfg-'));
  env = { ...process.env, LOCALAPPDATA: root };
  await mkdir(dirname(providersFilePath(env)), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('嵌入模型那一格', () => {
  it('沒有設定檔 → 位址有預設、模型是空的', async () => {
    const config = await readProvidersConfig(env);
    expect(config.embed?.baseUrl).toBe('http://127.0.0.1:11434');
    expect(config.embed?.model).toBe('');
  });

  it('**舊的設定檔沒有 embed 欄位，要退回預設而不是 null**', async () => {
    await writeFile(
      providersFilePath(env),
      JSON.stringify({
        version: 1,
        chat: { baseUrl: 'http://127.0.0.1:11434', model: 'gemma4:31b', apiKeyEnv: null },
        agent: { command: 'claude', args: [] },
      }),
      'utf8',
    );
    const config = await readProvidersConfig(env);
    // null 的話設定頁上那一格連位址都是空的，使用者要自己打一次 —— 而那個值是猜得準的。
    expect(config.embed).not.toBeNull();
    expect(config.embed?.baseUrl).toBe('http://127.0.0.1:11434');
    expect(config.chat?.model).toBe('gemma4:31b');
  });

  it('存了之後讀回來是同一個', async () => {
    await writeProvidersConfig(
      {
        ...DEFAULT_CONFIG,
        embed: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-embedding:4b' },
      },
      env,
    );
    const config = await readProvidersConfig(env);
    expect(config.embed?.model).toBe('qwen3-embedding:4b');
  });

  it('壞掉的 JSON → 整份退回預設，不丟例外', async () => {
    await writeFile(providersFilePath(env), '{ 這不是 JSON', 'utf8');
    const config = await readProvidersConfig(env);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('**設定檔裡不會有 apiKeyEnv 這一欄** —— 嵌入只接本機端點', async () => {
    await writeProvidersConfig(
      { ...DEFAULT_CONFIG, embed: { baseUrl: 'http://127.0.0.1:11434', model: 'bge-m3' } },
      env,
    );
    const raw = JSON.parse(await readFile(providersFilePath(env), 'utf8')) as {
      embed: Record<string, unknown>;
    };
    expect(Object.keys(raw.embed).sort()).toEqual(['baseUrl', 'model']);
  });
});

/**
 * 逐任務覆寫（2026-09-10）。
 *
 * **跟 `embed` 那一格是同一種形狀的升級**：新欄位，而每一份既有的
 * `providers.json` 都缺它。差別是這一次「缺」有一個看不見的失敗模式 ——
 * 缺鍵讀成 `undefined` 的話，`chat.taskModels[task]` 會在每一次擴展時炸掉，
 * 而那是在使用者按下擴展之後才發生的。
 */
describe('chat 的逐任務覆寫', () => {
  it('沒有設定檔 → 每個任務的鍵都在，值是空字串', async () => {
    const config = await readProvidersConfig(env);
    expect(Object.keys(config.chat?.taskModels ?? {}).sort()).toEqual([...CHAT_TASKS].sort());
    for (const task of CHAT_TASKS) expect(config.chat?.taskModels[task]).toBe('');
  });

  it('**舊的設定檔沒有 taskModels，要當成全部沒覆寫**', async () => {
    await writeFile(
      providersFilePath(env),
      JSON.stringify({
        version: 1,
        chat: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', apiKeyEnv: null },
        agent: null,
      }),
      'utf8',
    );
    const config = await readProvidersConfig(env);
    expect(config.chat?.taskModels).toEqual(emptyTaskModels());
    // **而每個任務仍然解析得出一個模型** —— 沒覆寫就是跟著預設。
    for (const task of CHAT_TASKS) expect(chatModelFor(config.chat, task)).toBe('qwen3.5:4b');
  });

  it('存了之後讀回來是同一個', async () => {
    await writeProvidersConfig(
      {
        ...DEFAULT_CONFIG,
        chat: {
          baseUrl: 'http://127.0.0.1:11434',
          model: 'qwen3.5:4b',
          apiKeyEnv: null,
          taskModels: { ...emptyTaskModels(), angles: 'granite4.2:8b' },
        },
      },
      env,
    );
    const config = await readProvidersConfig(env);
    expect(chatModelFor(config.chat, 'angles')).toBe('granite4.2:8b');
    // **沒覆寫的那一個不受影響。** 覆寫一個任務不該把另一個也帶走。
    expect(chatModelFor(config.chat, 'extract')).toBe('qwen3.5:4b');
  });

  /**
   * **不認得的鍵在讀的時候就丟掉。**
   *
   * 留著的話它會一直在設定檔裡，而下一次讀出來仍然沒有作用 ——
   * 一個拼錯的任務名看起來像是設過了。
   */
  it('不認得的任務名一律丟掉', async () => {
    await writeFile(
      providersFilePath(env),
      JSON.stringify({
        version: 1,
        chat: {
          baseUrl: 'http://127.0.0.1:11434',
          model: 'qwen3.5:4b',
          taskModels: { angles: 'granite4.2:8b', anlges: '打錯的那個' },
        },
      }),
      'utf8',
    );
    const config = await readProvidersConfig(env);
    expect(Object.keys(config.chat?.taskModels ?? {}).sort()).toEqual([...CHAT_TASKS].sort());
    expect(chatModelFor(config.chat, 'angles')).toBe('granite4.2:8b');
  });

  it('**沒有預設模型時，覆寫自己撐得起那個任務**', () => {
    const chat = {
      baseUrl: 'http://127.0.0.1:11434',
      model: '',
      apiKeyEnv: null,
      taskModels: { ...emptyTaskModels(), extract: 'qwen3.5:4b' },
    };
    expect(chatModelFor(chat, 'extract')).toBe('qwen3.5:4b');
    // 而另一個任務仍然是「沒有模型」——**不是** 悄悄借用隔壁那一個。
    expect(chatModelFor(chat, 'angles')).toBe('');
    expect(chatModelFor(null, 'angles')).toBe('');
  });

  /**
   * **建議值要每個任務都有一個。**
   *
   * 少一個的話，設定頁上那一格的「建議」按鈕會是 `undefined` ——
   * 而按下去會把那個任務設成字串 `"undefined"`，那是一個永遠找不到的模型名。
   */
  it('每個任務都有一個建議值，而抽取那一個就是全域的建議值', () => {
    expect(Object.keys(RECOMMENDED_TASK_MODELS).sort()).toEqual([...CHAT_TASKS].sort());
    for (const task of CHAT_TASKS) expect(RECOMMENDED_TASK_MODELS[task].length).toBeGreaterThan(0);
    // **預設模型要能單獨把兩件事都跑完** —— 覆寫是可選的加分，不是必要條件。
    // 這兩個一旦分岔，「不設覆寫」就變成一個沒有被量測支持的設定。
    expect(RECOMMENDED_TASK_MODELS.extract).toBe(RECOMMENDED_CHAT_MODEL);
  });
});

describe('金鑰欄位存的是名字不是金鑰', () => {
  it('像環境變數名的通過', () => {
    expect(apiKeyEnvOf('OPENAI_API_KEY')).toBe('OPENAI_API_KEY');
  });

  it('**像金鑰的一律不通過** —— 它有小寫、有連字號，而且很長', () => {
    expect(apiKeyEnvOf('sk-proj-abc123def456')).toBeNull();
    expect(apiKeyEnvOf('   ')).toBeNull();
    expect(apiKeyEnvOf(42)).toBeNull();
  });
});
