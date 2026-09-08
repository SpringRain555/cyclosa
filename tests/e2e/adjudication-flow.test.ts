/**
 * 端對端：人工裁決（Stage 8）。
 *
 * **完全隔離**：`LOCALAPPDATA` 與資料根都指到臨時目錄。
 *
 * 這一份驗的東西比其他 e2e 多一層 —— 它不只驗「API 回什麼」，
 * 還驗「**寫進去之後資料庫變成什麼**」。理由是這一階段的規則
 * （墓碑、稽核、機器不得覆寫人工判定）全部是**關於狀態變化的**，
 * 而一個只看回應的測試對「它有沒有偷偷改別的東西」是瞎的。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

import { buildServer } from '../../src/server.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { proposeEdges } from '../../src/application/edge-service.js';
import { scoreFor } from '../../src/domain/graph/index.js';
import { writeSyntheticGraph } from '../../tools/dev/graph-fixture.js';

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

async function post(url: string, payload: Record<string, unknown>): Promise<Envelope> {
  const res = await app.inject({ method: 'POST', url, payload });
  return res.json() as Envelope;
}

interface EdgeDetailShape {
  id: string;
  status: string;
  origin: string;
  layer: string;
  rel: string;
  tier: string;
  evidenceCount: number;
  independentSourceCount: number;
  previouslyRejected: boolean;
  actions: string[];
  adjudicable: boolean;
  confirmNeedsEvidence: boolean;
  audit: { fromStatus: string; toStatus: string; action: string; actor: string }[];
  calibration: { kind: string; sampleSize: number; confirmedRate?: number };
  fields: { status: boolean; tier: boolean; evidenceFacts: boolean; adjudication: boolean };
  evidence: { itemId: string; itemTitle: string; quote: string }[];
  sourceTitle: string;
  targetTitle: string;
}

async function detail(edgeId: string): Promise<EdgeDetailShape> {
  const r = await get(`/api/cases/${slug}/edges/${edgeId}`);
  expect(r.ok).toBe(true);
  return r.data as EdgeDetailShape;
}

async function act(edgeId: string, action: string): Promise<Envelope> {
  return post(`/api/cases/${slug}/edges/${edgeId}/transition`, { action });
}

/**
 * 一次**預期會成功**的裁決。
 *
 * **這支存在是因為同一個陷阱咬了兩次**：從「已確認」出發沒有「否決」這條轉移
 * ——那個動作叫「改判」。寫成 `act(id, 'reject')` 的話，
 * 端點回 `GRAPH_TRANSITION_INVALID`，而 `act` 不檢查回傳值，
 * 於是**那一步安靜地什麼都沒做，整條測試改成在測別的東西**。
 *
 * 所以：凡是「先把資料弄成某個狀態」的步驟一律用這一支。
 * `act` 只留給**預期會失敗**的那幾條。
 */
async function actOk(edgeId: string, action: string): Promise<EdgeDetailShape> {
  const r = await act(edgeId, action);
  expect(r.ok, `${action} 應該成功，但回了 ${String(r.code)}`).toBe(true);
  return r.data as EdgeDetailShape;
}

/** 直接開專題資料庫看一眼。**驗「有沒有偷偷改別的東西」只能這樣驗。** */
async function inDb<T>(body: (db: DatabaseSync) => T): Promise<T> {
  const opened = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(`開不了：${opened.kind}`);
  try {
    return body(opened.db);
  } finally {
    opened.db.close();
  }
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-adj-'));
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
    payload: { name: '合成裁決驗收' },
  });
  slug = (created.json() as { data: { slug: string } }).data.slug;

  await inDb((db) => writeSyntheticGraph(db));
});

