/**
 * 端對端：**沒有指標檔時的四步與三選一**（上游 CONVENTIONS §11，ADR-0037）。
 *
 * 每次啟動照同一個順序找，找到就停：指標檔 → `<程式資料夾>\userdata` 裡的 marker →
 * `%LOCALAPPDATA%\Cyclosa\data` 裡的 marker → 都沒有就由畫面問三選一。**問之前什麼都不建。**
 *
 * **每一條測試有自己的 `LOCALAPPDATA` 與自己的程式資料夾**（`CYCLOSA_PROGRAM_DIR`）——
 * 這個檔真的會選「放在程式資料夾裡」，而 `vitest.config.ts` 那一個是整個測試行程共用的：
 * 在那裡建了 `userdata`，別的測試的第 2 步就會找到它。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';

const KEYS = ['LOCALAPPDATA', 'CYCLOSA_PROGRAM_DIR', 'CYCLOSA_SKIP_SAMPLE'] as const;

let sandbox: string;
let localAppData: string;
let program: string;
let app: FastifyInstance | undefined;
let saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

interface Envelope {
  ok: boolean;
  code?: string;
  data?: { dataRoot: string; pointerPath: string; source: string };
  detail?: Record<string, unknown>;
}

async function boot(): Promise<FastifyInstance> {
  await app?.close();
  const built = await buildServer();
  app = built.app;
  await app.ready();
  return app;
}

async function dataRoot(): Promise<Envelope> {
  return (await app!.inject({ method: 'GET', url: '/api/system/data-root' })).json();
}

async function choose(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Envelope }> {
  const res = await app!.inject({ method: 'POST', url: '/api/system/data-root', payload });
  return { status: res.statusCode, body: res.json() };
}

async function caseNames(): Promise<string[]> {
  const res = await app!.inject({ method: 'GET', url: '/api/cases' });
  return (res.json() as { data: { name: string }[] }).data.map((c) => c.name);
}

const pointerFile = (): string => join(localAppData, 'Cyclosa', 'system_paths.json');
const userData = (): string => join(localAppData, 'Cyclosa', 'data');
const programData = (): string => join(program, 'userdata');

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** 手放一個 marker —— 「找」的那幾條不經過「選」，才分得出是哪一步找到的。 */
async function plantMarker(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'data-root.json'), '{"app":"cyclosa","version":1}\n', 'utf8');
}

async function writePointer(value: Record<string, unknown> | string): Promise<void> {
  await mkdir(join(localAppData, 'Cyclosa'), { recursive: true });
  await writeFile(pointerFile(), typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-first-run-'));
  localAppData = join(sandbox, 'LocalAppData');
  program = join(sandbox, 'Program');
  await mkdir(localAppData, { recursive: true });
  saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
  process.env['LOCALAPPDATA'] = localAppData;
  process.env['CYCLOSA_PROGRAM_DIR'] = program;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(sandbox, { recursive: true, force: true });
});

