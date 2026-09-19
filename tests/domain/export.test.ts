/**
 * 證據包的純函式。
 *
 * **這一份要證明的是一件事：那份檔案不會比它背後的資料乾淨。**
 *
 * 匯出最容易出的錯不是崩潰，是**安靜地變好看** ——
 * 回溯不到的引文被省略、位置漂掉的引文照樣印一個看起來精確的數字、
 * 投影出來的線混進真的關聯裡。三種都不會有任何一個測試自然地失敗，
 * 而三種都會讓一份拿去給別人看的檔案在說謊。
 */
import { describe, expect, it } from 'vitest';

import {
  checkQuote,
  countMissing,
  countQuotes,
  evidenceRows,
  packFolderName,
  renderJsonl,
  renderPack,
  renderSources,
  type EvidencePack,
  type PackEdge,
  type PackQuote,
} from '../../src/domain/export/index.js';

// ── checkQuote ────────────────────────────────────────────

describe('checkQuote：不採信自己資料庫裡存的位置', () => {
  const text = '第一段講的是別的事。\n\n台積電在二○二四年收購了那家公司。\n\n最後一段。';
  const quote = '台積電在二○二四年收購了那家公司。';
  const start = text.indexOf(quote);
  const end = start + quote.length;

  it('位置對得上就是已核對', () => {
    expect(checkQuote(text, quote, start, end)).toEqual({ status: 'verified', start, end });
  });

  it('正文重算過、整段往後移了 —— 引文還在，所以是位置已移動', () => {
    const shifted = `多了一段前言。\n\n${text}`;
    const check = checkQuote(shifted, quote, start, end);
    expect(check.status).toBe('shifted');
    expect(shifted.slice(check.start, check.end)).toBe(quote);
  });

  it('引文根本不在正文裡 —— 回溯不到', () => {
    expect(checkQuote(text, '這一句從來沒有出現過。', 0, 10).status).toBe('missing');
  });

  it('回溯不到的時候位置退回紀錄裡那一組，不是 0', () => {
    const check = checkQuote(text, '沒有這一句喔喔喔喔。', 4096, 4108);
    expect(check).toEqual({ status: 'missing', start: 4096, end: 4108 });
  });

  it('derived 讀不到就是回溯不到 —— 不是「引文不對」，是沒有東西可以對', () => {
    expect(checkQuote(null, quote, start, end).status).toBe('missing');
  });

  it('紀錄的位置超出正文長度不會爆炸', () => {
    expect(checkQuote('短', quote, 0, 9999).status).toBe('missing');
  });

  it('空白不同視為同一段（跟 v0.5.0／v0.6.0 同一支比對）', () => {
    const reflowed = text.replace(/\n\n/g, '\n');
    const check = checkQuote(reflowed, quote, start, end);
    expect(['verified', 'shifted']).toContain(check.status);
    expect(reflowed.slice(check.start, check.end)).toBe(quote);
  });

  /**
   * v0.24.0 的 PDF 重排：硬換行變成空白，字數不變 —— 引文還在**原來那個位置**。
   * 那是「對得上」，不是「搬家了」；標成位置已移動會讓證據包看起來比實際上亂。
   */
  it('只差空白、而且就在記著的位置上 —— 算已核對，不是位置已移動', () => {
    const before = 'Alpha beta\ngamma delta.';
    const after = 'Alpha beta gamma delta.';
    const recorded = before.slice(6, 16);
    expect(recorded).toBe('beta\ngamma');
    expect(checkQuote(after, recorded, 6, 16)).toEqual({ status: 'verified', start: 6, end: 16 });
    // 位置真的變了的時候仍然是位置已移動。
    const moved = checkQuote(`Intro. ${after}`, recorded, 6, 16);
    expect(moved.status).toBe('shifted');
    expect(moved.start).toBe(13);
  });

  it('countMissing 數的是回溯不到的那幾條', () => {
    expect(
      countMissing([
        { status: 'verified', start: 0, end: 1 },
        { status: 'missing', start: 0, end: 1 },
        { status: 'shifted', start: 0, end: 1 },
        { status: 'missing', start: 0, end: 1 },
      ]),
    ).toBe(2);
  });
});

// ── 造一份包 ──────────────────────────────────────────────

function quoteOf(over: Partial<PackQuote> = {}): PackQuote {
  return {
    itemId: 'itm-1',
    itemTitle: '某份報導',
    quote: '台積電在二○二四年收購了那家公司。',
    status: 'verified',
    start: 100,
    end: 117,
    recordedStart: 100,
    recordedEnd: 117,
    snapshotSha256: 'a'.repeat(64),
    page: null,
    rect: null,
    ...over,
  };
}