afterEach(async () => {
  await app?.close();
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

// ══ 一條邊的細節 ═══════════════════════════════════════════

describe('看一條邊憑什麼', () => {
  it('出處 5 筆，但**只有 3 個獨立來源** —— 三份互為轉載算一個', async () => {
    const d = await detail('edg-acquire');
    expect(d.evidenceCount).toBe(5);
    expect(d.independentSourceCount).toBe(3);
  });

  /**
   * **可信度是從那 3 個獨立來源數出來的，不是誰填的。**
   *
   * 合成資料也走 `recomputeConfidence`（`graph-fixture.ts` 結尾），
   * 所以這一條同時在驗「那份合成資料是真實路徑產得出來的」。
   */
  it('三個獨立來源 → 強，而那個分數是算出來的', async () => {
    const d = await detail('edg-acquire');
    expect(d.tier).toBe('strong');
    const c = await inDb((db) =>
      db.prepare(`SELECT confidence c FROM edge WHERE id='edg-acquire'`).get(),
    );
    expect((c as { c: number }).c).toBeCloseTo(
      scoreFor({ independentSourceCount: 3, hasDirectQuote: true }),
    );
  });

  it('引文帶著它出自哪一份的**標題**，不是 id —— 使用者不認得 id', async () => {
    const d = await detail('edg-acquire');
    expect(d.evidence).toHaveLength(5);
    for (const e of d.evidence) {
      expect(e.itemTitle.length).toBeGreaterThan(0);
      expect(e.itemTitle).not.toBe(e.itemId);
      expect(e.quote.length).toBeGreaterThan(0);
    }
  });

  it('兩端也是標題', async () => {
    const d = await detail('edg-acquire');
    expect(d.sourceTitle).toContain('合成起點');
    expect(d.targetTitle).toContain('被收購');
  });

  it('沒有出處的待查證邊，**先說「確認」按不下去**，不要等按了才報錯', async () => {
    const d = await detail('edg-employ');
    expect(d.status).toBe('pending');
    expect(d.evidenceCount).toBe(0);
    expect(d.confirmNeedsEvidence).toBe(true);
  });

  it('找不到的邊回 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/cases/${slug}/edges/nope` });
    expect(res.statusCode).toBe(404);
    expect((res.json() as Envelope).code).toBe('GRAPH_EDGE_NOT_FOUND');
  });

  /**
   * **投影出來的線不是資料庫裡的一列。**
   * `graph-service` 給它們 `proj:` 前綴就是為了讓這種請求在第一步就找不到。
   */
  it('投影出來的線（`proj:` 開頭）沒有東西可以裁決', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/cases/${slug}/edges/${encodeURIComponent('proj:ent-pair:itm-focus:itm-partner')}`,
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as Envelope).code).toBe('GRAPH_EDGE_NOT_FOUND');
  });
});

// ══ 六條轉移 ═══════════════════════════════════════════════

describe('六條轉移都走同一個端點', () => {
  it('待查證 → 已確認（有出處的那一條）', async () => {
    // edg-acquire 一開始就是已確認，先撤回再確認一次
    await actOk('edg-acquire', 'withdraw');
    const r = await act('edg-acquire', 'confirm');
    expect(r.ok).toBe(true);
    expect((r.data as EdgeDetailShape).status).toBe('confirmed');
  });

  it('待查證 → 已否決', async () => {
    const r = await act('edg-employ', 'reject');
    expect((r.data as EdgeDetailShape).status).toBe('rejected');
  });

  it('已確認 → 待查證（**撤回確認**）', async () => {
    const r = await act('edg-acquire', 'withdraw');
    expect((r.data as EdgeDetailShape).status).toBe('pending');
  });

  it('已確認 → 已否決（**改判**）', async () => {
    const r = await act('edg-acquire', 'reclassify');
    expect((r.data as EdgeDetailShape).status).toBe('rejected');
  });

  it('已否決 → 待查證（**復原**）', async () => {
    await actOk('edg-employ', 'reject');
    const r = await act('edg-employ', 'restore');
    expect((r.data as EdgeDetailShape).status).toBe('pending');
  });

  it('已否決 → 已確認（**改判**，要有出處）', async () => {
    await actOk('edg-acquire', 'reclassify'); // 已確認 → 已否決
    const r = await act('edg-acquire', 'reclassify'); // 已否決 → 已確認
    expect((r.data as EdgeDetailShape).status).toBe('confirmed');
  });

  it('不在轉移表上的組合被擋下來', async () => {
    // 待查證沒有「撤回確認」可撤
    const res = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/edges/edg-employ/transition`,
      payload: { action: 'withdraw' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as Envelope).code).toBe('GRAPH_TRANSITION_INVALID');
  });

  it('沒有出處的機器邊確認不了', async () => {
    const r = await act('edg-employ', 'confirm');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('GRAPH_EVIDENCE_REQUIRED');
  });

  it('認不得的動作名稱不會被當成狀態機的問題', async () => {
    const r = await act('edg-employ', '刪掉它');
    expect(r.code).toBe('GRAPH_TRANSITION_INVALID');
  });

  it('每一次轉移寫一列稽核紀錄，而且**改判是再寫一列不是改掉舊的**', async () => {
    await actOk('edg-acquire', 'withdraw');
    await actOk('edg-acquire', 'confirm');
    await actOk('edg-acquire', 'reclassify');

    const d = await detail('edg-acquire');
    expect(d.audit).toHaveLength(3);
    // 新的在前
    expect(d.audit.map((a) => a.action)).toEqual(['reclassify', 'confirm', 'withdraw']);
    expect(d.audit.every((a) => a.actor === 'human')).toBe(true);
    expect(d.audit[0]).toMatchObject({ fromStatus: 'confirmed', toStatus: 'rejected' });
  });
});

