/**
 * 守門：**規模合成語料真的走得到它宣稱走得到的那幾條路。**
 *
 * ## 為什麼一份「開發工具」需要測試
 *
 * v0.12.0 的六項效能預算全部是在這份語料上量的。語料的形狀一歪，
 * **量出來的數字仍然是一個數字，而它描述的是另一個東西** ——
 * 沒有任何地方會報錯。
 *
 * 2026-09-10 之前這個 repo 已經被同一種形狀咬過一次：一份 97 個字的文件
 * 因為 `detectLanguage` 回 `und`、`isCjkLanguage('und')` 是 `false`
 * 而套到拉丁那組的 `min 320`，**切出零段、沒有向量、而回填永遠跑不完**。
 * 那次是真的資料太短；這次的風險反過來 —— **合成資料是知道規則的人產生的，
 * 天生落在規則的正常路徑上**，於是一條壞掉的路徑不會被踩到。
 *
 * 所以這幾條測的不是「產得對不對」，是**「產出來的東西會不會讓量測失去意義」**：
 * 切不出段落 → 向量數遠少於預期 → 「掃 N 條要多久」的 N 是錯的；
 * 詞太分散 → 任何查詢詞的貼文串都很短 → 全文那一項量到的是最好走的那條路。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { chunkText, MAX_CHUNKS_PER_ITEM } from '../../src/domain/search/chunk.js';
import { bigrams, cjkRatio } from '../../src/domain/search/tokenize.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import {
  buildVocab,
  makeText,
  pickZipf,
  rng,
  textLength,
  writeScaleFixture,
  zipfCdf,
} from '../../tools/dev/scale-fixture.js';

function corpus(docs: number): string[] {
  const r = rng(20260910);
  const vocab = buildVocab(2_000, 7);
  const cdf = zipfCdf(vocab.length, 0.9);
  const out: string[] = [];
  for (let i = 0; i < docs; i += 1) {
    const topic: string[] = [];
    for (let t = 0; t < 10; t += 1) topic.push(vocab[pickZipf(cdf, r)] as string);
    out.push(makeText(vocab, cdf, topic, textLength(r), r));
  }
  return out;
}

describe('規模合成語料', () => {
  it('切得出多段 —— 不是每份都掉進「整份當一段」的退路', () => {
    const docs = corpus(60);
    const counts = docs.map((d) => chunkText(d, MAX_CHUNKS_PER_ITEM).length);

    // 一段都切不出來的話，`chunkText` 的退路會補一段整份的 ——
    // **那條路存在是為了 97 個字的短文，不是為了 1,400 個字的文章。**
    expect(Math.min(...counts)).toBeGreaterThan(0);

    // 平均要**明顯多於 1**，否則「每份文件最多 6 段」這個上限根本沒被碰到，
    // 而 ADR-0026 要重新量的就是那個上限。
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    expect(mean).toBeGreaterThan(2);
    expect(Math.max(...counts)).toBe(MAX_CHUNKS_PER_ITEM);
  });

  it('是中文 —— 走 bigram 那條路，不是 FTS5 那條', () => {
    // 走錯路的話全文那一項量到的是另一個索引。
    for (const doc of corpus(10)) expect(cjkRatio(doc)).toBeGreaterThan(0.5);
  });

  it('詞的分布是偏的 —— 有很常見的，也有幾乎不出現的', () => {
    const docs = corpus(120);
    const perDoc = docs.map((d) => new Set(bigrams(d).keys()));
    const seen = new Map<string, number>();
    for (const set of perDoc) for (const g of set) seen.set(g, (seen.get(g) ?? 0) + 1);

    const sorted = [...seen.values()].sort((a, b) => b - a);
    const top = sorted[0] as number;

    // 最常見的那個 gram 要出現在**大部分**文件裡。沒有這種詞的話，
    // 「中文 2 字詞 < 300 ms」量到的永遠是短貼文串那個好走的情形。
    expect(top / docs.length).toBeGreaterThan(0.5);

    // 而且尾巴要夠長 —— 只有常見詞的語料，貼文串長度沒有級距可挑。
    const rare = sorted.filter((n) => n === 1).length;
    expect(rare).toBeGreaterThan(sorted.length * 0.3);
  });

  it('長度是偏的 —— 大多數一般長，尾巴上有很長的', () => {
    const r = rng(99);
    const lengths: number[] = [];
    for (let i = 0; i < 4_000; i += 1) lengths.push(textLength(r));
    lengths.sort((a, b) => a - b);

    const median = lengths[Math.floor(lengths.length / 2)] as number;
    const p99 = lengths[Math.floor(lengths.length * 0.99)] as number;

    // 中位數是一篇文章的長度，不是一則推文也不是一本書。
    expect(median).toBeGreaterThan(500);
    expect(median).toBeLessThan(2_000);
    // **尾巴要真的存在** —— 每份都一樣長的語料，切段那一步沒有變異，
    // 而「每份平均幾段」就變成一個假的常數。
    expect(p99).toBeGreaterThan(median * 3);
  });

  it('同一個種子產生同一份語料', () => {
    // 「沒有量測條件的數字不算數」—— **語料本身就是量測條件的一部分。**
    expect(corpus(3)).toEqual(corpus(3));
  });

  it('寫得進現在的 schema —— migration 改了，這支要跟著改', async () => {
    // 2026-09-30 要用 768 維重量 ADR-0028 的時候才發現：schema v10 把 item 的 `paper` 換成 `reference`，
    // 而這支還在寫 `paper`，**寫到第一批就被 CHECK 擋下**。上面幾條只測產生正文的函式，
    // 從來沒有往一個真的資料庫寫過 —— 所以 v10 出貨之後它就寫不進去，而沒有任何一條測試紅。
    const sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-scale-fixture-'));
    try {
      const opened = await openCaseDatabase(join(sandbox, 'case.sqlite'), { create: true });
      if (opened.kind !== 'ok') throw new Error('開不了資料庫：' + opened.kind);
      try {
        const stats = await writeScaleFixture(
          opened.db,
          sandbox,
          {
            items: 36,
            entities: 12,
            edges: 60,
            seed: 20260910,
            vocabSize: 400,
            maxChunks: 2,
            embedModel: 'fake-embed',
            embedDim: 8,
          },
          () => {},
        );
        expect(stats.items).toBe(36);
        expect(stats.vectors).toBeGreaterThan(0);
        const rows = opened.db.prepare('SELECT COUNT(*) AS n FROM item').get() as { n: number };
        expect(Number(rows.n)).toBe(36);
      } finally {
        opened.db.close();
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
