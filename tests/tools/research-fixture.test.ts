/**
 * `tools/dev/research-fixture.ts`（B4）：每一種狀態寫進一個空專題，**用真的研究畫面服務讀回來**。
 *
 * 要釘住的是「這支工具寫出來的東西，畫面讀得懂」—— 研究的資料表改了而這支沒跟著改，
 * 截圖那天才發現它寫出來的是一個畫面打不開的研究，就太晚了。
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCase } from '../../src/application/case-service.js';
import { getResearchView } from '../../src/application/research-service.js';
import { forgetSwept } from '../../src/application/run-sweep.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import {
  SEED_STATES,
  writeResearchState,
  type SeedState,
} from '../../tools/dev/research-fixture.js';

let sandbox: string;
let dataRoot: string;
let savedLocalAppData: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-seed-research-'));
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(join(sandbox, 'LocalAppData'), { recursive: true });
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'LocalAppData');
  forgetSwept();
});

afterEach(async () => {
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

async function seed(state: SeedState) {
  const created = await createCase(dataRoot, { name: `合成研究 ${state}` });
  if (!created.ok) throw new Error(created.code);
  const slug = created.data.slug;
  const folder = join(dataRoot, 'cases', slug);
  const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  try {
    const summary = await writeResearchState(opened.db, folder, state);
    const view = await getResearchView(dataRoot, slug, summary.researchId);
    if (!view.ok) throw new Error(view.code);
    return { summary, view: view.data };
  } finally {
    opened.db.close();
  }
}

describe('研究各狀態的合成資料，畫面讀得懂', () => {
  // 一個狀態一條：七種擠在同一條測試裡，在 CI 的 4 核 runner 上要 50～60 秒、撞到時間上限（2026-10-10）。
  // 拆開之後每條各自計時，失敗時也看得出是哪一種狀態。
  it.each(SEED_STATES)('%s：寫得進去、讀回來就是那個狀態', async (state) => {
    const { view } = await seed(state);
    expect(view.status, state).toBe(state);
    expect(view.topic.startsWith('合成'), state).toBe(true);
  });

  it('規劃中：兩輪對話、四條方向（一條是人提的）、刻意不查的範圍', async () => {
    const { view } = await seed('planning');
    expect(view.messages).toHaveLength(2);
    expect(view.plan.directions).toHaveLength(4);
    expect(view.plan.directions.filter((d) => d.origin === 'human')).toHaveLength(1);
    expect(view.plan.outOfScope.length).toBeGreaterThan(0);
  });

  it('等你：八列候選，抓到、上傳、要你拿、拿不到都有；抓到的有初讀', async () => {
    const { view } = await seed('awaiting-user');
    const kinds = new Set(view.candidates.map((c) => c.acquisition));
    expect(view.candidates).toHaveLength(8);
    for (const kind of ['fetched', 'uploaded', 'needs-user', 'unavailable']) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }
    expect(view.candidates.filter((c) => c.relevance !== null).length).toBeGreaterThan(3);
  });

  it('確認中：兩列人改過的決定、一列書目引用、缺口評估', async () => {
    const { view } = await seed('reviewing');
    expect(view.candidates.filter((c) => c.decision !== null)).toHaveLength(2);
    expect(view.candidates.filter((c) => c.citedBy.length > 0)).toHaveLength(1);
    expect(view.gap?.opinion.startsWith('合成')).toBe(true);
  });

  it('完成：抽出來的關聯對得回原文（有寫進去），書目節點建好，人改成進圖的那一份也抽了', async () => {
    const { summary, view } = await seed('done');
    expect(summary.edges).toBeGreaterThan(0);
    expect(view.build.done).toBe(8);
    expect(view.candidates.every((c) => c.buildState === 'done')).toBe(true);
    // 「在關聯圖上看這一次新增的」的焦點（R22）：寫進最多關聯的那一份。
    expect(view.build.focusItemId).not.toBeNull();
  });

  it('停在半路的兩種：蒐集與建圖的作業被掃成停在半路，研究還在那一步', async () => {
    const collecting = await seed('collecting');
    expect(collecting.view.collect.live).toBe(false);
    expect(collecting.view.candidates.length).toBeGreaterThan(0);
    const building = await seed('building');
    expect(building.view.build.live).toBe(false);
    expect(building.view.build.done).toBe(1);
  });
});
