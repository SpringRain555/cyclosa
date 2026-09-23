/**
 * `domain/provider` 的純函式。
 *
 * 這一份測的四件事**每一件都是「模型講的話不能照收」的一個面向**：
 * 能力配對缺什麼、上限怎麼算、輸出怎麼正規化、引文的位置由誰決定。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUDGET,
  EMPTY_BUDGET_STATE,
  MAX_ANGLES,
  MAX_URLS_PER_ANGLE,
  MIN_QUOTE_CHARS,
  NO_CAPABILITIES,
  SANDBOX_ALLOWED_EXTENSIONS,
  TASK_ANGLES,
  TASK_FIND_SOURCES,
  charge,
  entityKey,
  locateQuote,
  mayContinue,
  missingFor,
  normalizeAngles,
  normalizeCandidates,
  normalizeExtraction,
  sandboxViolations,
  type ProviderCapabilities,
} from '../../src/domain/provider/index.js';

const FULL: ProviderCapabilities = {
  browse: true,
  tools: true,
  json_schema: true,
  vision: true,
  context_tokens: 200_000,
};

describe('能力配對', () => {
  it('全都有就是 ok', () => {
    expect(missingFor(TASK_FIND_SOURCES, FULL)).toEqual({ kind: 'ok' });
  });

  it('**回的是缺哪幾樣，不是一個布林**', () => {
    const result = missingFor(TASK_FIND_SOURCES, { ...FULL, browse: false });
    expect(result).toEqual({ kind: 'missing', flags: ['browse'], context: null });
  });

  it('沒設定任何 provider 時，缺的是這個任務要的每一樣', () => {
    const result = missingFor(TASK_ANGLES, NO_CAPABILITIES);
    expect(result.kind).toBe('missing');
    if (result.kind === 'missing') expect(result.flags).toEqual(['json_schema']);
  });

  /**
   * **`context_tokens: 0` 是「不知道」不是「只有 0 個」。**
   *
   * 兩種錯法的代價不對稱：擋掉一個其實跑得動的 provider，
   * 使用者無從得知要去改什麼（能力宣告是我們寫的）；
   * 放行一個其實不夠大的，會拿到一個來自 provider 自己的明確錯誤。
   */
  it('context_tokens 是 0 的時候放行', () => {
    expect(missingFor(TASK_ANGLES, { ...FULL, context_tokens: 0 })).toEqual({ kind: 'ok' });
  });

  it('context_tokens 有值但不夠大的時候擋下來，而且說出兩個數字', () => {
    const result = missingFor(TASK_ANGLES, { ...FULL, context_tokens: 2048 });
    expect(result).toEqual({ kind: 'missing', flags: [], context: [8000, 2048] });
  });

  /** 產生視角不需要上網 —— 它是**從既有內容歸納**的（STORM）。 */
  it('產生視角不要求 browse', () => {
    expect(TASK_ANGLES.needs).not.toContain('browse');
  });
});

describe('三種上限', () => {
  it('請求數是主要上限', () => {
    const state = { ...EMPTY_BUDGET_STATE, requests: DEFAULT_BUDGET.maxRequests };
    expect(mayContinue(state, DEFAULT_BUDGET)).toEqual({
      kind: 'requests',
      limit: DEFAULT_BUDGET.maxRequests,
    });
  });

  it('牆鐘逾時是第二道', () => {
    const state = { ...EMPTY_BUDGET_STATE, elapsedMs: DEFAULT_BUDGET.timeoutMs };
    expect(mayContinue(state, DEFAULT_BUDGET).kind).toBe('time');
  });

  /**
   * **`null` 與 0 是兩件事。** 本機模型的金額成本真的是 0；
   * 一個沒回報成本的 provider 是「不知道」。
   * `charge` 收到 `null` 時不可以把 `costUsd` 從 `null` 變成 0。
   */
  it('provider 沒回報成本時，累計金額維持「不知道」', () => {
    const after = charge(charge(EMPTY_BUDGET_STATE, null, 10), null, 20);
    expect(after.requests).toBe(2);
    expect(after.costUsd).toBeNull();
  });

  it('回報過就開始累計，之後再遇到沒回報的也不會退回 null', () => {
    const after = charge(charge(EMPTY_BUDGET_STATE, 0.18, 10), null, 20);
    expect(after.costUsd).toBeCloseTo(0.18);
  });

  /**
   * **「花了 $0.18」與「花了 $0.18，另外 1 次不知道」是兩句話**（schema v10 的 `run.unpriced`）。
   * 一次研究可能同時走回報金額的 Claude Code 與不回報的 OpenAI 相容 API，
   * 只留加總的話，後者那幾次就安靜地變成了 0。
   */
  it('沒回報的那幾次另外數，回報過的不算進去', () => {
    const after = charge(charge(charge(EMPTY_BUDGET_STATE, 0.18, 10), null, 20), 0, 30);
    expect(after.requests).toBe(3);
    expect(after.unpriced).toBe(1);
    // 本機模型回報的 0 是真的 0 —— 不是「不知道」
    expect(charge(EMPTY_BUDGET_STATE, 0, 5).unpriced).toBe(0);
  });

  it('金額上限只在有實際值時才擋', () => {
    const budget = { ...DEFAULT_BUDGET, maxCostUsd: 0.5 };
    expect(
      mayContinue({ requests: 1, costUsd: null, unpriced: 1, elapsedMs: 0 }, budget).kind,
    ).toBe('ok');
    expect(mayContinue({ requests: 1, costUsd: 0.6, unpriced: 0, elapsedMs: 0 }, budget).kind).toBe(
      'cost',
    );
  });
});