function edgeOf(over: Partial<PackEdge> = {}): PackEdge {
  return {
    id: 'edg-1',
    rel: '收購',
    sourceTitle: '台積電',
    targetTitle: '某公司',
    directional: true,
    layer: 'named',
    status: 'confirmed',
    origin: 'machine',
    tier: 'strong',
    evidenceCount: 1,
    independentSourceCount: 1,
    previouslyRejected: false,
    quotes: [quoteOf()],
    ...over,
  };
}

function packOf(over: Partial<EvidencePack> = {}): EvidencePack {
  return {
    caseName: '某個專題',
    focusTitle: '台積電',
    hops: 2,
    exportedAt: Date.UTC(2026, 8, 8, 2, 33, 13),
    nodeCount: 12,
    edgeCount: 1,
    confirmed: [edgeOf()],
    pending: [],
    rejected: [],
    structural: [],
    notes: [],
    sources: [
      {
        id: 'itm-1',
        title: '某份報導',
        kind: 'web',
        lang: 'zh',
        sourceUrl: 'https://example.test/a',
        fetchedAt: Date.UTC(2026, 8, 7),
        sha256: 'a'.repeat(64),
        sourceExt: 'html',
        lowConfidence: false,
        lowConfidenceReasons: [],
      },
    ],
    projectedOmitted: 0,
    ...over,
  };
}

// ── evidence-pack.md ──────────────────────────────────────

