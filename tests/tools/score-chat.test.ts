import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let folder = '';
const originalArgs = process.argv;

afterEach(async () => {
  process.argv = originalArgs;
  vi.restoreAllMocks();
  if (folder) await rm(folder, { recursive: true, force: true });
});

it.each([false, true])('記分支援新抽取格式與舊角度格式（混合舊格式：%s）', async (legacy) => {
  folder = await mkdtemp(join(tmpdir(), 'score-chat-'));
  const extracts = [
    {
      schemaOk: true,
      entities: 2,
      relations: 1,
      quotesFound: 1,
      typeSpread: 1,
      ms: 10,
      why: null,
      lang: 'en',
      promptTokens: null,
      evalTokens: null,
    },
  ];
  const entries: unknown[] = [{ model: 'new-format', raw: { extracts } }];
  if (legacy)
    entries.push({
      model: 'old-format',
      raw: {
        extracts,
        angles: [
          {
            schemaOk: true,
            kept: 1,
            seedRefsValid: 1,
            seedRefsTotal: 1,
            maxPairSimilarity: null,
            topicSimilarity: null,
            driftedAngles: null,
            ms: 10,
            why: null,
            sample: [],
          },
        ],
      },
      angles: { samples: ['old-sample'] },
    });
  const input = join(folder, 'results.json');
  await writeFile(input, JSON.stringify(entries), 'utf8');
  process.argv = [process.execPath, 'score-chat.ts', input];
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.resetModules();
  await import('../../tools/research/score-chat.js');
  const text = output.mock.calls.flat().join('\n');
  expect(text).toContain('new-format');
  expect(text).toContain('抽取');
  expect(text.includes('=== 角度樣本 ===')).toBe(legacy);
  if (legacy) expect(text).toContain('old-sample');
});
