/**
 * 實體對齊的端對端測試。
 *
 * **這一份要證明的是三件事，而第三件是前兩件的前提：**
 *
 * 1. 兩種寫法**不會**再變成兩個節點（抽取時就對得上）。
 * 2. 已經分開的兩個併得起來，而且**併完之後圖上是同一個**。
 * 3. **併錯了拆得回來** —— 邊回到原來指的那一個，一條不多一條不少。
 *
 * 第三件是 `entity-repo.ts` 從 v0.5.0 就寫著的那句話
 * 「合錯了沒有工具可以拆開」的反面，而它是這一階段敢做合併的唯一理由。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCase } from '../../src/application/case-service.js';
import {
  listMergeCandidates,
  mergeEntity,
  unmergeEntity,
} from '../../src/application/entity-service.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import * as entities from '../../src/infrastructure/db/repositories/entity-repo.js';
import { insertEdge } from '../../src/infrastructure/db/repositories/edge-repo.js';

let dataRoot = '';
let slug = '';

async function open(): Promise<DatabaseSync> {
  const r = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'), {
    backupDir: join(dataRoot, 'backups'),
    backupLabel: slug,
  });
  if (r.kind !== 'ok') throw new Error(`開不了資料庫：${r.kind}`);
  return r.db;
}

/** 一個 `item` 節點，讓「被幾份提到」數得出來。 */
function makeItem(db: DatabaseSync, id: string, title: string): void {
  db.prepare(
    `INSERT INTO item (id, kind, title, title_rank, lang, status, created_at, updated_at)
     VALUES (?, 'text', ?, ?, 'und', 'included', 0, 0)`,
  ).run(id, title, title);
}

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'cyclosa-ident-'));
  const created = await createCase(dataRoot, { name: '實體對齊' });
  if (!created.ok) throw new Error(created.code);
  slug = created.data.slug;

  const db = await open();
  makeItem(db, 'itm-1', '第一份');
  makeItem(db, 'itm-2', '第二份');
  makeItem(db, 'itm-3', '第三份');

  entities.insertEntity(db, {
    id: 'ent-long',
    type: 'org',
    name: '台灣積體電路製造（TSMC）',
    now: 1,
  });
  entities.insertEntity(db, { id: 'ent-short', type: 'org', name: 'TSMC', now: 2 });
  entities.insertEntity(db, { id: 'ent-other', type: 'org', name: '聯發科', now: 3 });

  // 兩份提到長名字的，一份提到簡稱 —— **加起來三份，分開就都低於門檻。**
  for (const [item, entity] of [
    ['itm-1', 'ent-long'],
    ['itm-2', 'ent-long'],
    ['itm-3', 'ent-short'],
  ] as const) {
    insertEdge(
      db,
      {
        layer: 'comention',
        rel: '提到',
        source: item,
        sourceKind: 'item',
        target: entity,
        targetKind: 'entity',
        origin: 'machine',
        confidence: 0.9,
      },
      1,
    );
  }
  db.close();
});

afterAll(async () => {
  if (dataRoot.length > 0) await rm(dataRoot, { recursive: true, force: true });
});

describe('抽取的時候就對得上', () => {
  it('「台灣積體電路製造（TSMC）」認得出既有的「TSMC」', async () => {
    const db = await open();
    const known = entities.listEntities(db);
    const found = entities.findEntityFor(known, '台灣積體電路製造（TSMC）', 'org');
    expect(found?.id).toBeDefined();
    db.close();
  });

  it('**型別不同不算同一個** —— 名字一樣是巧合', async () => {
    const db = await open();
    const known = entities.listEntities(db);
    expect(entities.findEntityFor(known, 'TSMC', 'person')).toBeNull();
    db.close();
  });

  it('別名記下來之後，第三種寫法也對得上', async () => {
    const db = await open();
    entities.addAlias(db, 'ent-short', '台積電', Date.now());
    const known = entities.listEntities(db);
    expect(entities.findEntityFor(known, '台積電', 'org')?.id).toBe('ent-short');
    db.close();
  });
});

