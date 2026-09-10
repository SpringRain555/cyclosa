/**
 * 走訪的上界：**超過硬上限就停，而且說出自己停了。**
 *
 * ## 為什麼有這一條
 *
 * 2026-09-10 的規模量測（5 萬筆／20 萬關聯，`docs/environment/performance.md`）：
 * `/subgraph/size` 的預算是 **50 ms**，實測從一個中位數度數的節點走完 3 跳是
 * **1,555 ms**，從樞紐是 **4,566 ms** —— 因為 3 跳鄰域是 3.2 萬到 5.4 萬個節點。
 *
 * 那個差距不是實作補得回來的，而**它也不需要補**：超過 `RENDER_LIMIT` 的子圖
 * 一律回 413，所以「32,170」與「超過 8,000」對使用者是同一句話。
 *
 * 這條測試守的是修法本身的兩半：
 *
 * 1. **真的停了** —— 停了才快
 * 2. **停了要說出來**（`capped`）—— 不說的話，一個下界會被當成一個數，
 *    而畫面上會出現「8001 個節點」這種看起來精確的假話
 *
 * 第 2 半比第 1 半重要：只做第 1 半的話，效能達標而畫面開始說謊。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { subgraph, subgraphSize } from '../../src/application/graph-service.js';
import { DEFAULT_FILTERS, RENDER_LIMIT } from '../../src/domain/graph/subgraph.js';
import { DEFAULT_PROJECTION_THRESHOLDS } from '../../src/domain/graph/projection.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { traverse } from '../../src/infrastructure/db/repositories/graph-repo.js';

let sandbox: string;
let dataRoot: string;
const SLUG = 'cap';
const FOCUS = 'itm-focus';

/**
 * 一個星形：焦點 ＋ `spokes` 份文件，每一份用一條相似度邊連到焦點。
 *
 * **星形是最省的形狀** —— 一跳就到得了全部，所以不必造出深的圖
 * 就能越過硬上限。造 9,000 份文件大約半秒。
 */
function writeStar(db: DatabaseSync, spokes: number): void {
  const now = Date.now();
  db.exec('BEGIN');
  const item = db.prepare(
    'INSERT INTO item (id, kind, title, title_rank, lang, status, excerpt, created_at, updated_at)' +
      " VALUES (?, 'text', ?, ?, 'zh', 'included', '', ?, ?)",
  );
  const edge = db.prepare(
    'INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind,' +
      ' origin, status, confidence, created_at, updated_at)' +
      " VALUES (?, 'similarity', '相似', ?, 'item', ?, 'item', 'machine', 'pending', 0.5, ?, ?)",
  );
  item.run(FOCUS, '合成焦點', '合成焦點', now, now);
  for (let i = 0; i < spokes; i += 1) {
    const id = 'itm-' + i;
    item.run(id, '合成第 ' + i + ' 份', '合成第 ' + i + ' 份', now, now);
    edge.run('edg-' + i, FOCUS, id, now, now);
  }
  db.exec('COMMIT');
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-cap-'));
  dataRoot = join(sandbox, 'DataRoot');
  const folder = join(dataRoot, 'cases', SLUG);
  await mkdir(folder, { recursive: true });

  const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error('打不開測試資料庫：' + opened.kind);
  opened.db
    .prepare(
      "INSERT INTO \"case\" (id, name, status, created_at, updated_at) VALUES ('self', ?, 'ready', ?, ?)",
    )
    .run(SLUG, Date.now(), Date.now());
  writeStar(opened.db, RENDER_LIMIT + 1_000);
  opened.db.close();
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('走訪的上界', () => {
  it('超過上界就不再往外走，而且記下是第幾跳停的', async () => {
    const folder = join(dataRoot, 'cases', SLUG);
    const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
    if (opened.kind !== 'ok') throw new Error(opened.kind);
    try {
      const capped = traverse(
        opened.db,
        FOCUS,
        3,
        DEFAULT_FILTERS,
        DEFAULT_PROJECTION_THRESHOLDS,
        RENDER_LIMIT,
      );
      expect(capped.truncatedAtHop).toBe(1);

      // **停下來的那一跳自己也超過了上界** —— 它是走完那一跳才發現的。
      expect(capped.visible.size).toBeGreaterThan(RENDER_LIMIT);

      // 而第 2、3 跳一個都沒有再加 —— 停了就是停了。
      expect(capped.idsByHop[2]).toEqual([]);
      expect(capped.idsByHop[3]).toEqual([]);
    } finally {
      opened.db.close();
    }
  });

  it('沒有上界時走完，數字才是實際值', async () => {
    const folder = join(dataRoot, 'cases', SLUG);
    const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
    if (opened.kind !== 'ok') throw new Error(opened.kind);
    try {
      const full = traverse(opened.db, FOCUS, 3, DEFAULT_FILTERS, DEFAULT_PROJECTION_THRESHOLDS);
      expect(full.truncatedAtHop).toBeNull();
      expect(full.visible.size).toBe(RENDER_LIMIT + 1_000 + 1);
    } finally {
      opened.db.close();
    }
  });
});

describe('節點預算把下界說成下界', () => {
  it('停掉的那幾格進 `capped`，沒停的不進', async () => {
    const out = await subgraphSize(dataRoot, SLUG, {
      focus: FOCUS,
      hops: 2,
      filters: DEFAULT_FILTERS,
      thresholds: DEFAULT_PROJECTION_THRESHOLDS,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // 1 跳就越過上限了，所以 1、2、3 三格的數字全是下界。
    expect(out.data.capped).toEqual(['1', '2', '3']);
    // **而它們仍然是超過預算的** —— 兩個旗標各有各的意思，不是同一個。
    expect(out.data.overBudget).toEqual(['1', '2', '3']);
  });

  it('沒有被截斷的專題，`capped` 是空的', async () => {
    // 焦點自己一條邊都沒有的情形：走訪立刻收工。
    const folder = join(dataRoot, 'cases', SLUG);
    const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
    if (opened.kind !== 'ok') throw new Error(opened.kind);
    opened.db.exec('DELETE FROM edge');
    opened.db.close();

    const out = await subgraphSize(dataRoot, SLUG, {
      focus: FOCUS,
      hops: 2,
      filters: DEFAULT_FILTERS,
      thresholds: DEFAULT_PROJECTION_THRESHOLDS,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.capped).toEqual([]);
    expect(out.data.counts['3']).toBe(1);
  });
});

describe('子圖本身', () => {
  it('太大就回 413，而且是走到上界就回 —— 不是走完整張圖才回', async () => {
    const out = await subgraph(dataRoot, SLUG, {
      focus: FOCUS,
      hops: 2,
      filters: DEFAULT_FILTERS,
      thresholds: DEFAULT_PROJECTION_THRESHOLDS,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('GRAPH_SUBGRAPH_TOO_LARGE');
  });
});
