/**
 * 端對端：作業的暫停、續跑、復原，以及結束 Cyclosa。
 *
 * **三件事這一份要證明：**
 *
 * 1. 暫停真的讓迴圈停在原地，續跑真的讓它走下去，而且**暫停中的作業取消得掉**
 *    —— 最後那一條是最容易漏的：等在閘門上的那個如果沒被放走，
 *    迴圈永遠回不到「檢查 cancelled」那一行。
 * 2. 復原刪掉這次作業寫的東西，**而人動過的一條都不動**。
 * 3. 結束 Cyclosa **不帶 `force` 什麼都不做** —— 那道門在伺服器端。
 *
 * ⚠️ **這一份永遠不呼叫 `force: true`** —— 那會把跑測試的這個行程關掉。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import * as registry from '../../src/application/run-registry.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import { insertRun } from '../../src/infrastructure/db/repositories/run-repo.js';
import { indexText } from '../../src/infrastructure/index/writer.js';
import { insertNotice } from '../../src/infrastructure/db/repositories/notice-repo.js';
import {
  appendAudit,
  insertEdge,
  insertEvidence,
  setStatus,
} from '../../src/infrastructure/db/repositories/edge-repo.js';

let sandbox = '';
let dataRoot = '';
let slug = '';
let caseFolder = '';
let app: FastifyInstance;
let savedLocalAppData: string | undefined;

const RUN_ID = 'run-under-test';

interface Envelope<T> {
  ok: boolean;
  code?: string;
  data?: T;
}

async function openDb(): Promise<DatabaseSync> {
  const opened = await openCaseDatabase(join(caseFolder, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(`開不了資料庫：${opened.kind}`);
  return opened.db;
}

function addItem(db: DatabaseSync, id: string, runId: string | null, read = false): void {
  db.prepare(
    `INSERT INTO item (id, kind, title, title_rank, lang, status, low_confidence,
                       read_at, run_id, created_at, updated_at)
     VALUES (?, 'web', ?, ?, 'zh', 'included', 0, ?, ?, 1000, 1000)`,
  ).run(id, id, id, read ? 2000 : null, runId);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-runctl-'));
  const localAppData = join(sandbox, 'LocalAppData');
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(localAppData, { recursive: true });
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = localAppData;

  const built = await buildServer();
  app = built.app;
  await app.ready();

  await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
  const created = await app.inject({
    method: 'POST',
    url: '/api/cases',
    payload: { name: '作業控制驗收' },
  });
  slug = (created.json() as { data: { slug: string } }).data.slug;
  caseFolder = join(dataRoot, 'cases', slug);
});

afterEach(async () => {
  await app?.close();
  registry.unregister(RUN_ID);
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

describe('暫停與續跑', () => {
  it('通知只列未收起的；知道了會持久保存且重按不改日期', async () => {
    const db = await openDb();
    insertNotice(db, { id: 'notice', kind: 'expansion-cleanup', bodyJson: '{}', createdAt: 1 });
    db.close();
    const listed = await app.inject({ method: 'GET', url: `/api/cases/${slug}/notices` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ data: { id: string }[] }>().data.map((notice) => notice.id)).toEqual([
      'notice',
    ]);
    const url = `/api/cases/${slug}/notices/notice/dismiss`;
    const dismissed = await app.inject({ method: 'POST', url });
    expect(dismissed.json<{ data: { dismissed: boolean } }>().data.dismissed).toBe(true);
    const again = await app.inject({ method: 'POST', url });
    expect(again.json<{ data: { dismissed: boolean } }>().data.dismissed).toBe(false);
    const empty = await app.inject({ method: 'GET', url: `/api/cases/${slug}/notices` });
    expect(empty.json<{ data: unknown[] }>().data).toEqual([]);
  });
  it('閘門在暫停時擋住，續跑之後放行', async () => {
    const state = registry.register(RUN_ID);
    let passed = false;

    expect(registry.pause(RUN_ID)).toBe(true);
    const waiting = state.gate().then(() => {
      passed = true;
    });

    // 給它一個 macrotask 的機會 —— 如果閘門沒擋住，這裡就會是 true 了。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(passed).toBe(false);

    expect(registry.resume(RUN_ID)).toBe(true);
    await waiting;
    expect(passed).toBe(true);
  });

  it('沒暫停的時候閘門立刻放行', async () => {
    const state = registry.register(RUN_ID);
    await state.gate();
    expect(registry.isPaused(RUN_ID)).toBe(false);
  });

  it('**暫停中的作業取消得掉** —— 等在閘門上的那個要被放走', async () => {
    const state = registry.register(RUN_ID);
    registry.pause(RUN_ID);
    const waiting = state.gate();

    expect(registry.cancel(RUN_ID)).toBe(true);
    await waiting; // 沒被放走的話這裡會卡到測試逾時
    expect(state.cancelled).toBe(true);
    expect(state.paused).toBe(false);
  });

  it('不在執行中的作業暫停不了，也續跑不了', async () => {
    const pause = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/runs/nope/pause`,
    });
    expect((pause.json() as Envelope<unknown>).code).toBe('GRAPH_TRANSITION_INVALID');

    const resume = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/runs/nope/resume`,
    });
    expect((resume.json() as Envelope<unknown>).code).toBe('GRAPH_TRANSITION_INVALID');
  });
});

interface Report {
  deletedItems: number;
  deletedEdges: number;
  deletedEntities: number;
  keptItems: number;
  keptEdges: number;
  keptAsEvidence: number;
  partial: boolean;
}

async function undo(runId = RUN_ID): Promise<Envelope<Report>> {
  const res = await app.inject({ method: 'POST', url: `/api/cases/${slug}/runs/${runId}/undo` });
  return res.json() as Envelope<Report>;
}

describe('復原這次作業', () => {
  beforeEach(async () => {
    const db = await openDb();
    try {
      insertRun(db, {
        id: RUN_ID,
        kind: 'extract',
        label: '一次抽取',
        total: 2,
        correlationId: 'cid',
        now: 1000,
      });
      addItem(db, 'itm-plain', RUN_ID);
      addItem(db, 'itm-read', RUN_ID, true);
      addItem(db, 'itm-before', null);

      // 這次作業提出的一條，沒人碰過 → 該刪
      insertEdge(
        db,
        {
          layer: 'named',
          rel: '收購',
          source: 'itm-plain',
          sourceKind: 'item',
          target: 'itm-before',
          targetKind: 'item',
          origin: 'machine',
          confidence: 0.5,
          runId: RUN_ID,
        },
        1000,
      );
    } finally {
      db.close();
    }
  });

  it('刪掉這次寫的，留下作業之前就有的', async () => {
    const r = await undo();
    expect(r.ok).toBe(true);
    expect(r.data?.deletedEdges).toBe(1);
    // itm-read 你讀過 → 留下；itm-plain 沒碰過 → 刪掉
    expect(r.data?.deletedItems).toBe(1);
    expect(r.data?.keptItems).toBe(1);
    expect(r.data?.partial).toBe(true);

    const db = await openDb();
    try {
      const rows = db.prepare('SELECT id FROM item ORDER BY id').all() as { id: string }[];
      expect(rows.map((x) => x.id)).toEqual(['itm-before', 'itm-read']);
    } finally {
      db.close();
    }
  });

  it('**人裁決過的邊一條都不動**，連帶它的出處那一份也留著', async () => {
    const db = await openDb();
    let edgeId: string;
    try {
      edgeId = insertEdge(
        db,
        {
          layer: 'named',
          rel: '任職於',
          source: 'itm-plain',
          sourceKind: 'item',
          target: 'itm-before',
          targetKind: 'item',
          origin: 'machine',
          confidence: 0.9,
          runId: RUN_ID,
        },
        1000,
      );
      insertEvidence(
        db,
        edgeId,
        [{ itemId: 'itm-plain', quote: '一段引文', charStart: 0, charEnd: 4 }],
        1000,
      );
      setStatus(db, edgeId, 'confirmed', 1000);
      appendAudit(db, {
        edgeId,
        from: 'pending',
        to: 'confirmed',
        action: 'confirm',
        actor: 'human',
        at: 1000,
      });
    } finally {
      db.close();
    }

    const r = await undo();
    expect(r.data?.keptEdges).toBe(1);
    expect(r.data?.deletedEdges).toBe(1);
    // itm-plain 沒被讀過，但它是那條邊的出處 —— **不能刪**
    expect(r.data?.keptAsEvidence).toBe(1);

    const db2 = await openDb();
    try {
      const kept = db2.prepare('SELECT id FROM edge').all() as { id: string }[];
      expect(kept.map((x) => x.id)).toEqual([edgeId]);
      const evidence = db2
        .prepare('SELECT COUNT(*) AS n FROM edge_evidence WHERE edge_id = ?')
        .get(edgeId) as { n: number };
      // **出處沒有跟著資料一起消失** —— 一條沒有出處的已確認關聯是這個工具最不能有的東西
      expect(Number(evidence.n)).toBe(1);
    } finally {
      db2.close();
    }
  });

  it('再復原一次不會爆炸，而且什麼都沒刪', async () => {
    await undo();
    const again = await undo();
    expect(again.ok).toBe(true);
    expect(again.data?.deletedItems).toBe(0);
    expect(again.data?.deletedEdges).toBe(0);
  });

  it.each(['evidence', 'source', 'target'])('復原也保護別筆作業的 %s 參照', async (reference) => {
    const db = await openDb();
    try {
      addItem(db, 'other', null);
      const edgeId = insertEdge(
        db,
        {
          layer: 'named',
          rel: '合成',
          source: reference === 'source' ? 'itm-plain' : 'other',
          sourceKind: 'item',
          target: reference === 'target' ? 'itm-plain' : 'itm-before',
          targetKind: 'item',
          origin: 'machine',
          confidence: 0.5,
          runId: 'other-run',
        },
        1,
      );
      if (reference === 'evidence')
        insertEvidence(
          db,
          edgeId,
          [{ itemId: 'itm-plain', quote: '合成', charStart: 0, charEnd: 2 }],
          1,
        );
    } finally {
      db.close();
    }
    const result = await undo();
    expect(result.data?.deletedItems).toBe(0);
    expect(result.data?.keptAsEvidence).toBe(1);
    const after = await openDb();
    try {
      expect(after.prepare("SELECT id FROM item WHERE id = 'itm-plain'").get()).toBeDefined();
      expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      if (reference === 'evidence')
        expect(after.prepare('SELECT * FROM edge_evidence').all()).toHaveLength(1);
    } finally {
      after.close();
    }
  });

  it('復原一起清掉索引與向量', async () => {
    const db = await openDb();
    try {
      indexText(db, {
        ownerKind: 'item',
        ownerId: 'itm-plain',
        lang: 'zh',
        title: '合成 title',
        text: '合成 body',
      });
      db.exec("INSERT INTO vector VALUES ('v', 'item', 'itm-plain', 'fixture', 1, X'00000000', 1)");
    } finally {
      db.close();
    }
    await undo();
    const after = await openDb();
    try {
      for (const table of ['bigram', 'fts_text', 'vector']) {
        expect(after.prepare(`SELECT * FROM ${table} WHERE owner_id = 'itm-plain'`).all()).toEqual(
          [],
        );
      }
    } finally {
      after.close();
    }
  });

  it('還在跑的復原不了', async () => {
    registry.register(RUN_ID);
    const r = await undo();
    expect(r.ok).toBe(false);
    expect(r.code).toBe('RUN_STILL_ACTIVE');
  });

  it('不存在的作業回 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/runs/nope/undo`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as Envelope<unknown>).code).toBe('RUN_NOT_FOUND');
  });

  it('`sources\\` 一個位元組都不動', async () => {
    await mkdir(join(caseFolder, 'sources'), { recursive: true });
    await writeFile(join(caseFolder, 'sources', 'abc.html'), 'x', 'utf8');
    await undo();
    // 復原刪的是資料庫裡的列，不是抓回來的位元組。
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(join(caseFolder, 'sources', 'abc.html'), 'utf8')).resolves.toBe('x');
  });
});

describe('結束 Cyclosa', () => {
  it('不帶 force 什麼都不做，只回現在有幾個作業在跑', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/system/shutdown', payload: {} });
    const body = res.json() as Envelope<{ activeRuns: number; shuttingDown: boolean }>;
    expect(body.ok).toBe(true);
    expect(body.data?.shuttingDown).toBe(false);
    expect(body.data?.activeRuns).toBe(0);
  });

  it('有作業在跑的時候，那個數字要說得出來 —— 確認的那句話靠它', async () => {
    registry.register(RUN_ID);
    const res = await app.inject({ method: 'POST', url: '/api/system/shutdown', payload: {} });
    const body = res.json() as Envelope<{ activeRuns: number; shuttingDown: boolean }>;
    expect(body.data?.activeRuns).toBe(1);
    expect(body.data?.shuttingDown).toBe(false);
  });

  it('沒有 GET 版本 —— 一個會被預抓的網址不該關掉程式', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/system/shutdown' });
    expect(res.statusCode).toBe(404);
  });
});
