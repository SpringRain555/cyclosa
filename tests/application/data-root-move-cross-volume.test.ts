/**
 * 跨磁碟區搬資料根（`EXDEV`）：**複製完成之後，新位置是唯一確定完整的一份。**
 *
 * `rename` 跨磁碟區會失敗，`moveDataRoot` 退回「複製再刪」。這條路有兩個失敗點，
 * 而它們失敗的時候該清的是**不同的那一邊**：
 *
 * - 複製到一半失敗 → 舊的原封不動，清掉新位置那半份
 * - 複製完了、刪舊的途中失敗（Windows 上某個檔被別的程式開著）→ 舊的已經少了一部分，
 *   **這時候回頭刪新的就是兩邊都不完整**
 *
 * 2026-09-13 之前兩個失敗點共用一個 catch，第二種會刪掉新的那份 —— 這個檔就是為它寫的。
 *
 * ## 為什麼要換掉 `node:fs/promises`
 *
 * 測試機上沒有第二顆磁碟區，也沒辦法可靠地讓一個檔「被別的程式開著」。
 * 所以只換兩件事：**對資料根的那一次** `rename` 回 `EXDEV`、指定的那一次 `rm`／`cp`
 * 做一半就失敗。其餘呼叫全部交給真的模組 —— 檔案是真的被複製、真的被刪。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { initDataRoot, moveDataRoot } from '../../src/application/bootstrap-service.js';

const faults = vi.hoisted(() => ({
  /** `rename` 的來源等於這個路徑時回 `EXDEV` */
  exdevFrom: null as string | null,
  /** `rm` 的目標等於這個路徑時：先真的刪掉底下的 `cases/`，再回 `EBUSY` */
  rmPartialFor: null as string | null,
  /** `cp` 的目標等於這個路徑時：先真的放一個檔進去，再回 `EIO` */
  cpPartialTo: null as string | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const same = (a: unknown, b: string | null): boolean =>
    b !== null && typeof a === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();
  const fail = (code: string): Error => Object.assign(new Error(`${code}（測試注入）`), { code });

  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      if (same(from, faults.exdevFrom)) throw fail('EXDEV');
      return actual.rename(from, to);
    },
    rm: async (path: string, options?: Parameters<typeof actual.rm>[1]): Promise<void> => {
      if (same(path, faults.rmPartialFor)) {
        await actual.rm(join(path, 'cases'), { recursive: true, force: true });
        throw fail('EBUSY');
      }
      return actual.rm(path, options);
    },
    cp: async (
      src: string,
      dest: string,
      options?: Parameters<typeof actual.cp>[2],
    ): Promise<void> => {
      if (same(dest, faults.cpPartialTo)) {
        await actual.mkdir(join(dest, 'cases'), { recursive: true });
        await actual.writeFile(join(dest, 'cases', '複製到一半.txt'), 'x', 'utf8');
        throw fail('EIO');
      }
      return actual.cp(src, dest, options);
    },
  };
});

let sandbox = '';
let env: NodeJS.ProcessEnv;
let from = '';
let to = '';

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

async function pointerTarget(): Promise<string> {
  const raw = await fs.readFile(join(env['LOCALAPPDATA']!, 'Cyclosa', 'system_paths.json'), 'utf8');
  return (JSON.parse(raw) as { dataRoot: string }).dataRoot;
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(join(tmpdir(), 'cyclosa-exdev-'));
  env = { LOCALAPPDATA: join(sandbox, 'LocalAppData') };
  from = join(sandbox, 'Before');
  to = join(sandbox, 'After');

  const made = await initDataRoot(from, env);
  if (!made.ok) throw new Error(`建不起資料根：${made.code}`);
  await fs.mkdir(join(from, 'cases', '既有專題', 'sources'), { recursive: true });
  await fs.writeFile(join(from, 'cases', '既有專題', 'sources', 'a.txt'), '使用者的資料', 'utf8');

  faults.exdevFrom = from;
});

afterEach(async () => {
  faults.exdevFrom = null;
  faults.rmPartialFor = null;
  faults.cpPartialTo = null;
  if (sandbox.length > 0) await fs.rm(sandbox, { recursive: true, force: true });
});

describe('跨磁碟區搬資料根', () => {
  it('沒有失敗：搬過去、舊的不留、指標檔指著新的', async () => {
    const r = await moveDataRoot(from, to, 0, env);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await exists(join(to, 'cases', '既有專題', 'sources', 'a.txt'))).toBe(true);
    expect(await exists(from)).toBe(false);
    expect(await pointerTarget()).toBe(to);
  });

  it('複製到一半失敗 → 舊的原封不動、新位置清乾淨、指標檔沒改', async () => {
    faults.cpPartialTo = to;

    const r = await moveDataRoot(from, to, 0, env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('IO_DATA_ROOT_MOVE_BLOCKED');

    expect(await exists(join(from, 'cases', '既有專題', 'sources', 'a.txt'))).toBe(true);
    expect(await exists(to)).toBe(false);
    expect(await pointerTarget()).toBe(from);
  });

  /**
   * **這一條是這個檔存在的理由。**
   *
   * 刪舊的那一步在刪掉 `cases/` 之後才失敗 —— 舊位置已經沒有使用者的專題了。
   * 這時候唯一完整的一份在新位置，所以它必須留著，而且指標檔要指過去；
   * 否則下次啟動看到的是舊位置那個被刪掉一半的資料根。
   */
  it('複製完了、刪舊的途中失敗 → 新的那份完整留著，指標檔指過去', async () => {
    faults.rmPartialFor = from;

    const r = await moveDataRoot(from, to, 0, env);
    expect(r.ok, JSON.stringify(r)).toBe(true);

    expect(await fs.readFile(join(to, 'cases', '既有專題', 'sources', 'a.txt'), 'utf8')).toBe(
      '使用者的資料',
    );
    expect(await pointerTarget()).toBe(to);
    // 舊位置刪不乾淨的殘骸留著 —— 失敗方向是「多一份垃圾」，不是「少一份資料」。
    expect(await exists(from)).toBe(true);
  });
});