describe('找：四步，找到就停', () => {
  it('都沒有 → IO_POINTER_MISSING，帶著兩個固定位置；問之前一個檔都沒建', async () => {
    await boot();
    const body = await dataRoot();
    expect(body.code, JSON.stringify(body)).toBe('IO_POINTER_MISSING');
    expect(body.detail?.['programDataRoot']).toBe(programData());
    expect(body.detail?.['userDataRoot']).toBe(userData());
    expect(body.detail?.['pointerPath']).toBe(pointerFile());

    expect(await exists(program)).toBe(false);
    expect(await readdir(localAppData)).toEqual([]);
  });

  it('第 2 步：程式資料夾的 userdata 有 marker → 用它，不寫指標檔', async () => {
    await plantMarker(programData());
    await boot();
    const body = await dataRoot();
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.data?.source).toBe('program-folder');
    expect(body.data?.dataRoot).toBe(programData());
    expect(await exists(pointerFile())).toBe(false);
  });

  it('第 3 步：使用者資料夾有 marker → 用它，不寫指標檔', async () => {
    await plantMarker(userData());
    await boot();
    const body = await dataRoot();
    expect(body.data?.source, JSON.stringify(body)).toBe('user-folder');
    expect(body.data?.dataRoot).toBe(userData());
    expect(await exists(pointerFile())).toBe(false);
  });

  it('順序是指標檔 → 程式資料夾 → 使用者資料夾', async () => {
    const elsewhere = join(sandbox, 'Elsewhere');
    await plantMarker(elsewhere);
    await plantMarker(programData());
    await plantMarker(userData());
    await writePointer({ version: 1, data_root: elsewhere });

    await boot();
    expect((await dataRoot()).data?.source).toBe('pointer');

    await rm(pointerFile());
    await boot();
    expect((await dataRoot()).data?.source).toBe('program-folder');

    await rm(join(programData(), 'data-root.json'));
    await boot();
    expect((await dataRoot()).data?.source).toBe('user-folder');
  });

  /**
   * **marker 看檔案不看資料夾**：啟動器在使用者選之前就可能建了 `logs\`，
   * 一個空的版面不能讓人以為那裡已經有資料。
   */
  it('只有資料夾、沒有 marker 不算 —— 照樣問', async () => {
    await mkdir(join(userData(), 'logs'), { recursive: true });
    await mkdir(join(programData(), 'cases'), { recursive: true });
    await boot();
    expect((await dataRoot()).code).toBe('IO_POINTER_MISSING');
  });

  /**
   * **指標檔壞了是一個停下來的理由，不是往下找的理由。**
   * 它指著的地方可能有一整份資料；這時候用程式資料夾那一份頂替，使用者會看到另一份清單、一個字都沒說。
   */
  it('指標檔壞了不往下找 —— 程式資料夾有 marker 也一樣停在 IO_POINTER_MALFORMED', async () => {
    await plantMarker(programData());
    await writePointer('{ 這不是 JSON');
    await boot();
    expect((await dataRoot()).code).toBe('IO_POINTER_MALFORMED');
  });

  it('舊的指標檔（dataRoot）照樣讀得懂；打開時補上 marker', async () => {
    const old = join(sandbox, 'OldRoot');
    for (const d of ['cases', 'backups', 'logs', 'tmp', 'exports']) {
      await mkdir(join(old, d), { recursive: true });
    }
    await writePointer({ version: 1, dataRoot: old, updatedAt: '2026-09-01T00:00:00.000Z' });

    await boot();
    const body = await dataRoot();
    expect(body.data?.source, JSON.stringify(body)).toBe('pointer');
    expect(body.data?.dataRoot).toBe(old);
    // 2026-10-11 之前建的資料根沒有 marker；補上之後指標檔遺失時也認得出來。
    expect(await exists(join(old, 'data-root.json'))).toBe(true);
  });
});

