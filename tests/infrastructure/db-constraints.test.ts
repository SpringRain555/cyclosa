/**
 * 資料庫層守著的約束。
 *
 * `data-model.md` 明寫這兩條「**由資料庫層守，不是靠 UI 記得**」——
 * 那句話要是真的，就得有測試證明 trigger 會擋。
 * 應用層有很多寫入點，而 trigger 只有一個。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import {
  openCaseDatabase,
  SUPPORTED_SCHEMA_VERSION,
} from '../../src/infrastructure/db/database.js';

let dir: string;
let db: DatabaseSync;

const NOW = 1_700_000_000_000;

function insertItem(id: string): void {
  db.prepare(
    `INSERT INTO item (id, kind, status, created_at, updated_at) VALUES (?, 'web', 'included', ?, ?)`,
  ).run(id, NOW, NOW);
}

function insertEdge(
  id: string,
  opts: { origin: 'machine' | 'human'; status: string; layer?: string },
): void {
  db.prepare(
    `INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind,
                       origin, status, confidence, created_at, updated_at)
     VALUES (?, ?, 'rel', 'i1', 'item', 'i2', 'item', ?, ?, 0.5, ?, ?)`,
  ).run(id, opts.layer ?? 'named', opts.origin, opts.status, NOW, NOW);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cyclosa-db-'));
  const opened = await openCaseDatabase(join(dir, 'case.sqlite'), { create: true });
  if (opened.kind !== 'ok') throw new Error(`開不起來：${opened.kind}`);
  db = opened.db;
  insertItem('i1');
  insertItem('i2');
});

afterEach(async () => {
  db?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('migration', () => {
  it('跑到宣告的 schema 版本', () => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(SUPPORTED_SCHEMA_VERSION);
  });

  it('WAL 打開了 —— 讀寫不互相擋', () => {
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');
  });

  it('外鍵約束打開了', () => {
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });
});

describe('約束一：已確認需要出處，除非是人建的', () => {
  it('機器產生的邊不能直接以 confirmed 插入', () => {
    expect(() => insertEdge('e1', { origin: 'machine', status: 'confirmed' })).toThrow(
      /GRAPH_EVIDENCE_REQUIRED/,
    );
  });

  it('機器產生的邊沒有出處時不能被改成 confirmed', () => {
    insertEdge('e1', { origin: 'machine', status: 'pending' });
    expect(() => db.prepare(`UPDATE edge SET status = 'confirmed' WHERE id = 'e1'`).run()).toThrow(
      /GRAPH_EVIDENCE_REQUIRED/,
    );
  });

  it('有出處之後就可以改成 confirmed', () => {
    insertEdge('e1', { origin: 'machine', status: 'pending' });
    db.prepare(
      `INSERT INTO edge_evidence (id, edge_id, item_id, quote, char_start, char_end, created_at)
       VALUES ('ev1', 'e1', 'i1', 'quote', 0, 5, ?)`,
    ).run(NOW);
    expect(() =>
      db.prepare(`UPDATE edge SET status='confirmed' WHERE id='e1'`).run(),
    ).not.toThrow();
  });

  it('**人手動建立的邊不需要出處** —— 出處就是那個人', () => {
    expect(() => insertEdge('e2', { origin: 'human', status: 'confirmed' })).not.toThrow();
  });
});

describe('約束二：origin=human 的列只能新增不能改', () => {
  beforeEach(() => {
    insertEdge('h1', { origin: 'human', status: 'confirmed' });
  });

  it.each([
    ['layer', `UPDATE edge SET layer='similarity' WHERE id='h1'`],
    ['rel', `UPDATE edge SET rel='other' WHERE id='h1'`],
    ['source_id', `UPDATE edge SET source_id='i2' WHERE id='h1'`],
    ['target_id', `UPDATE edge SET target_id='i1' WHERE id='h1'`],
    ['origin', `UPDATE edge SET origin='machine' WHERE id='h1'`],
    ['confidence', `UPDATE edge SET confidence=0.9 WHERE id='h1'`],
  ])('改 %s 會被擋下來', (_field, sql) => {
    expect(() => db.prepare(sql).run()).toThrow(/GRAPH_HUMAN_ROW_IMMUTABLE/);
  });

  it('**但人自己的裁決可以改狀態** —— 撤回與改判是六條轉移裡的', () => {
    expect(() =>
      db.prepare(`UPDATE edge SET status='rejected', updated_at=? WHERE id='h1'`).run(NOW + 1),
    ).not.toThrow();
  });
});

/**
 * open-questions Q6 的答案在資料庫這一半（migration 003）。
 *
 * **這一段守的是「那一欄不帶資訊」**：機器建的非 `named` 邊只能是 `pending`，
 * 所以看到 `pending` 不代表有人在等你判斷 —— 那三層根本不進裁決佇列。
 */