describe('evidence-pack.md：每條引文都寫著它回到哪裡', () => {
  it('引文底下有 item 的 id 與字元區間 —— 這就是驗收條件', () => {
    const md = renderPack(packOf());
    expect(md).toContain('`itm-1`');
    expect(md).toContain('字元 100–117');
    expect(md).toContain('> 台積電在二○二四年收購了那家公司。');
  });

  it('快照雜湊也寫出來 —— 回溯的終點是它，不是 item 的 id', () => {
    expect(renderPack(packOf())).toContain('aaaaaaaaaaaa…');
  });

  it('有方向的層畫箭頭，沒方向的不畫', () => {
    expect(renderPack(packOf())).toContain('〈台積電〉 → 〈某公司〉');
    const flat = packOf({
      confirmed: [edgeOf({ directional: false, layer: 'comention', rel: '共同提及' })],
    });
    expect(renderPack(flat)).toContain('〈台積電〉 — 〈某公司〉');
  });

  it('位置移動的那一條把兩組數字都寫出來', () => {
    const md = renderPack(
      packOf({
        confirmed: [edgeOf({ quotes: [quoteOf({ status: 'shifted', start: 240, end: 257 })] })],
      }),
    );
    expect(md).toContain('位置已移動');
    expect(md).toContain('字元 100–117');
    expect(md).toContain('字元 240–257');
  });

  it('回溯不到的那一條**留在檔案裡而且標明** —— 這是這一份最重要的一條', () => {
    const md = renderPack(
      packOf({ confirmed: [edgeOf({ quotes: [quoteOf({ status: 'missing' })] })] }),
    );
    expect(md).toContain('回溯不到');
    // 引文本身照樣印出來，只是說清楚它現在對不上。
    expect(md).toContain('台積電在二○二四年收購了那家公司。');
    expect(md).toContain('不能當成已經驗過的出處');
  });

  it('待查證的那一組要說出「還沒有人裁決過」', () => {
    const md = renderPack(packOf({ confirmed: [], pending: [edgeOf({ status: 'pending' })] }));
    expect(md).toContain('待查證的關聯（1 條）');
    expect(md).toContain('還沒有人裁決過');
  });

  it('已否決的只列一行，不附引文', () => {
    const rejected = edgeOf({
      id: 'edg-9',
      status: 'rejected',
      sourceTitle: '甲',
      targetTitle: '乙',
      rel: '任職於',
      quotes: [],
    });
    const md = renderPack(packOf({ rejected: [rejected] }));
    expect(md).toContain('已否決的關聯（1 條）');
    expect(md).toContain('| 〈甲〉 → 〈乙〉 | 任職於 |');
    expect(md).toContain('會讓人以為每一條都成立');
  });

  it('人手動建的邊沒有引文，而那不是缺陷 —— 說出來', () => {
    const md = renderPack(
      packOf({ confirmed: [edgeOf({ origin: 'human', evidenceCount: 0, quotes: [] })] }),
    );
    expect(md).toContain('人直接建立的主張');
  });

  it('曾被否決過的標出來', () => {
    expect(renderPack(packOf({ confirmed: [edgeOf({ previouslyRejected: true })] }))).toContain(
      '曾被否決過',
    );
  });

  it('投影線沒有匯出這件事要說出來 —— 不然看起來像資料掉了', () => {
    const md = renderPack(packOf({ projectedOmitted: 4 }));
    expect(md).toContain('4 條');
    expect(md).toContain('沒有出處可以附');
  });

  it('沒有投影線的時候不要出現那一節', () => {
    expect(renderPack(packOf())).not.toContain('沒有匯出的');
  });

  it('標題包在〈〉裡 —— 標題裡的方括號不會變成一個連結', () => {
    const md = renderPack(packOf({ confirmed: [edgeOf({ sourceTitle: '[更新] 某事件' })] }));
    expect(md).toContain('〈[更新] 某事件〉');
  });

  it('多行引文的每一行都有引用前綴', () => {
    const md = renderPack(
      packOf({ confirmed: [edgeOf({ quotes: [quoteOf({ quote: '第一行\n第二行' })] })] }),
    );
    expect(md).toContain('> 第一行\n> 第二行');
  });

  it('PDF 的引文帶頁碼', () => {
    const md = renderPack(packOf({ confirmed: [edgeOf({ quotes: [quoteOf({ page: 3 })] })] }));
    expect(md).toContain('第 3 頁');
  });

  it('圖片矩形不印字元區間 —— 它沒有', () => {
    const md = renderPack(
      packOf({
        notes: [
          {
            id: 'not-1',
            body: '這張圖上的角落',
            createdAt: 0,
            quote: quoteOf({ rect: { x: 10, y: 20, w: 30, h: 40 }, quote: '' }),
          },
        ],
      }),
    );
    expect(md).toContain('矩形 10,20 30×40');
  });

  it('點註那一組標明是自己寫的', () => {
    const md = renderPack(
      packOf({ notes: [{ id: 'not-1', body: '我的想法', createdAt: 0, quote: quoteOf() }] }),
    );
    expect(md).toContain('點註（1 則）');
    expect(md).toContain('不是抓回來的');
    expect(md).toContain('我的想法');
  });

  it('其餘三層列成一張表，不排在待查證裡', () => {
    const md = renderPack(
      packOf({
        structural: [
          edgeOf({ id: 'edg-2', layer: 'comention', rel: '提到', directional: false, quotes: [] }),
        ],
      }),
    );
    expect(md).toContain('其餘三層（1 條）');
    expect(md).toContain('不是主張，是機器算出來的結構');
    expect(md).not.toContain('待查證的關聯');
  });

  it('機器提出、沒有引文的具名關係**不會**被說成是人建立的', () => {
    const md = renderPack(
      packOf({ confirmed: [edgeOf({ origin: 'machine', evidenceCount: 0, quotes: [] })] }),
    );
    expect(md).not.toContain('人直接建立的主張');
    expect(md).toContain('確認不了');
  });

  it('待查證那一組全都沒有引文的時候，不要說「它們帶著引文」', () => {
    const md = renderPack(
      packOf({ confirmed: [], pending: [edgeOf({ status: 'pending', quotes: [] })] }),
    );
    expect(md).not.toContain('它們帶著引文');
    expect(md).toContain('一條引文都沒有');
  });

  it('沒有快照的時候不要印一個空的程式碼片段', () => {
    const md = renderPack(
      packOf({ confirmed: [edgeOf({ quotes: [quoteOf({ snapshotSha256: null })] })] }),
    );
    expect(md).toContain('沒有快照');
    expect(md).not.toContain('`（沒有快照）`');
  });

  it('摘要那三個數字分開列，不合成一個', () => {
    const md = renderPack(
      packOf({
        confirmed: [
          edgeOf({
            quotes: [quoteOf(), quoteOf({ status: 'shifted' }), quoteOf({ status: 'missing' })],
          }),
        ],
      }),
    );
    expect(md).toContain('引文 3 條：已核對 1、位置已移動 1、回溯不到 1');
  });

  it('countQuotes 不數已否決的', () => {
    const counts = countQuotes(packOf({ rejected: [edgeOf({ status: 'rejected' })] }));
    expect(counts.total).toBe(1);
  });

  it('結尾是一個換行，而且沒有三個連續換行', () => {
    const md = renderPack(packOf());
    expect(md.endsWith('\n')).toBe(true);
    expect(md).not.toMatch(/\n{3}/);
  });
});