describe('切入角度的正規化', () => {
  it('丟掉沒有問題文字的，保留其餘', () => {
    const out = normalizeAngles(
      [{ question: '  誰付的錢？ ', stance: '資金流向', seeds: [0] }, { question: '' }, null],
      3,
    );
    expect(out).toEqual([{ question: '誰付的錢？', stance: '資金流向', seeds: [0] }]);
  });

  /** 「X 是誰？」與「X 是誰」在畫面上是同一條，收兩條就是在灌水。 */
  it('去掉標點之後相同的算重複', () => {
    const out = normalizeAngles(
      [
        { question: '他是誰？', stance: '', seeds: [] },
        { question: '他是誰', stance: '', seeds: [] },
      ],
      0,
    );
    expect(out).toHaveLength(1);
  });

  /** 編號指到不存在的第幾份 —— **丟掉那個編號，不去猜它想指哪一個**。 */
  it('超出範圍的種子編號直接丟掉', () => {
    const out = normalizeAngles([{ question: '這是一條角度', stance: '', seeds: [0, 5, -1] }], 2);
    expect(out[0]?.seeds).toEqual([0]);
  });

  it('最多只收 MAX_ANGLES 條', () => {
    const many = Array.from({ length: MAX_ANGLES + 4 }, (_, i) => ({
      question: `第 ${i} 條角度是什麼`,
      stance: '',
      seeds: [],
    }));
    expect(normalizeAngles(many, 0)).toHaveLength(MAX_ANGLES);
  });

  it('完全不是陣列的東西回空清單，不丟例外', () => {
    expect(normalizeAngles('大概是這樣', 0)).toEqual([]);
    expect(normalizeAngles(null, 0)).toEqual([]);
  });
});

describe('候選網址的正規化', () => {
  it('只留 http／https', () => {
    const out = normalizeCandidates([
      { url: 'https://example.com/a', why: '相關' },
      { url: 'file:///C:/secrets.txt', why: '本機檔案' },
      { url: 'javascript:alert(1)', why: '' },
    ]);
    expect(out.map((c) => c.url)).toEqual(['https://example.com/a']);
  });

  it('同一個網址只收一次，而且有數量上限', () => {
    const many = Array.from({ length: MAX_URLS_PER_ANGLE + 3 }, (_, i) => ({
      url: `https://example.com/${i}`,
      why: '',
    }));
    expect(normalizeCandidates([...many, { url: 'https://example.com/0', why: '' }])).toHaveLength(
      MAX_URLS_PER_ANGLE,
    );
  });
});