describe('選：三選一', () => {
  it('程式資料夾 → <程式資料夾>\\userdata，不寫指標檔；重開從第 2 步找到它', async () => {
    await boot();
    const { body } = await choose({ choice: 'program-folder' });
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.data?.source).toBe('program-folder');
    expect(body.data?.dataRoot).toBe(programData());
    expect(await readdir(programData())).toContain('data-root.json');
    expect(await exists(pointerFile())).toBe(false);

    await boot();
    expect((await dataRoot()).data?.source).toBe('program-folder');
  });

  it('其他位置 → 版面建好才寫指標檔（data_root）；重開從第 1 步找到它', async () => {
    const target = join(sandbox, '另一顆磁碟', 'Cyclosa');
    await boot();
    const { body } = await choose({ choice: 'other', dataRoot: target });
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.data?.source).toBe('pointer');

    const pointer = JSON.parse(await readFile(pointerFile(), 'utf8')) as Record<string, unknown>;
    expect(pointer['data_root']).toBe(target);
    expect(pointer['version']).toBe(1);
    expect(await readdir(target)).toContain('data-root.json');

    await boot();
    const again = await dataRoot();
    expect(again.data?.source).toBe('pointer');
    expect(again.data?.dataRoot).toBe(target);
  });

  it('沒給 choice 就是「其他位置」—— 2026-10-11 之前的請求照樣能用', async () => {
    const target = join(sandbox, 'Legacy');
    await boot();
    const { body } = await choose({ dataRoot: target });
    expect(body.data?.source, JSON.stringify(body)).toBe('pointer');
    expect(await exists(pointerFile())).toBe(true);
  });

  /**
   * **指標檔遺失、資料在別的地方**：選「其他位置」指回去就接上，專題一個都沒少。
   * 這是四步在「不問就建」之外最想救的那一種情況。
   */
  it('其他位置挑到已經有資料的資料夾 → 接上它，專題還在', async () => {
    const existing = join(sandbox, 'Existing');
    await boot();
    expect((await choose({ choice: 'other', dataRoot: existing })).body.ok).toBe(true);
    await app!.inject({ method: 'POST', url: '/api/cases', payload: { name: '既有專題' } });

    await rm(pointerFile());
    await boot();
    expect((await dataRoot()).code).toBe('IO_POINTER_MISSING');
    const { body } = await choose({ choice: 'other', dataRoot: existing });
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(await caseNames()).toEqual(['既有專題']);
  });

  /**
   * **範例專題只放進這一次才建出來的資料根。** 接上一個專題全刪光了的資料根，
   * 「清單是空的」不代表它是新的 —— marker 才是那個旗標。
   */
  it('接上一個專題刪光了的資料根 → 不放範例專題', async () => {
    const existing = join(sandbox, 'EmptiedOut');
    await boot();
    expect((await choose({ choice: 'other', dataRoot: existing })).body.ok).toBe(true);

    await rm(pointerFile());
    delete process.env['CYCLOSA_SKIP_SAMPLE'];
    await boot();
    expect((await choose({ choice: 'other', dataRoot: existing })).body.ok).toBe(true);
    expect(await caseNames()).toEqual([]);
  });

  it('其他位置擋三種：整顆磁碟、程式資料夾裡面（連 userdata）、不是完整路徑 —— 都不寫指標檔', async () => {
    await boot();
    const cases: [string, string][] = [
      [parse(sandbox).root, 'drive-root'],
      [program, 'inside-program-folder'],
      [programData(), 'inside-program-folder'],
      [join(program, '別的資料夾'), 'inside-program-folder'],
      ['相對\\路徑', 'not-absolute'],
    ];
    for (const [folder, reason] of cases) {
      const { body } = await choose({ choice: 'other', dataRoot: folder });
      expect(body.code, folder).toBe('IO_DATA_ROOT_LOCATION_INVALID');
      expect(body.detail?.['reason'], folder).toBe(reason);
    }
    expect(await exists(pointerFile())).toBe(false);
    expect(await exists(program)).toBe(false);
  });

  it('認不得的 choice → 400；其他位置沒給路徑 → 400', async () => {
    await boot();
    expect((await choose({ choice: 'somewhere' })).status).toBe(400);
    expect((await choose({ choice: 'other' })).status).toBe(400);
    expect((await choose({ choice: 'other', dataRoot: '   ' })).status).toBe(400);
    expect(await readdir(localAppData)).toEqual([]);
  });
});

describe('搬走之後', () => {
  /**
   * 從固定位置（不寫指標檔的那兩種）搬到別處：**搬過去的地方一律寫指標檔**。
   * 舊的固定位置整個搬走了，不會留一個 marker 讓第 3 步把它當成資料根。
   */
  it('從使用者資料夾搬走 → 指標檔指過去，舊位置不在了', async () => {
    const to = join(sandbox, 'Moved');
    await boot();
    expect((await choose({ choice: 'user-folder' })).body.ok).toBe(true);
    await app!.inject({ method: 'POST', url: '/api/cases', payload: { name: '跟著搬' } });

    const moved = await app!.inject({
      method: 'POST',
      url: '/api/system/data-root/move',
      payload: { dataRoot: to },
    });
    expect(moved.json().ok, moved.body).toBe(true);
    expect(await exists(userData())).toBe(false);

    await boot();
    const after = await dataRoot();
    expect(after.data?.source).toBe('pointer');
    expect(after.data?.dataRoot).toBe(to);
    expect(await caseNames()).toEqual(['跟著搬']);
  });
});
