/**
 * 來源清單的預設值與「編輯不會偷偷改掉的事」（2026-09-18）。
 *
 * **要證明的三件事：**
 *
 * 1. 這個工具抓不到的內建入口（Google Scholar、dblp）**預設關著**，
 *    所以不會進 agent 的提示詞 —— 開著的話 agent 會把那裡的網址交回來，
 *    而 dblp 回的是一頁反爬蟲驗證頁（HTTP 200），探測會把它判成「讀得到」。
 * 2. **編輯一列預設關著的入口不會把它打開。** 編輯表單不送 `enabled`，
 *    而 v0.20.0 的 `saveSource` 在沒帶的時候無條件寫 `true`。
 * 3. 提示詞的四段**放的東西跟標題說的一致** —— 沒有紀錄的列只看 `expected`。
 *
 * 每一條自己換一個 `LOCALAPPDATA`：`sources.json` 住在那裡，而測試檔是平行跑的。
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listSources,
  removeSource,
  saveSource,
  sourceHints,
  type SourceRow,
} from '../../src/application/source-service.js';
import { MAX_SOURCE_HINTS_PER_GROUP } from '../../src/domain/provider/index.js';
import { CATALOG } from '../../src/infrastructure/sources/catalog.js';

let sandbox = '';
let saved: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-sources-'));
  await mkdir(join(sandbox, 'LocalAppData'), { recursive: true });
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'LocalAppData');
});

afterEach(async () => {
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

async function rowOf(host: string): Promise<SourceRow> {
  const listed = await listSources(null);
  if (!listed.ok) throw new Error(listed.code);
  const row = listed.data.find((r) => r.host === host);
  if (row === undefined) throw new Error(`清單上沒有 ${host}`);
  return row;
}

describe('抓不到的內建入口預設關著', () => {
  it('Google Scholar 與 dblp 關著，其餘內建的開著', async () => {
    const listed = await listSources(null);
    if (!listed.ok) throw new Error(listed.code);
    const off = listed.data.filter((r) => r.builtIn && !r.enabled).map((r) => r.host);
    expect(off.sort()).toEqual(['dblp.org', 'scholar.google.com']);
  });

  /**
   * **v0.20.1 這一條寫的是「預設關著的都不准有探針」，而 v0.21.0 把它推翻了。**
   *
   * 當時的理由是「探一個抓不到的站只會得到一個假的判斷」—— 那是真的，
   * 因為探測只看錯誤碼。現在它看得出驗證頁（`domain/ingest/challenge.ts`），
   * 而 dblp 那一條實跑的結果是 `FETCH_ROBOTS_DISALLOWED`：**誠實而且有用**，
   * 比「沒有探針」多告訴使用者一件事。
   *
   * 換成守真正的前提：**`probeOne` 一律用 `expect: 'data'`**，
   * 所以有探針的列必須是 API —— 給一個網站列加探針的話，
   * 它回的每一頁 HTML 都會被判成驗證頁，而**症狀是「這個站突然全部抓不到」**。
   */
  it('有探針的列都是 API —— 探測一律要求機器格式', () => {
    for (const entry of CATALOG.filter((e) => e.probe !== null)) {
      expect(entry.kind, `${entry.host} 有探針卻不是 API`).toBe('api');
    }
  });

  it('編輯一列預設關著的入口（沒帶 enabled）不會把它打開', async () => {
    const r = await saveSource({ host: 'dblp.org', noteZh: '只改備註' });
    expect(r.ok).toBe(true);
    const row = await rowOf('dblp.org');
    expect(row.noteZh).toBe('只改備註');
    expect(row.enabled).toBe(false);
  });

  it('使用者自己打開之後，再編輯也維持打開；刪除內建的列只會關掉', async () => {
    await saveSource({ host: 'dblp.org', enabled: true });
    await saveSource({ host: 'dblp.org', noteZh: '再改一次' });
    expect((await rowOf('dblp.org')).enabled).toBe(true);

    await removeSource('dblp.org');
    const row = await rowOf('dblp.org');
    expect(row.builtIn).toBe(true);
    expect(row.enabled).toBe(false);
  });
});

describe('提示詞的四段放的東西跟標題一致', () => {
  it('沒有任何紀錄時：只有「還沒有紀錄」與「多半要登入」兩段，而且照 expected 分', async () => {
    const hints = await sourceHints(null);
    const byHost = new Map(CATALOG.map((e) => [e.host, e]));

    expect(hints.readable).toEqual([]);
    expect(hints.unfetchable).toEqual([]);
    expect(hints.untried.length).toBeGreaterThan(0);
    expect(hints.loginWalled.length).toBeGreaterThan(0);

    for (const host of hints.untried) expect(byHost.get(host)?.expected, host).toBe('open');
    for (const host of hints.loginWalled) {
      expect(['login', 'mixed'], host).toContain(byHost.get(host)?.expected);
    }
    for (const group of [hints.untried, hints.loginWalled]) {
      expect(group.length).toBeLessThanOrEqual(MAX_SOURCE_HINTS_PER_GROUP);
      expect(group).not.toContain('dblp.org');
      expect(group).not.toContain('scholar.google.com');
    }
  });

  it('使用者自己加的排在內建的前面', async () => {
    await saveSource({ host: 'zzz-user.example', nameZh: '字母排最後的自訂來源' });
    const hints = await sourceHints(null);
    expect(hints.untried[0]).toBe('zzz-user.example');
  });
});
