import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server.js';
import {
  cancelRun,
  isActive,
  pauseRun,
  replayOf,
  startFileImport,
} from '../../src/application/ingest-service.js';
import { getRun, listRuns } from '../../src/application/run-service.js';
import { MAX_UPLOAD_BYTES } from '../../src/domain/ingest/upload.js';

let app: FastifyInstance;
let sandbox = '';
let dataRoot = '';
let slug = '';
let savedLocalAppData: string | undefined;
const activeIds: string[] = [];

interface Batch {
  runId: string;
  items: { runItemId: string; name: string }[];
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-file-batch-'));
  dataRoot = join(sandbox, 'data');
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'local');
  app = (await buildServer()).app;
  await app.ready();
  const initialized = await app.inject({
    method: 'POST',
    url: '/api/system/data-root',
    payload: { dataRoot },
  });
  expect(initialized.statusCode, initialized.body).toBe(200);
  const created = await app.inject({
    method: 'POST',
    url: '/api/cases',
    payload: { name: '批次上傳驗收' },
  });
  expect(created.statusCode, created.body).toBe(200);
  slug = (created.json() as { data: { slug: string } }).data.slug;
});

afterEach(async () => {
  for (const runId of activeIds.splice(0)) if (isActive(runId)) cancelRun(runId);
  await app?.close();
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

async function start(names: string[]): Promise<Batch> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/cases/${slug}/import/files`,
    payload: { names },
  });
  expect(response.statusCode).toBe(200);
  const batch = (response.json() as { data: Batch }).data;
  activeIds.push(batch.runId);
  expect(batch.items.map((entry) => entry.name)).toEqual(names);
  return batch;
}

async function upload(batch: Batch, index: number, fileName?: string) {
  const entry = batch.items[index]!;
  return app.inject({
    method: 'POST',
    url: `/api/cases/${slug}/import/files/${batch.runId}/${entry.runItemId}`,
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(fileName ?? entry.name),
    },
    payload: Buffer.from(
      `第 ${index} 份測試資料。這是用來驗證批次檔案匯入、快照與索引的正文。`.repeat(20),
    ),
  });
}

async function detail(runId: string) {
  const result = await getRun(dataRoot, slug, runId);
  if (!result.ok) throw new Error(result.code);
  return result.data;
}

describe('一批檔案是一筆作業', () => {
  it('三檔中一個格式不支援：同一筆 SSE 進度，最後部分完成', async () => {
    const batch = await start(['甲.txt', '不支援.exe', '乙.txt']);
    expect(isActive(batch.runId)).toBe(true);
    expect((await detail(batch.runId)).run.label).toBe('3 個檔案');
    await upload(batch, 0);
    expect(
      replayOf(batch.runId).some(
        (event) => event.type === 'progress' && event.done === 1 && event.total === 3,
      ),
    ).toBe(true);
    await upload(batch, 1);
    await upload(batch, 2);
    const result = await detail(batch.runId);
    expect(result.run).toMatchObject({ status: 'partial', succeeded: 2, failed: 1, live: false });
    expect(result.items.find((entry) => entry.requested === '不支援.exe')).toMatchObject({
      outcome: 'failed',
      code: 'FETCH_UNSUPPORTED_TYPE',
    });
    const all = await listRuns(dataRoot, slug);
    expect(all.ok && all.data.length).toBe(1);
    expect((await upload(batch, 2)).statusCode).toBe(409);
  });

  it('傳到一半取消：保留成功的，未傳列取消，晚到的上傳拒絕', async () => {
    const batch = await start(['甲.txt', '乙.txt', '丙.txt']);
    await upload(batch, 0);
    const response = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/runs/${batch.runId}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    const result = await detail(batch.runId);
    expect(result.run).toMatchObject({
      status: 'cancelled',
      succeeded: 1,
      failed: 0,
      endedReason: null,
      live: false,
    });
    expect(result.items.filter((entry) => entry.outcome === 'cancelled')).toHaveLength(2);
    const late = await upload(batch, 1);
    expect(late.statusCode).toBe(409);
    // 不是 GRAPH_TRANSITION_INVALID：那一條叫人交識別碼，而按了取消是正常操作
    expect(late.json()).toMatchObject({ code: 'RUN_ALREADY_SETTLED' });
  });

  it('傳到一半放著不管：閒置收尾有原因，不冒充使用者取消', async () => {
    const started = await startFileImport(dataRoot, slug, ['甲.txt', '乙.txt'], 1000);
    if (!started.ok) throw new Error(started.code);
    const batch = started.data;
    activeIds.push(batch.runId);
    await upload(batch, 0);
    await expect.poll(() => isActive(batch.runId), { timeout: 5000 }).toBe(false);
    const result = await detail(batch.runId);
    expect(result.run).toMatchObject({ status: 'partial', succeeded: 1, failed: 1, live: false });
    expect(result.items.find((entry) => entry.requested === '乙.txt')).toMatchObject({
      outcome: 'failed',
      code: 'FETCH_UPLOAD_TIMEOUT',
    });
    const late = await upload(batch, 1);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ code: 'RUN_ALREADY_SETTLED' });
  });

  it('全成功、全失敗與重複上傳各自有明確結果', async () => {
    const good = await start(['甲.txt', '乙.txt']);
    await upload(good, 0);
    expect((await upload(good, 0)).statusCode).toBe(409);
    expect((await upload(good, 1, '不是乙.txt')).statusCode).toBe(409);
    await upload(good, 1);
    expect((await detail(good.runId)).run.status).toBe('done');
    const bad = await start(['甲.exe', '乙.exe']);
    await upload(bad, 0);
    await upload(bad, 1);
    expect((await detail(bad.runId)).run).toMatchObject({ status: 'failed', failed: 2 });
  });

  it('連第一個檔案也沒傳：閒置後全失敗；空清單不開作業', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/import/files`,
      payload: { names: [] },
    });
    expect(empty.statusCode).toBe(400);
    const started = await startFileImport(dataRoot, slug, ['甲.txt'], 30);
    if (!started.ok) throw new Error(started.code);
    activeIds.push(started.data.runId);
    await expect.poll(() => isActive(started.data.runId)).toBe(false);
    expect((await detail(started.data.runId)).run).toMatchObject({
      status: 'failed',
      succeeded: 0,
      failed: 1,
    });
  });

  it('暫停中已收到的上傳也能取消，不會用到已關閉的資料庫', async () => {
    const batch = await start(['甲.txt', '乙.txt']);
    expect(pauseRun(batch.runId).ok).toBe(true);
    const pending = upload(batch, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cancelRun(batch.runId).ok).toBe(true);
    expect((await pending).statusCode).toBe(409);
    expect((await detail(batch.runId)).items.every((entry) => entry.outcome === 'cancelled')).toBe(
      true,
    );
  });

  it('空檔案是該列失敗，下一個檔案仍能完成', async () => {
    const batch = await start(['空.txt', '乙.txt']);
    const response = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/import/files/${batch.runId}/${batch.items[0]!.runItemId}`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent('空.txt'),
      },
      payload: Buffer.alloc(0),
    });
    expect(response.statusCode).toBe(200);
    await upload(batch, 1);
    const result = await detail(batch.runId);
    expect(result.run).toMatchObject({ status: 'partial', succeeded: 1, failed: 1 });
    expect(result.items.find((entry) => entry.requested === '空.txt')?.code).toBe(
      'PARSE_EMPTY_CONTENT',
    );
  });
});

/**
 * **超過上傳上限的檔案**（2026-10-02）。原本整個 server 只有 32 MB 的 `bodyLimit`，超過時
 * Fastify 自己丟錯、落到 `IO_UNEXPECTED`，而那一列沒有結果 —— 整批要等閒置逾時、原因被寫成
 * 「等不到這個檔案」。現在前端開批次時報大小，超過的那一列當場標掉、前端不傳。
 */
describe('超過上傳上限的檔案', () => {
  async function startWithSizes(names: string[], sizes: number[]) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/import/files`,
      payload: { names, sizes },
    });
    expect(response.statusCode, response.body).toBe(200);
    const batch = (
      response.json() as {
        data: {
          runId: string;
          items: { runItemId: string; name: string; rejected: string | null }[];
        };
      }
    ).data;
    activeIds.push(batch.runId);
    return batch;
  }

  it('那一列當場失敗、回 rejected；其餘照傳，整批部分完成', async () => {
    const batch = await startWithSizes(
      ['甲.txt', '巨大.pdf', '乙.txt'],
      [100, MAX_UPLOAD_BYTES + 1, 100],
    );
    expect(batch.items.map((entry) => entry.rejected)).toEqual([
      null,
      'FETCH_UPLOAD_TOO_LARGE',
      null,
    ]);
    await upload(batch, 0);
    await upload(batch, 2);
    const result = await detail(batch.runId);
    expect(result.run).toMatchObject({ status: 'partial', succeeded: 2, failed: 1, live: false });
    expect(result.items.find((entry) => entry.requested === '巨大.pdf')).toMatchObject({
      outcome: 'failed',
      code: 'FETCH_UPLOAD_TOO_LARGE',
    });
  });

  it('全部都超過：沒有東西可等，當場收尾（不等閒置逾時）', async () => {
    const batch = await startWithSizes(['巨大.pdf'], [MAX_UPLOAD_BYTES + 1]);
    expect(isActive(batch.runId)).toBe(false);
    expect((await detail(batch.runId)).run).toMatchObject({ status: 'failed', failed: 1 });
  });

  it('沒報大小（舊的前端）照舊收；報了不合法的值當成不知道', async () => {
    const batch = await startWithSizes(['甲.txt'], [-1]);
    expect(batch.items[0]?.rejected).toBeNull();
    await upload(batch, 0);
    expect((await detail(batch.runId)).run).toMatchObject({ status: 'done', succeeded: 1 });
  });
});
