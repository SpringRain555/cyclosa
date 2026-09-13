/**
 * 守門：**擷取節奏的數字只有一個家，文件說的與程式跑的是同一組。**（ADR-0031，CONVENTIONS §17）
 *
 * ## 它為什麼存在
 *
 * 2026-09-13 之前，「同網域 3 秒、被限流就整批停」同時寫在 agent 檔、REQ-0003、README、
 * 六份架構文件、效能報告、維運筆記、公開前檢查表、調查區、畫面字串與程式裡 ——
 * **程式只是其中一個**。
 * 改成退避重試的那一天，要一份一份找出來改；漏掉的那一份會繼續用權威的語氣講一件已經不成立的事。
 *
 * 所以這條守門守四件事：
 *
 * 1. `docs/architecture/fetch-policy.md` 的設定值表 ＝ `throttle.ts` 與 `rate-limit.ts` 匯出的常數（雙向）
 * 2. `src/` 裡每一台 `Crawler` 的間隔都來自 `configuredIntervalMs()` —— 不在某個 service 裡寫第二個數字
 * 3. 畫面上那一列的間隔是填進去的，不是寫死的
 * 4. 現行文件（歷史文件除外）裡沒有舊規則的說法 —— **舊的說法換個地方長回來，是這種漂移最常見的樣子**
 *
 * `tools/research/` 的量測腳本刻意不在第 2 條的範圍：它們是替 agent 做調查的程式，
 * 自己帶自己的節奏（§17：數字住在做抓取的那份程式裡）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as throttle from '../../src/domain/ingest/throttle.js';
import * as rateLimit from '../../src/domain/provider/rate-limit.js';
import { t } from '../../web/src/i18n/zh-TW.js';
import { REPO_ROOT, rel, walk } from './helpers.js';

const POLICY_DOC = join(REPO_ROOT, 'docs', 'architecture', 'fetch-policy.md');

/** 匯出的常數：全大寫的名字，值是一個數字或一串數字。函式與型別不算。 */
function exportedConstants(mod: Record<string, unknown>): Map<string, readonly number[]> {
  const out = new Map<string, readonly number[]>();
  for (const [name, value] of Object.entries(mod)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    if (typeof value === 'number') out.set(name, [value]);
    else if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
      out.set(name, value as number[]);
    }
  }
  return out;
}

/** 文件的設定值表：`| \`NAME\` | 1000 |` 或 `| \`NAME\` | 5000, 15000 |`。 */
function documentedConstants(): Map<string, readonly number[]> {
  const out = new Map<string, readonly number[]>();
  for (const line of readFileSync(POLICY_DOC, 'utf8').split(/\r?\n/)) {
    const m = /^\| `([A-Z][A-Z0-9_]*)` \| ([0-9][0-9, ]*) \|/.exec(line);
    if (m === null) continue;
    out.set(
      m[1] as string,
      (m[2] as string).split(',').map((s) => Number(s.trim())),
    );
  }
  return out;
}

describe('擷取節奏：文件的數字表 ＝ 程式的常數', () => {
  const code = new Map([...exportedConstants(throttle), ...exportedConstants(rateLimit)]);
  const doc = documentedConstants();

  it('兩邊都掃得到東西（不然這條測試是死的）', () => {
    expect(code.size).toBeGreaterThanOrEqual(8);
    expect(doc.size).toBeGreaterThanOrEqual(8);
  });

  it('程式裡每一個常數都在文件的表裡，而且值一樣', () => {
    const wrong = [...code]
      .filter(([name, value]) => JSON.stringify(doc.get(name)) !== JSON.stringify(value))
      .map(
        ([name, value]) =>
          `${name}：程式是 ${value.join(', ')}，文件是 ${doc.get(name)?.join(', ') ?? '（沒寫）'}`,
      );
    expect(wrong).toEqual([]);
  });

  it('文件的表裡沒有程式已經不存在的常數', () => {
    const stale = [...doc.keys()].filter((name) => !code.has(name));
    expect(stale).toEqual([]);
  });
});

describe('擷取節奏：數字不長第二份', () => {
  it('`src/` 裡每一台 Crawler 的間隔都來自 configuredIntervalMs()', () => {
    const constructions: string[] = [];
    const wrong: string[] = [];
    for (const file of walk(join(REPO_ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/new Crawler\(\{[\s\S]*?intervalMs:\s*([^,\n}]+)/g)) {
        constructions.push(rel(file));
        if ((m[1] ?? '').trim() !== 'configuredIntervalMs()') {
          wrong.push(`${rel(file)}：intervalMs: ${(m[1] ?? '').trim()}`);
        }
      }
    }
    expect(
      constructions.length,
      '一台 Crawler 都沒找到 —— 比對的形狀過期了',
    ).toBeGreaterThanOrEqual(3);
    expect(wrong).toEqual([]);
  });

  it('畫面上的間隔與重試次數是填進去的，不是寫死的', () => {
    expect(t.runs.throttleInterval).toContain('{seconds}');
    expect(t.runs.throttleInterval.replace(/\{\w+\}/g, '')).not.toMatch(/[0-9]/);
    expect(t.runs.throttleBackoff).toContain('{n}');
  });
});

/**
 * 舊規則的說法。**只收那段話本身的寫法**，不收「3 秒」這種單獨的數字 ——
 * 預設值本來就是 3 秒，文件裡寫「預設 3 秒」是對的。
 */
const OLD_RULE_PHRASES = [
  '3–5 秒',
  '3-5 秒',
  '3-5s',
  '同網域間隔 3 秒',
  '下限 3 秒',
  '立即停止不重試',
  '立即停止且不重試',
  '立即停不重試',
  '立即停且不重試',
  '立刻停、不重試',
  '立刻停，不重試',
  '429 立刻停',
  '429 立即停',
];

/** 歷史文件：記的是「當時」，本來就該留著舊說法。 */
function isHistorical(path: string): boolean {
  const p = path.split('\\').join('/');
  return (
    p.endsWith('docs/changelog.md') ||
    p.endsWith('docs/lessons.md') ||
    p.includes('docs/decisions/')
  );
}

describe('擷取節奏：現行文件不再說舊規則', () => {
  const files = [
    join(REPO_ROOT, 'README.md'),
    join(REPO_ROOT, 'CLAUDE.md'),
    join(REPO_ROOT, 'AGENTS.md'),
    join(REPO_ROOT, 'web', 'src', 'i18n', 'zh-TW.ts'),
    ...walk(join(REPO_ROOT, 'docs'), ['.md']).filter((f) => !isHistorical(f)),
  ];

  it('掃得到東西（不然這條測試是死的）', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('沒有任何一份還寫著「秒數下限」或「被限流就立刻停、不重試」', () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const phrase of OLD_RULE_PHRASES) {
          if (line.includes(phrase)) hits.push(`${rel(file)}:${i + 1}「${phrase}」`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
