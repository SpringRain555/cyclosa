/**
 * provider 設定檔的讀寫。
 *
 * **這一份是 2026-09-09 補 `embed` 那一格時才建的，而在那之前這個檔案沒有測試。**
 * 補的當下就踩到它要守的東西：`embed` 是新欄位，所以**每一份既有的 `providers.json`
 * 都缺它** —— 而缺欄位的處理方式決定了升級之後那一格是「有位址、等你選模型」
 * 還是「整格空的」。
 *
 * **v0.24.0 換成 v2（任務 → 連線 ＋ 模型，ADR-0032）之後，同一種問題放大成整份檔案**：
 * 每一份既有的 `providers.json` 都是 v1。這裡守的是升版的每一格 ——
 * 升錯一格的症狀是「使用者設過的東西不見了」，而畫面上那一格看起來只是還沒設。
 */
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHAT_TASKS, MODEL_TASKS } from '../../src/domain/provider/index.js';
import {
  DEFAULT_CONFIG,
  OLLAMA_DEFAULT_URL,
  RECOMMENDED_CHAT_MODEL,
  RECOMMENDED_TASK_MODELS,
  apiKeyEnvOf,
  httpConnectionFor,
  parseConfig,
  providersFilePath,
  readProvidersConfig,
  upgradeV1,
  viaOptionsOf,
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

describe('預設值', () => {
  it('沒有檔案 ＝ 一個任務都沒選模型，而 Ollama 的位址有預設', async () => {
    const config = await readProvidersConfig(env);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.connections.ollama.baseUrl).toBe(OLLAMA_DEFAULT_URL);
    for (const { task } of MODEL_TASKS) expect(config.tasks[task].model).toBe('');
  });

  it('壞掉的檔案退回預設值，不報錯', async () => {
    await writeFile(providersFilePath(env), '{not json', 'utf8');
    expect(await readProvidersConfig(env)).toEqual(DEFAULT_CONFIG);
  });

  it('每個任務都有一格，鍵跟 MODEL_TASKS 一樣', () => {
    expect(Object.keys(DEFAULT_CONFIG.tasks).sort()).toEqual(MODEL_TASKS.map((t) => t.task).sort());
  });
});

/**
 * v1 → v2。**每一格都要對得上**，而且是「使用者設過的東西一個都不能不見」。
 */