// ── sources.md ────────────────────────────────────────────

describe('sources.md：抓回來的與自己寫的分開', () => {
  it('抓回來的列出網址、抓取時間與快照檔名', () => {
    const md = renderSources(packOf());
    expect(md).toContain('https://example.test/a');
    expect(md).toContain('sources\\' + 'a'.repeat(64) + '.html');
    expect(md).toContain('2026-09-07');
  });

  it('本機檔案沒有網址，說出來而不是留白', () => {
    const md = renderSources(
      packOf({
        sources: [
          {
            id: 'itm-2',
            title: '一份 PDF',
            kind: 'pdf',
            lang: 'und',
            sourceUrl: null,
            fetchedAt: null,
            sha256: null,
            sourceExt: null,
            lowConfidence: false,
            lowConfidenceReasons: [],
          },
        ],
      }),
    );
    expect(md).toContain('本機檔案，沒有網址');
  });

  it('抽取信心低的標出來，而且說出原因', () => {
    const md = renderSources(
      packOf({
        sources: [
          {
            id: 'itm-3',
            title: '一頁',
            kind: 'web',
            lang: 'zh',
            sourceUrl: 'https://example.test/b',
            fetchedAt: 0,
            sha256: 'b'.repeat(64),
            sourceExt: 'html',
            lowConfidence: true,
            lowConfidenceReasons: ['段落太少', '連結密度高'],
          },
        ],
      }),
    );
    expect(md).toContain('抽取信心低**：段落太少、連結密度高');
  });

  it('點註不在「抓回來的」那一組裡', () => {
    const md = renderSources(
      packOf({ notes: [{ id: 'not-1', body: '想法', createdAt: 0, quote: null }] }),
    );
    const fetched = md.slice(md.indexOf('## 抓回來的'), md.indexOf('## 自己寫的'));
    expect(fetched).not.toContain('not-1');
    expect(md).toContain('## 自己寫的');
  });

  it('一份來源都沒有的時候說出來，不留一個空標題', () => {
    expect(renderSources(packOf({ sources: [] }))).toContain('沒有抓回來的資料');
  });
});

// ── evidence.jsonl ────────────────────────────────────────

describe('evidence.jsonl：驗收條件的可執行版本', () => {
  it('每一列都有 itemId 與字元區間', () => {
    const rows = evidenceRows(packOf());
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row.itemId.length).toBeGreaterThan(0);
      expect(Number.isInteger(row.charStart)).toBe(true);
      expect(Number.isInteger(row.charEnd)).toBe(true);
      expect(row.charEnd).toBeGreaterThanOrEqual(row.charStart);
    }
  });

  it('已否決的不進這一份 —— 核對一條你已經否決的沒有意義', () => {
    const rows = evidenceRows(packOf({ rejected: [edgeOf({ id: 'edg-9', status: 'rejected' })] }));
    expect(rows.map((r) => r.ownerId)).toEqual(['edg-1']);
  });

  it('點註的引文也在裡面，而且標成 note', () => {
    const rows = evidenceRows(
      packOf({ notes: [{ id: 'not-1', body: '想法', createdAt: 0, quote: quoteOf() }] }),
    );
    expect(rows.map((r) => r.kind)).toEqual(['edge', 'note']);
  });

  it('紀錄的位置與現在的位置兩組都留著', () => {
    const [row] = evidenceRows(
      packOf({
        confirmed: [edgeOf({ quotes: [quoteOf({ status: 'shifted', start: 5, end: 22 })] })],
      }),
    );
    expect(row?.charStart).toBe(5);
    expect(row?.recordedStart).toBe(100);
  });

  it('每行是一個獨立的 JSON', () => {
    const text = renderJsonl(evidenceRows(packOf()));
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
  });

  it('一列都沒有的時候是空字串，不是一個空行', () => {
    expect(renderJsonl([])).toBe('');
  });
});

// ── 資料夾名 ──────────────────────────────────────────────

describe('資料夾名帶時區', () => {
  it('20260908-023313Z', () => {
    expect(packFolderName(Date.UTC(2026, 8, 8, 2, 33, 13))).toBe('20260908-023313Z');
  });

  it('每一段都補零', () => {
    expect(packFolderName(Date.UTC(2026, 0, 1, 0, 0, 5))).toBe('20260101-000005Z');
  });
});
