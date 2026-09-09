/**
 * 守門：**`docs/index.md` 的現況欄要真的涵蓋 `docs/` 底下每一份文件。**
 *
 * ## 為什麼需要它
 *
 * 這個 repo 已經被同一種東西咬過三次，而三次都是**手維護的清單漂掉**：
 *
 * | 什麼 | 寫的 | 實際 |
 * |---|---|---|
 * | 「哪些專案有 agent 檔」（`D:\Projects\CLAUDE.md`）| 4 個 | 6 個 |
 * | 卡片的 `data_root` | 1 個 | 2 個 |
 * | **`docs/index.md` 的調查區** | 5 份 | **8 份** |
 *
 * 第三次是 2026-09-09 順手比對出來的：`embedding-choice.md`、
 * `embedding-eval-queries.jsonl`、`chat-choice.md` 三份**從來沒有進過 index**，
 * 而 index.md 自稱是「每一份文件的現況欄」。
 * 前兩次的處方都是「拿掉手寫清單，改成產生或驗證」，這一條就是那個處方。
 *
 * ## 它不要求逐檔列，只要求**涵蓋**
 *
 * index 對 ADR 與 REQ 是用範圍寫的（`ADR-0001…0025`），對環境快照是用
 * `snapshots/*.md`。那是對的 —— 25 份 ADR 逐條列在現況表裡沒有意義。
 * 所以這裡只檢查兩件事：
 *
 * 1. 範圍的上界**等於實際最大的編號**，而且中間沒有缺號
 * 2. 不屬於那三類的每一份，**檔名要出現在 index 裡**
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const index = readFileSync(join(DOCS, 'index.md'), 'utf8');

function docFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md') || e.name.endsWith('.jsonl')) {
        out.push(relative(DOCS, p).split(sep).join('/'));
      }
    }
  };
  walk(DOCS);
  return out.sort();
}

/** `decisions/ADR-0007-w-x-y.md` → 7。認不出來的回 `null`。 */
function numberOf(prefix: string, path: string): number | null {
  const name = path.split('/').pop() ?? '';
  const head = prefix + '-';
  if (!name.startsWith(head)) return null;
  const digits = name.slice(head.length, head.length + 4);
  if (digits.length !== 4 || !/^[0-9]+$/.test(digits)) return null;
  return Number(digits);
}

describe('`docs/index.md` 涵蓋 `docs/` 底下每一份文件', () => {
  const files = docFiles();

  for (const [prefix, label] of [
    ['ADR', '決定'],
    ['REQ', '需求'],
  ] as const) {
    it(`${label}的範圍寫法對得上實際的編號（${prefix}）`, () => {
      const nums = files
        .map((f) => numberOf(prefix, f))
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
      expect(nums.length).toBeGreaterThan(0);
      // 中間不能缺號 —— 缺號代表有一份被刪了而範圍沒改。
      expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
      const last = String(nums[nums.length - 1]).padStart(4, '0');
      // index 寫的是 `ADR-0001…0025` 這種形狀。**上界要等於實際最大的那一個。**
      expect(index).toContain(`${prefix}-0001…${last}`);
    });
  }

  it('其餘每一份的檔名都出現在 index 裡', () => {
    const byRange = (f: string): boolean =>
      numberOf('ADR', f) !== null ||
      numberOf('REQ', f) !== null ||
      f.startsWith('environment/snapshots/');
    const missing = files
      .filter((f) => !byRange(f))
      .filter((f) => !index.includes(f) && !index.includes(f.split('/').pop() ?? ''));
    // 失敗時要看得到是哪幾份 —— 只說「有 3 份沒列」等於還要自己去找。
    expect(missing).toEqual([]);
  });
});