describe('約束三：機器建的非 named 邊只能是待查證（Q6）', () => {
  it.each(['comention', 'similarity', 'derived'])('%s 不能以 confirmed 插入', (layer) => {
    expect(() => insertEdge('m1', { origin: 'machine', status: 'confirmed', layer })).toThrow(
      /GRAPH_LAYER_NOT_ADJUDICABLE/,
    );
  });

  it.each(['comention', 'similarity', 'derived'])('%s 不能被改成 rejected', (layer) => {
    insertEdge('m1', { origin: 'machine', status: 'pending', layer });
    expect(() => db.prepare(`UPDATE edge SET status='rejected' WHERE id='m1'`).run()).toThrow(
      /GRAPH_LAYER_NOT_ADJUDICABLE/,
    );
  });

  it('**但人手動建的轉載可以是已確認** —— 規則裡有 origin，不只有 layer', () => {
    expect(() =>
      insertEdge('h-derived', { origin: 'human', status: 'confirmed', layer: 'derived' }),
    ).not.toThrow();
  });

  it('人建的非 named 邊也撤回得動 —— 重算永遠不碰人建的列，所以沒有東西會蓋掉它', () => {
    insertEdge('h-derived', { origin: 'human', status: 'confirmed', layer: 'derived' });
    expect(() =>
      db
        .prepare(`UPDATE edge SET status='pending', updated_at=? WHERE id='h-derived'`)
        .run(NOW + 1),
    ).not.toThrow();
  });

  it('機器建的具名關係不受這一條影響 —— 它本來就是要給人裁決的', () => {
    insertEdge('m-named', { origin: 'machine', status: 'pending', layer: 'named' });
    expect(() =>
      db.prepare(`UPDATE edge SET status='rejected' WHERE id='m-named'`).run(),
    ).not.toThrow();
  });
});

/**
 * 稽核紀錄只增不刪（ADR-0016）。
 *
 * **校準比例是從它算出來的** —— 一列被改掉的紀錄會讓那個百分比
 * 安靜地變成另一個數字，而使用者沒有任何辦法發現。
 */
describe('約束四：edge_audit 只增不刪', () => {
  beforeEach(() => {
    insertEdge('a1', { origin: 'machine', status: 'pending' });
    db.prepare(
      `INSERT INTO edge_audit (id, edge_id, from_status, to_status, action, actor, at)
       VALUES ('au1','a1','pending','rejected','reject','human',?)`,
    ).run(NOW);
  });

  it('改一列會被擋下來', () => {
    expect(() =>
      db.prepare(`UPDATE edge_audit SET to_status='confirmed' WHERE id='au1'`).run(),
    ).toThrow(/GRAPH_AUDIT_APPEND_ONLY/);
  });

  it('單獨刪一列會被擋下來', () => {
    expect(() => db.prepare(`DELETE FROM edge_audit WHERE id='au1'`).run()).toThrow(
      /GRAPH_AUDIT_APPEND_ONLY/,
    );
  });

  /**
   * **這一條是那個 trigger 的 `WHEN` 子句存在的理由。**
   * 邊被刪掉時 `ON DELETE CASCADE` 會連帶刪它的稽核紀錄，
   * 而那不是竄改 —— 沒有這個例外，一條邊就永遠刪不掉了。
   */
  it('但邊自己被刪掉時，連帶刪掉的稽核紀錄不算竄改', () => {
    expect(() => db.prepare(`DELETE FROM edge WHERE id='a1'`).run()).not.toThrow();
    const n = db.prepare(`SELECT COUNT(*) n FROM edge_audit WHERE edge_id='a1'`).get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });
});

describe('其他 schema 層的約束', () => {
  it('不能把一個節點連到它自己', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind,
                             origin, status, confidence, created_at, updated_at)
           VALUES ('s1','named','rel','i1','item','i1','item','human','confirmed',0.5,?,?)`,
        )
        .run(NOW, NOW),
    ).toThrow();
  });

  it('layer 只收四個值', () => {
    expect(() =>
      insertEdge('bad', { origin: 'human', status: 'confirmed', layer: 'nope' }),
    ).toThrow();
  });

  it('同一個 sha256 不能有兩個 item —— 匯入兩次認得出是同一份', () => {
    db.prepare(`UPDATE item SET sha256='abc' WHERE id='i1'`).run();
    expect(() => db.prepare(`UPDATE item SET sha256='abc' WHERE id='i2'`).run()).toThrow();
  });

  it('sha256 是 NULL 的可以有很多筆（還沒抓的項目）', () => {
    // 部分索引 WHERE sha256 IS NOT NULL —— 這一條驗那個 WHERE 真的有作用
    const n = db.prepare('SELECT COUNT(*) n FROM item WHERE sha256 IS NULL').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('case 表只能有一列', () => {
    db.prepare(
      `INSERT INTO "case" (id,name,status,created_at,updated_at) VALUES ('self','x','new',?,?)`,
    ).run(NOW, NOW);
    expect(() =>
      db
        .prepare(
          `INSERT INTO "case" (id,name,status,created_at,updated_at) VALUES ('two','y','new',?,?)`,
        )
        .run(NOW, NOW),
    ).toThrow();
  });
});