describe('v1 的設定檔原地升版', () => {
  it('三個角色都設了：連線各歸各的，任務指到對的連線與模型', () => {
    const config = upgradeV1({
      version: 1,
      chat: {
        transport: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3.5:4b',
        apiKeyEnv: null,
        taskModels: { angles: 'granite4.2:8b', extract: '' },
      },
      agent: { command: 'claude', args: [], model: 'sonnet' },
      embed: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-embedding:4b' },
      diagnostics: { logModelCalls: true },
    });
    expect(config.version).toBe(2);
    expect(config.connections.cli).toEqual({ command: 'claude', args: [] });
    expect(config.connections.ollama).toEqual({
      baseUrl: 'http://127.0.0.1:11434',
      apiKeyEnv: null,
    });
    expect(config.connections.openai).toBeNull();
    // 覆寫優先；沒覆寫的跟著預設模型 —— 這正是 v1 的語意。
    expect(config.tasks.angles).toEqual({ via: 'ollama', model: 'granite4.2:8b' });
    expect(config.tasks.extract).toEqual({ via: 'ollama', model: 'qwen3.5:4b' });
    expect(config.tasks['find-sources']).toEqual({ via: 'cli', model: 'sonnet' });
    expect(config.tasks.embed).toEqual({ via: 'ollama', model: 'qwen3-embedding:4b' });
    expect(config.diagnostics.logModelCalls).toBe(true);
  });

  it('chat 走 OpenAI 相容端點：位址與金鑰變數搬到 openai 連線，Ollama 用 embed 的位址', () => {
    const config = upgradeV1({
      version: 1,
      chat: {
        transport: 'openai',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-x',
        apiKeyEnv: 'OPENAI_API_KEY_V1',
        taskModels: { angles: '', extract: '' },
      },
      agent: null,
      embed: { baseUrl: 'http://127.0.0.1:11435', model: 'bge-m3' },
    });
    expect(config.connections.openai).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY_V1',
    });
    expect(config.connections.ollama).toEqual({
      baseUrl: 'http://127.0.0.1:11435',
      apiKeyEnv: null,
    });
    expect(config.connections.cli).toBeNull();
    expect(config.tasks.angles).toEqual({ via: 'openai', model: 'gpt-x' });
    expect(config.tasks.extract).toEqual({ via: 'openai', model: 'gpt-x' });
    expect(config.tasks.embed).toEqual({ via: 'ollama', model: 'bge-m3' });
  });

  it('最舊的形狀：沒有 transport、沒有 taskModels、沒有 embed、沒有 agent.model', () => {
    // v0.10.x 之前的檔案。缺的欄位一律當「還沒設」，不是壞掉。
    const config = upgradeV1({
      version: 1,
      chat: { baseUrl: 'http://127.0.0.1:11434', model: 'gemma4:31b' },
      agent: { command: 'claude', args: [] },
    });
    expect(config.tasks.angles).toEqual({ via: 'ollama', model: 'gemma4:31b' });
    expect(config.tasks.extract).toEqual({ via: 'ollama', model: 'gemma4:31b' });
    // **空字串與 undefined 在這裡差很多**：前者讓 `--model` 整個不帶，
    // 後者會被 `String()` 變成 'undefined' 送給 CLI。
    expect(config.tasks['find-sources'].model).toBe('');
    expect(config.tasks.embed).toEqual({ via: 'ollama', model: '' });
    expect(config.connections.ollama.baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('`args` 與 `model` 是兩件事，不會互相蓋掉', () => {
    // `args` 是包裝用的前綴（`npx claude`、`wsl claude`），`model` 是我們自己那一組旗標裡的一個。
    const config = upgradeV1({
      version: 1,
      agent: { command: 'npx', args: ['claude'], model: 'opus' },
    });
    expect(config.connections.cli).toEqual({ command: 'npx', args: ['claude'] });
    expect(config.tasks['find-sources'].model).toBe('opus');
  });

  it('讀檔會自動升版：寫一份 v1 進去，讀出來是 v2', async () => {
    await writeFile(
      providersFilePath(env),
      JSON.stringify({
        version: 1,
        chat: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b' },
      }),
      'utf8',
    );
    const config = await readProvidersConfig(env);
    expect(config.version).toBe(2);
    expect(config.tasks.extract.model).toBe('qwen3.5:4b');
  });
});

describe('v2 的形狀', () => {
  it('寫進去再讀出來是同一份', async () => {
    const written = {
      ...DEFAULT_CONFIG,
      connections: {
        cli: { command: 'claude', args: [] },
        ollama: { baseUrl: OLLAMA_DEFAULT_URL, apiKeyEnv: null },
        openai: { baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      },
      tasks: {
        plan: { via: 'cli' as const, model: '' },
        'find-sources': { via: 'cli' as const, model: '' },
        angles: { via: 'ollama' as const, model: 'granite4.2:8b' },
        extract: { via: 'openai' as const, model: 'gpt-x' },
        embed: { via: 'ollama' as const, model: 'qwen3-embedding:4b' },
      },
    };
    await writeProvidersConfig(written, env);
    expect(await readProvidersConfig(env)).toEqual(written);
    // 檔案本身是無 BOM 的 UTF-8，而且是 v2。
    const raw = await readFile(providersFilePath(env), 'utf8');
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
    expect(JSON.parse(raw).version).toBe(2);
  });

  it('不認得的任務名一律丟掉，每個任務都有一格', () => {
    const config = parseConfig({
      version: 2,
      tasks: {
        anlges: { via: 'ollama', model: '打錯的那個' },
        extract: { via: 'ollama', model: 'x' },
      },
    });
    expect(Object.keys(config.tasks).sort()).toEqual(MODEL_TASKS.map((t) => t.task).sort());
    expect(config.tasks.extract.model).toBe('x');
    expect(config.tasks.angles.model).toBe('');
  });

  it('`via` 不在准許的清單裡就退回第一個准許的', () => {
    // 嵌入只准本機（ADR-0009）；找來源不能走本機 Ollama（它沒有 browse）。
    const config = parseConfig({
      version: 2,
      tasks: {
        embed: { via: 'openai', model: 'text-embedding-3' },
        'find-sources': { via: 'ollama', model: '' },
        angles: { via: 'cli', model: 'x' },
      },
    });
    expect(config.tasks.embed.via).toBe('ollama');
    expect(config.tasks['find-sources'].via).toBe('cli');
    expect(config.tasks.angles.via).toBe('ollama');
  });

  it('每個任務可以走哪些連線是由角色推出來的', () => {
    // 找來源：CLI 的搜尋是參數給的，OpenAI 相容 API 的搜尋是量的（v0.24.2，ADR-0034）。
    expect(viaOptionsOf('find-sources')).toEqual(['cli', 'openai']);
    expect(viaOptionsOf('angles')).toEqual(['ollama', 'openai']);
    expect(viaOptionsOf('extract')).toEqual(['ollama', 'openai']);
    expect(viaOptionsOf('embed')).toEqual(['ollama']);
  });

  it('沒有位址的 openai 連線是 null；沒有位址的 ollama 退回慣例位址', () => {
    const config = parseConfig({
      version: 2,
      connections: { openai: { baseUrl: '', apiKeyEnv: 'K' }, ollama: { baseUrl: '' } },
    });
    expect(config.connections.openai).toBeNull();
    expect(config.connections.ollama.baseUrl).toBe(OLLAMA_DEFAULT_URL);
  });

  it('httpConnectionFor：任務走哪一條 HTTP 連線；CLI 回 null', () => {
    const config = parseConfig({
      version: 2,
      connections: { openai: { baseUrl: 'https://x/v1', apiKeyEnv: null } },
      tasks: { extract: { via: 'openai', model: 'm' } },
    });
    expect(httpConnectionFor(config, 'extract')?.baseUrl).toBe('https://x/v1');
    expect(httpConnectionFor(config, 'angles')?.baseUrl).toBe(OLLAMA_DEFAULT_URL);
    expect(httpConnectionFor(config, 'find-sources')).toBeNull();
  });

  it('只有明確送 true 才算打開診斷', () => {
    expect(parseConfig({ version: 2, diagnostics: { logModelCalls: 'yes' } }).diagnostics).toEqual({
      logModelCalls: false,
    });
    expect(parseConfig({ version: 2, diagnostics: { logModelCalls: true } }).diagnostics).toEqual({
      logModelCalls: true,
    });
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

  it('形狀不對的名字在解析時就被丟掉，不會被寫進設定檔', () => {
    const config = parseConfig({
      version: 2,
      connections: { openai: { baseUrl: 'https://x/v1', apiKeyEnv: 'sk-proj-abc' } },
    });
    expect(config.connections.openai?.apiKeyEnv).toBeNull();
  });
});

describe('建議值', () => {
  it('逐任務的建議表跟 CHAT_TASKS 是同一組鍵，而且抽取就是預設模型', () => {
    expect(Object.keys(RECOMMENDED_TASK_MODELS).sort()).toEqual([...CHAT_TASKS].sort());
    for (const task of CHAT_TASKS) expect(RECOMMENDED_TASK_MODELS[task].length).toBeGreaterThan(0);
    // **預設模型要能單獨把兩個任務都跑完** —— 分開只是可選的加分。
    expect(RECOMMENDED_TASK_MODELS.extract).toBe(RECOMMENDED_CHAT_MODEL);
  });
});
