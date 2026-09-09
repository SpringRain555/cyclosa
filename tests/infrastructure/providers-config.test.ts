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

import {
  DEFAULT_CONFIG,
  apiKeyEnvOf,
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