describe('合併建議', () => {
  it('列出那一組，而且說得出理由', async () => {
    const r = await listMergeCandidates(dataRoot, slug);
    if (!r.ok) throw new Error(r.code);

    expect(r.data).toHaveLength(1);
    const [pair] = r.data;
    expect(pair?.reason).toBe('parenthetical');
    // **留被提到比較多次的那一個。**
    expect(pair?.keep.id).toBe('ent-long');
    expect(pair?.keep.mentions).toBe(2);
    expect(pair?.merge.id).toBe('ent-short');
  });
});

describe('合併：不刪任何一列', () => {
  it('邊改指到留下來的那一個，而被併掉的那一列還在', async () => {
    const merged = await mergeEntity(dataRoot, slug, 'ent-long', 'ent-short');
    if (!merged.ok) throw new Error(merged.code);
    expect(merged.data.movedEdges).toBe(1);

    const db = await open();
    const short = entities.getEntity(db, 'ent-short');
    // **還在**，只是指向留下來的那一個 —— 所以取消得掉。
    expect(short).not.toBeNull();
    expect(short?.mergedInto).toBe('ent-long');

    const long = entities.getEntity(db, 'ent-long');
    // 被併掉的名字與它的別名都變成留下來那一個的別名。
    expect(long?.aliases).toContain('TSMC');
    expect(long?.aliases).toContain('台積電');

    const n = db
      .prepare("SELECT COUNT(*) AS n FROM edge WHERE target_kind = 'entity' AND target_id = ?")
      .get('ent-long') as { n: number };
    // **三份都指到同一個了** —— 這正是投影門檻要的那個數字。
    expect(Number(n.n)).toBe(3);
    db.close();
  });

  it('併掉的不再出現在建議裡，也不再算成一個節點', async () => {
    const r = await listMergeCandidates(dataRoot, slug);
    if (!r.ok) throw new Error(r.code);
    expect(r.data).toEqual([]);

    const db = await open();
    const live = db.prepare('SELECT COUNT(*) AS n FROM entity WHERE merged_into IS NULL').get() as {
      n: number;
    };
    expect(Number(live.n)).toBe(2);
    db.close();
  });

  it('已經被併掉的不能再併一次 —— 那會做出一條鏈', async () => {
    const again = await mergeEntity(dataRoot, slug, 'ent-other', 'ent-short');
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe('GRAPH_TRANSITION_INVALID');
  });

  it('不能把一個實體併進它自己', async () => {
    const self = await mergeEntity(dataRoot, slug, 'ent-long', 'ent-long');
    expect(self.ok).toBe(false);
  });
});

describe('取消合併：照紀錄動回去', () => {
  it('那一條邊回到原來指的那一個，一條不多一條不少', async () => {
    const undone = await unmergeEntity(dataRoot, slug, 'ent-short');
    if (!undone.ok) throw new Error(undone.code);
    expect(undone.data.restored).toBe(1);

    const db = await open();
    expect(entities.getEntity(db, 'ent-short')?.mergedInto).toBeNull();

    const back = db
      .prepare("SELECT COUNT(*) AS n FROM edge WHERE target_kind = 'entity' AND target_id = ?")
      .get('ent-short') as { n: number };
    expect(Number(back.n)).toBe(1);

    const kept = db
      .prepare("SELECT COUNT(*) AS n FROM edge WHERE target_kind = 'entity' AND target_id = ?")
      .get('ent-long') as { n: number };
    // **`ent-long` 本來就有的兩條沒有被送走** —— 靠猜的版本會在這裡出錯。
    expect(Number(kept.n)).toBe(2);
    db.close();
  });

  it('取消過的不能再取消一次', async () => {
    const again = await unmergeEntity(dataRoot, slug, 'ent-short');
    expect(again.ok).toBe(false);
  });

  it('取消之後那一組又會回到建議清單上', async () => {
    const r = await listMergeCandidates(dataRoot, slug);
    if (!r.ok) throw new Error(r.code);
    expect(r.data).toHaveLength(1);
  });
});