describe('抽取結果的正規化', () => {
  const base = {
    entities: [
      { name: '合成公司', type: 'org' },
      { name: '合成人物', type: 'person' },
    ],
  };

  it('關係的兩端一定要是宣告過的實體', () => {
    const out = normalizeExtraction({
      ...base,
      relations: [
        { subject: '合成公司', rel: '收購', object: '合成人物', quote: '這是一段引文。' },
        { subject: '合成公司', rel: '收購', object: '沒宣告過的東西', quote: '這是一段引文。' },
      ],
    });
    expect(out.relations).toHaveLength(1);
    expect(out.dropped.unknownEntity).toBe(1);
  });

  /** 型別對不上就丟掉整個實體 —— 猜一個型別只會產生一個標錯的節點。 */
  it('型別不在六個值裡的實體丟掉', () => {
    const out = normalizeExtraction({
      entities: [{ name: '合成公司', type: 'company' }],
      relations: [],
    });
    expect(out.entities).toEqual([]);
  });

  it('自己連自己與重複的關係各自被數出來', () => {
    const out = normalizeExtraction({
      ...base,
      relations: [
        { subject: '合成公司', rel: '收購', object: '合成公司', quote: '這是一段引文。' },
        { subject: '合成公司', rel: '收購', object: '合成人物', quote: '這是一段引文。' },
        { subject: '合成公司', rel: '收購', object: '合成人物', quote: '另一段引文。' },
      ],
    });
    expect(out.dropped.selfRelation).toBe(1);
    expect(out.dropped.duplicate).toBe(1);
    expect(out.relations).toHaveLength(1);
  });

  it('沒有引文的關係不收', () => {
    const out = normalizeExtraction({
      ...base,
      relations: [{ subject: '合成公司', rel: '收購', object: '合成人物', quote: '' }],
    });
    expect(out.relations).toEqual([]);
  });

  it('實體名的比對鍵只抹掉大小寫與空白', () => {
    expect(entityKey(' Acme  Corp ')).toBe(entityKey('acmecorp'));
    expect(entityKey('合成公司')).not.toBe(entityKey('合成公司股份有限公司'));
  });
});

describe('引文定位', () => {
  const text = '第一段的內容在這裡。\n\n  合成公司在二月宣布收購合成工作室。  \n\n最後一段。';

  it('找得到就回原文的字元區間', () => {
    const at = locateQuote(text, '合成公司在二月宣布收購合成工作室。');
    expect(at.kind).toBe('found');
    if (at.kind === 'found') {
      expect(text.slice(at.start, at.end)).toBe('合成公司在二月宣布收購合成工作室。');
    }
  });

  /**
   * 正文是從 HTML 抽出來的，模型會照自己的習慣重排空白。
   * **只做精確比對的話，中文以外的來源幾乎全部會找不到。**
   */
  it('空白不一樣也找得到，而且回的是原文的位置', () => {
    const spaced = 'The   quick\n brown fox jumped over it.';
    const at = locateQuote(spaced, 'The quick brown fox');
    expect(at.kind).toBe('found');
    if (at.kind === 'found') {
      expect(at.start).toBe(0);
      expect(spaced.slice(at.start, at.end)).toBe('The   quick\n brown fox');
    }
  });

  /** 「表示」兩個字在任何一篇裡都找得到 —— **找得到不等於驗得了**。 */
  it('太短的引文不算出處', () => {
    expect(locateQuote(text, '合成')).toEqual({ kind: 'too-short' });
    expect(MIN_QUOTE_CHARS).toBeGreaterThan(2);
  });

  /**
   * **這一條是整個 v0.5.0 最重要的一條測試。**
   * 模型編一句原文沒有的話出來，那條關聯就不該存在 ——
   * 一個指不到原文的出處，比沒有出處更糟。
   */
  it('原文沒有的句子回 not-found', () => {
    expect(locateQuote(text, '合成公司在三月宣布破產清算。')).toEqual({ kind: 'not-found' });
  });

  it('回的區間頭尾都落在真的有字的地方', () => {
    const at = locateQuote(text, '合成公司在二月宣布收購合成工作室');
    if (at.kind !== 'found') throw new Error('應該找得到');
    expect(text[at.start]).not.toMatch(/\s/);
    expect(text[at.end - 1]).not.toMatch(/\s/);
  });
});

describe('沙箱', () => {
  it('放行的只有那幾種純文字', () => {
    expect(sandboxViolations(['note.md', 'out.json', 'log.txt'])).toEqual([]);
    expect(SANDBOX_ALLOWED_EXTENSIONS).toContain('.json');
  });

  /** `storage-layout.md` 舉的是 HTML 與 PDF，**而那是例子不是清單**。 */
  it('抓取產物一律報出來，含子目錄與沒想過的副檔名', () => {
    expect(sandboxViolations(['downloads/a.html', 'b.pdf', 'c.warc', 'd.webp', 'blob'])).toEqual([
      'downloads/a.html',
      'b.pdf',
      'c.warc',
      'd.webp',
      'blob',
    ]);
  });
});