// ══ Q6：哪些邊裁決得動 ═════════════════════════════════════

describe('算出來的東西不進裁決（Q6）', () => {
  it.each([
    ['edg-similar', 'similarity'],
    ['edg-mirror-b', 'derived'],
    ['edg-mention-0', 'comention'],
  ])('%s（%s）確認不了 —— 下次重算會把判斷蓋掉', async (edgeId) => {
    const r = await act(edgeId, 'confirm');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('GRAPH_LAYER_NOT_ADJUDICABLE');
  });

  /**
   * **這一條守的是錯誤訊息的正確性，不只是「有沒有擋」。**
   * 先問動作合不合法的話，對一條相似度線按「確認」會得到
   * 「這個狀態變更不被允許」—— 而那句話是錯的：
   * 那個動作對一條待查證的邊完全合法，不合法的是那條邊。
   */
  it('回的是「這條邊不該被裁決」，不是「這個動作不合法」', async () => {
    const r = await act('edg-similar', 'confirm');
    expect(r.code).not.toBe('GRAPH_TRANSITION_INVALID');
    expect(r.code).toBe('GRAPH_LAYER_NOT_ADJUDICABLE');
  });

  it('那些邊的面板上一個按鈕都沒有', async () => {
    const d = await detail('edg-similar');
    expect(d.adjudicable).toBe(false);
    expect(d.actions).toEqual([]);
  });

  it('具名關係有按鈕', async () => {
    const d = await detail('edg-employ');
    expect(d.adjudicable).toBe(true);
    expect(d.actions).toEqual(['confirm', 'reject']);
  });
});

// ══ 手動建立 ═══════════════════════════════════════════════

