/**
 * 端對端：子圖 API、節點預算、投影三段、四層的畫法欄位。
 *
 * **完全隔離**：`LOCALAPPDATA` 與資料根都指到臨時目錄。
 *
 * 用的是 `tools/dev/graph-fixture.ts` 的合成圖 —— **v0.2.0 的匯入不產生關聯**，
 * 所以真實資料在這一階段畫不出任何一條線，四種畫法一種都驗不到。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { FIXTURE, writeSyntheticGraph } from '../../tools/dev/graph-fixture.js';

let sandbox: string;
let dataRoot: string;
let app: FastifyInstance;
let savedLocalAppData: string | undefined;
let slug: string;

interface Envelope {
  ok: boolean;
  code?: string;
  data?: unknown;
}

async function get(url: string): Promise<Envelope> {
  const res = await app.inject({ method: 'GET', url });
  return res.json() as Envelope;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-graph-'));
  const localAppData = join(sandbox, 'LocalAppData');
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(localAppData, { recursive: true });
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = localAppData;

  const built = await buildServer();
  app = built.app;
  await app.ready();

  await app.inject({
    method: 'POST',
    url: '/api/system/data-root',
    payload: { dataRoot },
  });
  const created = await app.inject({
    method: 'POST',
    url: '/api/cases',
    payload: { name: '合成關聯圖驗收' },
  });
  slug = (created.json() as { data: { slug: string } }).data.slug;

  // 直接開專題資料庫塞合成資料 —— API 還沒有寫入關聯的路徑（那是 v0.4.0）
  const opened = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(`開不了合成專題的資料庫：${opened.kind}`);
  try {
    writeSyntheticGraph(opened.db);
  } finally {
    opened.db.close();
  }
});

afterEach(async () => {
  await app?.close();
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

describe('沒有整圖端點', () => {
  it('合成書目連到資料，子圖帶出虛線畫法與原網址', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=1`);
    const data = body.data as {
      nodes: { id: string }[];
      edges: { source: string; target: string }[];
    };
    expect(data.nodes.find((entry) => entry.id === 'itm-reference')).toMatchObject({
      kind: 'item',
      subKind: 'reference',
      dashed: true,
      hollow: false,
      sourceUrl: 'https://example.invalid/reference',
      excerpt: '',
    });
    expect(data.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: FIXTURE.focus, target: 'itm-reference' }),
      ]),
    );
  });
  it('`/graph` 不存在 —— 不是「有但不建議用」（ADR-0008）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/cases/${slug}/graph` });
    expect(res.statusCode).toBe(404);
  });

  it('子圖端點在，所以上面那條測的是「沒登記」而不是「打錯路徑」', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}`,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('節點預算：只數不拉資料', () => {
  it('每一格跳數各自回一個累計節點數', async () => {
    const body = await get(`/api/cases/${slug}/subgraph/size?focus=${FIXTURE.focus}`);
    expect(body.ok).toBe(true);
    const data = body.data as { counts: Record<string, number>; budget: number };

    // 1 跳：四條 item→item 的邊（含書目） ＋ 展開成節點的實體 ＋ 穿過攤平實體到達的那一份
    expect(data.counts['1']).toBe(7);
    // 2 跳：透過展開的實體再帶進三份互為轉載的
    expect(data.counts['2']).toBe(10);
    // 3 跳：已經走完了，不會再多
    expect(data.counts['3']).toBe(10);
    expect(data.budget).toBe(2000);
  });

  it('這個規模遠低於預算，所以沒有一格是琥珀色', async () => {
    const body = await get(`/api/cases/${slug}/subgraph/size?focus=${FIXTURE.focus}`);
    expect((body.data as { overBudget: string[] }).overBudget).toEqual([]);
  });
});

describe('投影三段', () => {
  it('初讀欄位隨子圖與詳情回傳，子圖不帶摘要、原題不變', async () => {
    const opened = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'));
    if (opened.kind !== 'ok') throw new Error(opened.kind);
    try {
      opened.db
        .prepare(
          'UPDATE item SET title_zh = ?, summary_zh = ?, digested_by = ?, digested_at = ? WHERE id = ?',
        )
        .run('合成譯題', '合成繁中摘要', 'ollama:synthetic', 1234567890000, FIXTURE.focus);
    } finally {
      opened.db.close();
    }
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2`);
    expect(body.ok).toBe(true);
    const nodes = (
      body.data as { nodes: import('../../src/application/graph-service.js').SubgraphNode[] }
    ).nodes;
    const translated = nodes.find((entry) => entry.id === FIXTURE.focus);
    expect(translated).toMatchObject({
      titleZh: '合成譯題',
      digestedBy: 'ollama:synthetic',
      digestedAt: 1234567890000,
    });
    expect(translated?.title).not.toBe('合成譯題');
    const untranslated = nodes.find((entry) => entry.kind === 'item' && entry.id !== FIXTURE.focus);
    expect(untranslated).toMatchObject({ titleZh: null, digestedBy: null, digestedAt: null });
    expect(nodes.find((entry) => entry.kind === 'entity')).toMatchObject({
      titleZh: null,
      digestedBy: null,
      digestedAt: null,
    });
    for (const entry of nodes) expect(entry).not.toHaveProperty('summaryZh');
    const detail = await get(`/api/cases/${slug}/items/${FIXTURE.focus}`);
    expect(detail.ok).toBe(true);
    expect(detail.data).toMatchObject({
      item: {
        title: translated?.title,
        titleZh: '合成譯題',
        summaryZh: '合成繁中摘要',
        digestedBy: 'ollama:synthetic',
        digestedAt: 1234567890000,
      },
    });
    const original = await get(`/api/cases/${slug}/items/${untranslated?.id}`);
    expect(original.ok).toBe(true);
    expect(original.data).toMatchObject({
      item: { titleZh: null, summaryZh: null, digestedBy: null, digestedAt: null },
    });
  });

  it('被 4 份提到的實體展開成空心節點', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2`);
    const nodes = (body.data as { nodes: { id: string; hollow: boolean; mentionCount: number }[] })
      .nodes;
    const hub = nodes.find((n) => n.id === FIXTURE.hub);
    expect(hub).toBeDefined();
    expect(hub?.hollow).toBe(true);
    expect(hub?.mentionCount).toBe(4);
  });

  it('被 2 份提到的實體不是節點，而是一條線中點的方塊', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2`);
    const data = body.data as {
      nodes: { id: string }[];
      edges: { id: string; via: string | null; synthetic: boolean; layer: string }[];
    };

    expect(data.nodes.some((n) => n.id === FIXTURE.pair)).toBe(false);

    const line = data.edges.find((e) => e.via === FIXTURE.pair);
    expect(line).toBeDefined();
    expect(line?.layer).toBe('comention');
    // **它不在資料庫裡** —— id 帶前綴，好讓任何拿它去寫入的程式一開始就找不到
    expect(line?.synthetic).toBe(true);
    expect(line?.id.startsWith('proj:')).toBe(true);
  });

  it('只被 1 份提到的實體根本不畫，也不會出現在任何一條線上', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=3`);
    const data = body.data as {
      nodes: { id: string }[];
      edges: { via: string | null }[];
    };
    expect(data.nodes.some((n) => n.id === FIXTURE.lone)).toBe(false);
    expect(data.edges.some((e) => e.via === FIXTURE.lone)).toBe(false);
  });

  it('門檻可調：把展開門檻降到 2，剛才那條線就變成一個節點', async () => {
    const body = await get(
      `/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2&projection=2`,
    );
    const data = body.data as {
      nodes: { id: string }[];
      edges: { via: string | null }[];
    };
    expect(data.nodes.some((n) => n.id === FIXTURE.pair)).toBe(true);
    expect(data.edges.some((e) => e.via === FIXTURE.pair)).toBe(false);
  });
});

describe('四層各自的畫法', () => {
  it('具名關係有方向；相似度沒有；轉載預設摺起來不畫', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2`);
    const edges = (
      body.data as {
        edges: { id: string; layer: string; directional: boolean; folded: boolean }[];
      }
    ).edges;

    const named = edges.find((e) => e.id === 'edg-acquire');
    expect(named?.directional).toBe(true);
    expect(named?.folded).toBe(false);

    const similar = edges.find((e) => e.id === 'edg-similar');
    expect(similar?.directional).toBe(false);

    const derived = edges.find((e) => e.id === 'edg-mirror-b');
    expect(derived?.folded).toBe(true);
  });

  it('待查證是虛線、已確認不是 —— 而且**只有具名關係吃這條規則**', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2`);
    const edges = (body.data as { edges: { id: string; layer: string; dashed: boolean }[] }).edges;

    expect(edges.find((e) => e.id === 'edg-employ')?.dashed).toBe(true);
    expect(edges.find((e) => e.id === 'edg-acquire')?.dashed).toBe(false);

    // 共同提及與相似度的 status 欄也是 'pending'，但它們**不進裁決佇列** ——
    // 把琥珀色畫在它們身上，真正在等人判斷的那些就淹沒了
    for (const edge of edges.filter((e) => e.layer !== 'named')) {
      expect(edge.dashed).toBe(false);
    }
  });

  it('轉載摺進來源節點，而且看得到摺了幾個', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2`);
    const nodes = (body.data as { nodes: { id: string; derivedFolded: number }[] }).nodes;
    expect(nodes.find((n) => n.id === 'itm-mirror-a')?.derivedFolded).toBe(2);
  });
});

describe('可信度：出處筆數不等於獨立來源數', () => {
  it('出處 5 筆，其中三筆互為轉載 → 獨立來源只有 3 個', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2`);
    const edge = (
      body.data as {
        edges: {
          id: string;
          evidenceCount: number;
          independentSourceCount: number;
          tier: string;
          hasDirectQuote: boolean;
        }[];
      }
    ).edges.find((e) => e.id === 'edg-acquire');

    expect(edge?.evidenceCount).toBe(5);
    expect(edge?.independentSourceCount).toBe(3);
    expect(edge?.tier).toBe('strong');
    expect(edge?.hasDirectQuote).toBe(true);
  });

  it('沒有出處的那一條是弱，而且獨立來源數是 0', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2`);
    const edge = (
      body.data as { edges: { id: string; tier: string; independentSourceCount: number }[] }
    ).edges.find((e) => e.id === 'edg-employ');
    expect(edge?.tier).toBe('weak');
    expect(edge?.independentSourceCount).toBe(0);
  });
});

describe('篩選', () => {
  it('只看具名關係時，共同提及與相似度都不見了', async () => {
    const body = await get(
      `/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2&layers=named`,
    );
    const edges = (body.data as { edges: { layer: string }[] }).edges;
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.layer === 'named')).toBe(true);
  });

  it('可信度下限篩掉弱的那一條', async () => {
    const body = await get(
      `/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=2&minConfidence=strong`,
    );
    const edges = (body.data as { edges: { id: string }[] }).edges;
    expect(edges.some((e) => e.id === 'edg-acquire')).toBe(true);
    expect(edges.some((e) => e.id === 'edg-employ')).toBe(false);
  });

  it('認不得的篩選值直接丟掉，**不是回 400** —— 工具列每動一下就打一次', async () => {
    const body = await get(
      `/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&layers=不存在的層&minConfidence=極強`,
    );
    expect(body.ok).toBe(true);
  });
});

describe('失敗路徑', () => {
  it('焦點不存在 → GRAPH_NODE_NOT_FOUND，不是一張空圖', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=不存在的節點`);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('GRAPH_NODE_NOT_FOUND');
  });

  it('跳數超過上限就夾到上限，不報錯', async () => {
    const body = await get(`/api/cases/${slug}/subgraph?focus=${FIXTURE.focus}&hops=9`);
    expect(body.ok).toBe(true);
    expect((body.data as { hops: number }).hops).toBe(3);
  });

  it('打開分頁時拿得到一個起點，不必先知道任何節點的 id', async () => {
    const body = await get(`/api/cases/${slug}/subgraph/focus`);
    expect(body.ok).toBe(true);
    const data = body.data as { focus: string | null; totalNodeCount: number };
    expect(data.focus).not.toBeNull();
    // 10 份資料節點（含書目） ＋ 3 個實體
    expect(data.totalNodeCount).toBe(13);
  });
});