/**
 * **全形與半形標點視為等價** —— 而這一層是量出來才加的。
 *
 * 2026-09-09 的 `chat` 評測裡，`qwen3.5:9b` 的引文命中率只有 59%，
 * 看起來像「這個模型會捏造引文」。追進去看那些字：
 *
 * | 模型寫的 | 原文 |
 * |---|---|
 * | `朱耀沂。《蜘蛛博物學》.` | `朱耀沂. 《蜘蛛博物學》.` |
 *
 * **逐字照抄，只把一個半形句點打成全形。** 而「找不到」的後果是那條邊不存在，
 * 所以那一欄把「模型編的」與「模型少打一個標點」算成了同一件事 ——
 * 兩者的處方相反（換模型 ／ 放寬比對）。
 */
describe('引文比對：全形與半形標點視為等價', () => {
  const text = '報告指出（第三節）：「網的結構會隨獵物改變」，而那一段沒有引用來源。';

  it('模型把全形括號與引號打成半形，仍然定位得到', () => {
    const at = locateQuote(text, '報告指出(第三節):"網的結構會隨獵物改變",');
    expect(at.kind).toBe('found');
  });

  it('**回的是原文的座標** —— 切出來要是原文那一段，不是模型打的那一段', () => {
    const at = locateQuote(text, '報告指出(第三節):"網的結構會隨獵物改變",');
    if (at.kind !== 'found') throw new Error('應該找得到');
    expect(text.slice(at.start, at.end)).toBe('報告指出（第三節）：「網的結構會隨獵物改變」，');
  });

  it('放寬的只有標點的寫法，**內容不一樣仍然找不到**', () => {
    expect(locateQuote(text, '報告指出(第三節):"網的結構會隨溫度改變",').kind).toBe('not-found');
  });

  it('嚴格比對先跑 —— 對得上就用嚴格的那個位置', () => {
    const twice = '甲說：「他來了」。乙說：「他來了」。';
    const at = locateQuote(twice, '乙說：「他來了」。');
    if (at.kind !== 'found') throw new Error('應該找得到');
    expect(twice.slice(at.start, at.end)).toBe('乙說：「他來了」。');
  });

  /**
   * **中英文之間的空格：這一條才是主力。**
   *
   * 中文排版有「中文與英數字之間加一個空格」的慣例，而**原文加不加、
   * 模型加不加，是各自的習慣** —— 字完全一樣。
   *
   * 份量是量出來的（`tools/research/score-quotes.ts`，150 條真實引文）：
   *
   * | 放寬什麼 | 救回幾條 |
   * |---|---|
   * | CJK 旁邊的空白 | `qwen3.5:4b` **10 條**（73% → 98%）|
   * | 全形對半形標點 | **0 條** |
   *
   * **不能整個把空白刪掉** —— 拉丁文的空格是有意義的，
   * 所以條件是「兩側至少有一邊是 CJK」。
   */
  it('模型在中文與數字之間加了空格，仍然定位得到', () => {
    const body = '中本聰在2008年提出區塊鏈概念，並在2009年創立比特幣網路。';
    const at = locateQuote(body, '中本聰在 2008 年提出區塊鏈概念');
    expect(at.kind).toBe('found');
    if (at.kind !== 'found') return;
    expect(body.slice(at.start, at.end)).toBe('中本聰在2008年提出區塊鏈概念');
  });

  it('反過來也要成立 —— 原文有空格而模型沒打', () => {
    const body = '朱耀沂. 《蜘蛛博物學》. 臺北市: 大樹文化出版社.';
    expect(locateQuote(body, '朱耀沂。《蜘蛛博物學》。').kind).toBe('found');
  });

  /**
   * **拉丁文之間的空格不放寬。** 兩側都不是 CJK 的那個空白照舊必須對上，
   * 否則 `the rapist` 會對上 `therapist`。
   */
  it('兩側都是拉丁字母的空格仍然必須一致', () => {
    expect(locateQuote('the rapist was arrested', 'therapist was arrested').kind).toBe('not-found');
  });
});