describe('手動連一條線', () => {
  it('一建立就是「已確認」＋ `origin=human`，而且**不需要出處**', async () => {
    const r = await post(`/api/cases/${slug}/edges`, {
      source: 'itm-focus',
      target: 'itm-quiet',
      rel: '後續報導',
    });
    expect(r.ok).toBe(true);
    const d = r.data as EdgeDetailShape;
    expect(d.status).toBe('confirmed');
    expect(d.origin).toBe('human');
    expect(d.layer).toBe('named');
    expect(d.evidenceCount).toBe(0);
  });

  it('人建的邊撤回得動 —— 建錯了要拿得掉', async () => {
    const created = (
      await post(`/api/cases/${slug}/edges`, {
        source: 'itm-focus',
        target: 'itm-quiet',
        rel: '後續報導',
      })
    ).data as EdgeDetailShape;
    const r = await act(created.id, 'withdraw');
    expect((r.data as EdgeDetailShape).status).toBe('pending');
  });

  it('人可以手動建一條「轉載」，而它照樣是已確認', async () => {
    const r = await post(`/api/cases/${slug}/edges`, {
      source: 'itm-quiet',
      target: 'itm-similar',
      rel: '轉載',
      layer: 'derived',
    });
    expect(r.ok).toBe(true);
    expect((r.data as EdgeDetailShape).status).toBe('confirmed');
  });

  it('連到自己回 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/edges`,
      payload: { source: 'itm-focus', target: 'itm-focus', rel: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Envelope).code).toBe('GRAPH_SELF_EDGE');
  });

  it('具名關係沒寫關係型別回 400 —— **沒有名字的關係不是主張**', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/edges`,
      payload: { source: 'itm-focus', target: 'itm-quiet', rel: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Envelope).code).toBe('GRAPH_REL_EMPTY');
  });

  it('連到不存在的節點回 404', async () => {
    const r = await post(`/api/cases/${slug}/edges`, {
      source: 'itm-focus',
      target: '不存在',
      rel: 'x',
    });
    expect(r.code).toBe('GRAPH_NODE_NOT_FOUND');
  });

  /**
   * **同一個主張存兩列會讓獨立來源數重複計算** ——
   * 而那個數字是這個工具最不能出錯的一個。
   */
  it('同一個（來源, 目標, 關係型別）建第二次會被擋下來', async () => {
    const body = { source: 'itm-focus', target: 'itm-quiet', rel: '後續報導' };
    expect((await post(`/api/cases/${slug}/edges`, body)).ok).toBe(true);
    const second = await post(`/api/cases/${slug}/edges`, body);
    expect(second.ok).toBe(false);
    expect(second.code).toBe('GRAPH_EDGE_EXISTS');
  });

  it('反方向不算重複 —— 方向有意義', async () => {
    await post(`/api/cases/${slug}/edges`, {
      source: 'itm-focus',
      target: 'itm-quiet',
      rel: '引用',
    });
    const r = await post(`/api/cases/${slug}/edges`, {
      source: 'itm-quiet',
      target: 'itm-focus',
      rel: '引用',
    });
    expect(r.ok).toBe(true);
  });
});

// ══ 裁決佇列 ═══════════════════════════════════════════════

describe('裁決佇列', () => {
  interface Queue {
    total: number;
    entries: { id: string; rel: string; previouslyRejected: boolean }[];
  }

  it('**只有具名關係**進佇列 —— 沒有人在等你判斷一條相似度線', async () => {
    const q = (await get(`/api/cases/${slug}/queue`)).data as Queue;
    expect(q.total).toBe(1);
    expect(q.entries.map((e) => e.id)).toEqual(['edg-employ']);
  });

  it('裁決完就離開佇列', async () => {
    await actOk('edg-employ', 'reject');
    const q = (await get(`/api/cases/${slug}/queue`)).data as Queue;
    expect(q.total).toBe(0);
    expect(q.entries).toEqual([]);
  });

  it('撤回確認會讓一條邊回到佇列', async () => {
    await actOk('edg-acquire', 'withdraw');
    const q = (await get(`/api/cases/${slug}/queue`)).data as Queue;
    expect(q.entries.map((e) => e.id).sort()).toEqual(['edg-acquire', 'edg-employ']);
  });
});

// ══ 墓碑 ═══════════════════════════════════════════════════

/** 機器提出一條邊。**沒有 HTTP 端點**，所以直接呼叫用例。 */
function proposal(over: Partial<Parameters<typeof proposeEdges>[2][number]> = {}) {
  return {
    source: 'itm-focus',
    target: 'itm-claim',
    rel: '任職於',
    layer: 'named' as const,
    sourceKind: 'item' as const,
    targetKind: 'item' as const,
    confidence: 0.5,
    evidence: [],
    ...over,
  };
}

describe('已否決是墓碑（ADR-0016）', () => {
  beforeEach(async () => {
    // 使用者否決了「任職於」那一條
    await actOk('edg-employ', 'reject');
  });

  it('重跑不會把否決過的東西再提一次', async () => {
    const r = await proposeEdges(dataRoot, slug, [proposal()]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.blocked).toBe(1);
    expect(r.data.created).toBe(0);

    const d = await detail('edg-employ');
    expect(d.status).toBe('rejected');
  });

  /**
   * **被墓碑擋下來時連出處都不附加。**
   *
   * 依定義這批出處沒有一筆來自新的 `item` —— 寫進去不會讓任何人知道
   * 任何新的事，只會讓下一次的「新出處」判斷更難成立。
   */
  it('被擋下來時什麼都不寫 —— 出處筆數與稽核紀錄都不動', async () => {
    // edg-acquire 有 5 筆出處（mirror-a／b／c ＋ partner ＋ target），先把它改判成已否決。
    // **是 `reclassify` 不是 `reject`** —— 從已確認出發沒有「否決」這條轉移，
    // 而寫成 `reject` 的第一版**這一步安靜地失敗了**，於是整條測試在測別的東西
    expect((await act('edg-acquire', 'reclassify')).ok).toBe(true);
    const before = await detail('edg-acquire');
    expect(before.status).toBe('rejected');
    expect(before.evidenceCount).toBe(5);

    const r = await proposeEdges(dataRoot, slug, [
      proposal({
        source: 'itm-focus',
        target: 'itm-target',
        rel: '收購',
        // 全部出自**已經有的**那幾份
        evidence: [{ itemId: 'itm-partner', quote: '同一份裡換一段話', charStart: 0, charEnd: 8 }],
      }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.blocked).toBe(1);

    const after = await detail('edg-acquire');
    expect(after.status).toBe('rejected');
    expect(after.evidenceCount).toBe(5);
    expect(after.audit).toHaveLength(before.audit.length);
  });

  it('帶著**先前沒有的出處**才能重新提出，而且標「曾被否決」', async () => {
    const r = await proposeEdges(dataRoot, slug, [
      proposal({
        evidence: [{ itemId: 'itm-partner', quote: '一段新的引文', charStart: 0, charEnd: 6 }],
      }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.revived).toBe(1);

    const d = await detail('edg-employ');
    expect(d.status).toBe('pending');
    expect(d.previouslyRejected).toBe(true);
    expect(d.evidenceCount).toBe(1);
  });

  /**
   * **這是稽核紀錄裡唯一一種 `machine`。**
   * 使用者要看得出「這條邊為什麼從否決區跑回佇列」。
   */
  it('復活會寫一列 `actor=machine` 的稽核紀錄', async () => {
    await proposeEdges(dataRoot, slug, [
      proposal({
        evidence: [{ itemId: 'itm-partner', quote: '一段新的引文', charStart: 0, charEnd: 6 }],
      }),
    ]);
    const d = await detail('edg-employ');
    const machine = d.audit.filter((a) => a.actor === 'machine');
    expect(machine).toHaveLength(1);
    expect(machine[0]).toMatchObject({ fromStatus: 'rejected', toStatus: 'pending' });
  });

  /**
   * **「新出處」的定義是 `item` 層級，不是引文字串層級。**
   * 用字串比的話，模型換個句子就能繞過墓碑 —— 那等於沒有墓碑。
   */
  it('同一份文件裡換一段話**不算**新出處', async () => {
    // 先用 itm-partner 讓它復活並留下一筆出處
    await proposeEdges(dataRoot, slug, [
      proposal({
        evidence: [{ itemId: 'itm-partner', quote: '第一段', charStart: 0, charEnd: 3 }],
      }),
    ]);
    await actOk('edg-employ', 'reject');

    // 同一份 itm-partner，換一段話
    const r = await proposeEdges(dataRoot, slug, [
      proposal({
        evidence: [
          { itemId: 'itm-partner', quote: '完全不同的另一段話', charStart: 9, charEnd: 18 },
        ],
      }),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.blocked).toBe(1);

    const d = await detail('edg-employ');
    expect(d.status).toBe('rejected');
    expect(d.evidenceCount).toBe(1); // 沒有多寫進去
  });
});

// ══ 機器不得覆寫人工判定 ═══════════════════════════════════

describe('重跑之後，人的判斷一個都沒有變（Phase E 的驗收條件）', () => {
  /** `origin='human'` 的那些列，重跑前後必須一模一樣。 */
  async function humanSubset(): Promise<unknown[]> {
    return inDb((db) =>
      db
        .prepare(
          `SELECT id, layer, rel, source_id, target_id, origin, status, confidence
             FROM edge WHERE origin = 'human' ORDER BY id`,
        )
        .all(),
    );
  }

  it('人手動建的邊，重跑前後 diff 為空', async () => {
    await post(`/api/cases/${slug}/edges`, {
      source: 'itm-focus',
      target: 'itm-quiet',
      rel: '後續報導',
    });
    const before = await humanSubset();
    expect(before).toHaveLength(1);

    // 機器提出一條**一模一樣的三元組**，外加幾條別的
    const r = await proposeEdges(dataRoot, slug, [
      proposal({ source: 'itm-focus', target: 'itm-quiet', rel: '後續報導', confidence: 0.99 }),
      proposal({ source: 'itm-similar', target: 'itm-partner', rel: '提及' }),
    ]);
    expect(r.ok).toBe(true);

    expect(await humanSubset()).toEqual(before);
  });

  it('人確認過的機器邊，重跑只附加出處、狀態與可信度都不動', async () => {
    const before = await detail('edg-acquire');
    expect(before.status).toBe('confirmed');

    await proposeEdges(dataRoot, slug, [
      proposal({
        source: 'itm-focus',
        target: 'itm-target',
        rel: '收購',
        confidence: 0.99,
        evidence: [{ itemId: 'itm-quiet', quote: '又一筆出處', charStart: 0, charEnd: 5 }],
      }),
    ]);

    const after = await detail('edg-acquire');
    expect(after.status).toBe('confirmed');
    expect(after.evidenceCount).toBe(6); // 出處**有**增加
    const confidence = await inDb((db) =>
      db.prepare(`SELECT confidence c FROM edge WHERE id='edg-acquire'`).get(),
    );
    // **多了一個獨立來源，但可信度沒有跟著動** —— 這條邊被人碰過了。
    // 沒有這一條的話，機器會用一個新的分數把使用者看過的那個蓋掉。
    expect((confidence as { c: number }).c).toBeCloseTo(
      scoreFor({ independentSourceCount: 3, hasDirectQuote: true }),
    );
  });

  /**
   * **可信度不是提案帶進來的數字，是從出處數出來的。**
   *
   * 這一條的第一版是「提案帶一個比較高的 confidence 進來，看它有沒有生效」——
   * 而那正好是要避免的形狀：每一次提案都是「一份文件、一句引文」，
   * 所以提案帶來的分數永遠一樣，拿它比大小的話**多幾個獨立來源永遠不會讓分數動**。
   */
  it('沒有人碰過的待查證邊，多一個獨立來源就多一分', async () => {
    await proposeEdges(dataRoot, slug, [
      proposal({
        evidence: [{ itemId: 'itm-quiet', quote: '第一個來源說的話', charStart: 0, charEnd: 8 }],
      }),
    ]);
    const one = await inDb((db) =>
      db.prepare(`SELECT confidence c FROM edge WHERE id='edg-employ'`).get(),
    );
    expect((one as { c: number }).c).toBeCloseTo(
      scoreFor({ independentSourceCount: 1, hasDirectQuote: true }),
    );

    await proposeEdges(dataRoot, slug, [
      proposal({
        evidence: [{ itemId: 'itm-partner', quote: '第二個來源說的話', charStart: 0, charEnd: 8 }],
      }),
    ]);
    const two = await inDb((db) =>
      db.prepare(`SELECT confidence c FROM edge WHERE id='edg-employ'`).get(),
    );
    expect((two as { c: number }).c).toBeCloseTo(
      scoreFor({ independentSourceCount: 2, hasDirectQuote: true }),
    );
  });

  it('**人碰過之後就不行了** —— 撤回也算碰過', async () => {
    await actOk('edg-employ', 'reject');
    await actOk('edg-employ', 'restore'); // 回到待查證，但已經有稽核紀錄了
    await proposeEdges(dataRoot, slug, [
      proposal({
        evidence: [{ itemId: 'itm-quiet', quote: '一個新的來源', charStart: 0, charEnd: 6 }],
      }),
    ]);
    const c = await inDb((db) =>
      db.prepare(`SELECT confidence c FROM edge WHERE id='edg-employ'`).get(),
    );
    // 出處進去了，但可信度**沒有**跟著動 —— 這條邊被人碰過了
    expect((c as { c: number }).c).toBeCloseTo(
      scoreFor({ independentSourceCount: 0, hasDirectQuote: false }),
    );
  });
});

// ══ 校準比例 ═══════════════════════════════════════════════

describe('校準比例（ADR-0017）', () => {
  /**
   * 塞 n 條機器建的具名邊，每一條都有出處（這樣「確認」按得下去）。
   *
   * **全部同一個 `rel` ＋ 同一段可信度，而那是重點。**
   * 校準比例是分段的（ADR-0017：段 ＝ `rel` × 等級），所以要湊滿 30 條樣本
   * 就必須落在同一段裡。第一版的這支函式給每一條各自的 `rel`
   * （`合成關係-0`、`合成關係-1`…），於是**分段與不分段在那批資料上
   * 看起來一樣合理** —— 而實作當時寫成全域的，測試照樣全綠。
   *
   * 用 `收購` ＋ 0.85 是為了跟 `edg-acquire` 同一段，
   * 那樣才驗得到「這一條邊的校準比例」。
   * 兩端從 9 份合成資料裡輪，湊出 n 個不重複的（來源, 目標）。
   */
  const CAL_REL = '收購';
  /**
   * **三個獨立來源 → 0.7 → 強**，與 `edg-acquire` 同一段。
   *
   * 這裡不寫一個手挑的數字（第一版寫 0.85），理由跟 `graph-fixture.ts`
   * 結尾那一段一樣：**「1 筆出處 ＋ 可信度 0.85」是真實路徑產生不出來的狀態**，
   * 而一旦有東西對它重新提案，它的可信度就會被算回去、跳出這一段 ——
   * 那時失敗的測試看起來會像是校準比例壞了。
   */
  const CAL_SOURCES = ['itm-partner', 'itm-similar', 'itm-mirror-a'] as const;
  const CAL_CONFIDENCE = scoreFor({
    independentSourceCount: CAL_SOURCES.length,
    hasDirectQuote: true,
  });

  async function seedNamed(n: number): Promise<string[]> {
    const items = [
      'itm-focus',
      'itm-target',
      'itm-claim',
      'itm-similar',
      'itm-partner',
      'itm-mirror-a',
      'itm-mirror-b',
      'itm-mirror-c',
      'itm-quiet',
    ];
    const pairs: [string, string][] = [];
    for (const a of items) {
      for (const b of items) {
        // **跳過 edg-acquire 自己那一組** —— 同一個（來源, 目標, 關係型別）
        // 會變成兩列，而 `findByTriple` 只會找到其中一列
        if (a === 'itm-focus' && b === 'itm-target') continue;
        if (a !== b) pairs.push([a, b]);
      }
    }
    expect(pairs.length).toBeGreaterThanOrEqual(n);

    const ids: string[] = [];
    await inDb((db) => {
      const insertEdge = db.prepare(
        `INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind,
                           origin, status, confidence, created_at, updated_at)
         VALUES (?, 'named', ?, ?, 'item', ?, 'item', 'machine', 'pending', ?, 1, 1)`,
      );
      const insertEv = db.prepare(
        `INSERT INTO edge_evidence (id, edge_id, item_id, quote, char_start, char_end, created_at)
         VALUES (?, ?, ?, '合成引文', 0, 4, 1)`,
      );
      for (let i = 0; i < n; i += 1) {
        const id = `edg-cal-${i}`;
        const [source, target] = pairs[i] as [string, string];
        insertEdge.run(id, CAL_REL, source, target, CAL_CONFIDENCE);
        CAL_SOURCES.forEach((itemId, k) => insertEv.run(`evd-cal-${i}-${k}`, id, itemId));
        ids.push(id);
      }
    });
    return ids;
  }

  it('樣本不足 30 條時不給百分比 —— **一個 4 條算出來的 75% 正是要避免的**', async () => {
    const d = await detail('edg-acquire');
    expect(d.calibration.kind).toBe('insufficient-sample');
  });

  it('滿 30 條之後才給比例', async () => {
    const ids = await seedNamed(30);
    for (const [i, id] of ids.entries()) {
      await actOk(id, i < 24 ? 'confirm' : 'reject');
    }
    const d = await detail('edg-acquire');
    expect(d.calibration.kind).toBe('ok');
    expect(d.calibration.sampleSize).toBe(30);
    expect(d.calibration.confirmedRate).toBeCloseTo(0.8);
  });

  it('**一條被改判三次的邊只算一票**', async () => {
    const ids = await seedNamed(30);
    for (const id of ids) await actOk(id, 'confirm');
    // 其中一條反覆改判
    const first = ids[0] as string;
    await actOk(first, 'reclassify'); // → 已否決
    await actOk(first, 'reclassify'); // → 已確認
    await actOk(first, 'withdraw'); // → 待查證（不是判定，不進分母）

    const d = await detail('edg-acquire');
    expect(d.calibration.sampleSize).toBe(30);
  });

  /**
   * **人自己手動建的邊不算進校準比例。**
   * 它們一建立就是已確認 —— 算進去等於在分子分母上各加一筆必然的「確認」，
   * 手動建得越多，比例就越接近 100%，而那個數字不代表任何事情。
   */
  it('手動建的邊不進分母', async () => {
    const ids = await seedNamed(30);
    for (const [i, id] of ids.entries()) {
      await actOk(id, i < 15 ? 'confirm' : 'reject');
    }
    const before = (await detail('edg-acquire')).calibration;

    for (let i = 0; i < 5; i += 1) {
      await post(`/api/cases/${slug}/edges`, {
        source: 'itm-focus',
        target: 'itm-similar',
        rel: `手動關係-${i}`,
      });
    }
    expect((await detail('edg-acquire')).calibration).toEqual(before);
  });

  /**
   * **機器復活一條邊時寫的那列稽核不算進校準** —— 那不是使用者的判斷。
   *
   * 要驗得到，復活的那條邊**必須跟被檢查的那條在同一段**
   * （ADR-0017 的段 ＝ `rel` × 等級）——
   * 這一條的第一版拿「任職於／弱」的 `edg-employ` 去驗「收購／強」的校準，
   * 而在分段之後那兩者本來就互不影響，**所以它驗不到任何東西**。
   */
  it('機器復活一條邊寫的那列不算進校準 —— 那不是使用者的判斷', async () => {
    const ids = await seedNamed(30);
    for (const id of ids) await actOk(id, 'confirm');
    const before = (await detail('edg-acquire')).calibration;
    expect(before.kind).toBe('ok');
    expect(before.sampleSize).toBe(30);

    // 同一段裡的一條，人把它否決掉
    const victim = ids[0] as string;
    const row = await inDb(
      (db) =>
        db.prepare('SELECT source_id s, target_id t FROM edge WHERE id = ?').get(victim) as {
          s: string;
          t: string;
        },
    );
    await actOk(victim, 'reclassify'); // 已確認 → 已否決是**改判**，不是否決
    const mid = (await detail('edg-acquire')).calibration;
    expect(mid.sampleSize).toBe(30); // 還是 30 條，只是其中一票變成否決
    expect(mid.confirmedRate).toBeCloseTo(29 / 30);

    // 機器帶著新出處把它復活 —— 寫的是一列 actor='machine'。
    //
    // **新出處來自第四個獨立來源，所以它復活之後仍然是「強」** ——
    // 掉出這一段的話，分母會因為別的理由變動，這條測試就驗不到它要驗的事。
    const revived = await proposeEdges(dataRoot, slug, [
      proposal({
        source: row.s,
        target: row.t,
        rel: '收購',
        evidence: [{ itemId: 'itm-quiet', quote: '新出處在這裡', charStart: 0, charEnd: 6 }],
      }),
    ]);
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.data.revived).toBe(1);

    // **分母與比例都沒有變** —— 機器那一列不是一票
    const after = (await detail('edg-acquire')).calibration;
    expect(after.sampleSize).toBe(30);
    expect(after.confirmedRate).toBeCloseTo(29 / 30);
  });
});

// ══ 面板上哪幾欄有意義 ═════════════════════════════════════

/**
 * **這一段守的是 2026-09-08 人工驗收照出來的兩個錯。**
 *
 * 兩個都不是「算錯」——資料全部是對的，錯的是**顯示了一個
 * 在那些列上永遠是同一個值的欄位**，於是它看起來像測量結果。
 * 規則在 `domain/graph/render-rules.ts`，這裡驗它真的送到前端。
 */
describe('面板上哪幾欄有意義', () => {
  it('機器抽的具名關係：四樣都有', async () => {
    const d = await detail('edg-acquire');
    expect(d.fields).toEqual({
      status: true,
      tier: true,
      evidenceFacts: true,
      adjudication: true,
    });
  });

  it('共同提及線：四樣都沒有 —— 標題旁邊不會寫「待查證」', async () => {
    const d = await detail('edg-mention-0');
    expect(d.fields.status).toBe(false);
    expect(d.fields.adjudication).toBe(false);
  });

  it('人手動建的邊：裁決得動，但**沒有可信度也沒有構成事實**', async () => {
    const created = (
      await post(`/api/cases/${slug}/edges`, {
        source: 'itm-focus',
        target: 'itm-quiet',
        rel: '後續報導',
      })
    ).data as EdgeDetailShape;
    expect(created.fields.adjudication).toBe(true);
    expect(created.fields.status).toBe(true);
    // 那個 1 是為了線寬，不是量出來的
    expect(created.fields.tier).toBe(false);
    expect(created.fields.evidenceFacts).toBe(false);
  });
});

// ══ 校準比例是分段的 ═══════════════════════════════════════

/**
 * ADR-0017 的「段」＝ **`edge.rel` × 可信度等級**，而那一份的
 * 「考慮過但沒選的」**明確否決了全域平均**。
 *
 * **這一段是 2026-09-08 對照文件時發現的落差固化。**
 * 實作第一版寫成全域的，而上面那組校準測試全綠 ——
 * 因為它餵進去的 30 條剛好各有各的 `rel`，
 * **分段與不分段在那批資料上看起來一樣合理**。
 */
describe('校準比例分段（ADR-0017）', () => {
  async function seedSegment(
    prefix: string,
    rel: string,
    confidence: number,
    n: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    await inDb((db) => {
      const insertEdge = db.prepare(
        `INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind,
                           origin, status, confidence, created_at, updated_at)
         VALUES (?, 'named', ?, ?, 'item', ?, 'item', 'machine', 'pending', ?, 1, 1)`,
      );
      const insertEv = db.prepare(
        `INSERT INTO edge_evidence (id, edge_id, item_id, quote, char_start, char_end, created_at)
         VALUES (?, ?, 'itm-partner', '合成引文', 0, 4, 1)`,
      );
      const items = ['itm-focus', 'itm-target', 'itm-claim', 'itm-similar', 'itm-partner'];
      let k = 0;
      for (const a of items) {
        for (const b of items) {
          if (a === b || k >= n) continue;
          const id = `${prefix}-${k}`;
          insertEdge.run(id, rel, a, b, confidence);
          insertEv.run(`evd-${prefix}-${k}`, id);
          ids.push(id);
          k += 1;
        }
      }
    });
    return ids;
  }

  it('另一個 `rel` 的裁決不算進這一段', async () => {
    // 「任職於」那一段裁滿 20 條，全部確認
    const other = await seedSegment('edg-other', '任職於', 0.85, 20);
    for (const id of other) await actOk(id, 'confirm');

    // 「收購」那一段仍然只有它自己 —— 樣本遠不足 30
    const d = await detail('edg-acquire');
    expect(d.calibration.kind).toBe('insufficient-sample');
    expect(d.calibration.sampleSize).toBeLessThan(20);
  });

  it('同一個 `rel` 但不同等級也是不同段', async () => {
    // 「收購」＋ 弱（0.2），跟 edg-acquire 的「收購」＋ 強不同段
    const weak = await seedSegment('edg-weak', '收購', 0.2, 20);
    for (const id of weak) await actOk(id, 'confirm');

    const d = await detail('edg-acquire');
    expect(d.calibration.sampleSize).toBeLessThan(20);
  });
});
