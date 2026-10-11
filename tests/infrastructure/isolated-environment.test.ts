/**
 * `tools\Launch.ps1 -LocalAppData` 的獨立環境不看程式資料夾（ADR-0037 追記，2026-10-11）。
 *
 * 只換 `LOCALAPPDATA` 的話，四步的第 2 步還是看這個 repo 的 `userdata\`：平常把資料放在那裡的人，
 * 獨立環境會直接打開平常那一份；沒放過的人，第一次啟動頁預選程式資料夾，按確定就把資料放進 repo。
 * issue #2 的量測步驟（把規模資料寫進 `<LocalAppData>\Cyclosa\data`）兩種情形都會量錯資料。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectDataRoot, programDataRoot, programRoot } from '../../src/infrastructure/fs/paths.js';
import { SANDBOX_ROOT } from '../../vitest.config.js';

const made: string[] = [];

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function sandbox(): Promise<{ program: string; localAppData: string }> {
  await mkdir(SANDBOX_ROOT, { recursive: true });
  const root = await mkdtemp(join(SANDBOX_ROOT, 'isolated-'));
  made.push(root);
  const program = join(root, 'Program');
  const localAppData = join(root, 'LocalAppData');
  // 平常的那一份：放在程式資料夾的 userdata\，有 marker。
  await mkdir(join(program, 'userdata'), { recursive: true });
  await writeFile(join(program, 'userdata', 'data-root.json'), '{"app":"cyclosa","version":1}\n');
  await mkdir(localAppData, { recursive: true });
  return { program, localAppData };
}

describe('獨立環境（CYCLOSA_NO_PROGRAM_FOLDER=1）', () => {
  it('沒有它：第 2 步找到程式資料夾裡平常那一份 —— 這就是要擋的情形', async () => {
    const { program, localAppData } = await sandbox();
    const env = { LOCALAPPDATA: localAppData, CYCLOSA_PROGRAM_DIR: program };
    expect(await detectDataRoot(env)).toMatchObject({
      kind: 'found',
      source: 'program-folder',
      dataRoot: join(program, 'userdata'),
    });
  });

  it('有它：不看程式資料夾，問的時候預選落到這個 LOCALAPPDATA 的使用者資料夾', async () => {
    const { program, localAppData } = await sandbox();
    const env = {
      LOCALAPPDATA: localAppData,
      CYCLOSA_PROGRAM_DIR: program,
      CYCLOSA_NO_PROGRAM_FOLDER: '1',
    };
    expect(programRoot(env)).toBeNull();
    expect(programDataRoot(env)).toBeNull();
    expect(await detectDataRoot(env)).toMatchObject({
      kind: 'choose',
      programDataRoot: null,
      userDataRoot: join(localAppData, 'Cyclosa', 'data'),
    });
  });

  it('只認 "1"：其他值不關掉程式資料夾', () => {
    expect(
      programRoot({ CYCLOSA_PROGRAM_DIR: 'C:\\P', CYCLOSA_NO_PROGRAM_FOLDER: '0' }),
    ).not.toBeNull();
    expect(
      programRoot({ CYCLOSA_PROGRAM_DIR: 'C:\\P', CYCLOSA_NO_PROGRAM_FOLDER: '' }),
    ).not.toBeNull();
  });

  it('Launch.ps1 只在 -LocalAppData 時帶它，而且起完 server 就換回來', async () => {
    const launcher = await readFile(join(process.cwd(), 'tools', 'Launch.ps1'), 'utf8');
    const fn = /function Invoke-WithServerEnvironment \{[\s\S]*?\n\}/.exec(launcher)?.[0] ?? '';
    expect(fn).toContain("if ($separateEnvironment) { $env:CYCLOSA_NO_PROGRAM_FOLDER = '1' }");
    expect(fn).toMatch(/finally \{[\s\S]*\$env:CYCLOSA_NO_PROGRAM_FOLDER = \$savedNoProgram/);
  });
});
