/**
 * 規劃的正規化與研究的狀態機（Stage 19；ADR-0033 D2／D3／D5、REQ-0009 R3／R4／R6）。
 *
 * **這裡處理的是模型輸出，也就是外部輸入** —— 每一條測試都在問同一件事：
 * 對面回垃圾的時候，我們交出去的是不是一份乾淨的東西。
 */
import { describe, expect, it } from 'vitest';

import {
  EMPTY_PLAN,
  MAX_DIRECTIONS,
  MAX_DIRECTION_TITLE_CHARS,
  MAX_KEYWORDS_PER_DIRECTION,
  MAX_OUT_OF_SCOPE,
  MAX_REPLY_CHARS,
  normalizeDirection,
  normalizePlan,
} from '../../src/domain/provider/plan.js';
import {
  isFinal,
  isOpen,
  kindOf,
  mayAbandon,
  mayConverse,
  mayDelete,
  mayEditDirections,
  mayStartCollecting,
  nextStatus,
  RESEARCH_STATUSES,
  statusOf,
} from '../../src/domain/research/index.js';

const direction = (
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  title,
  what: '要找什麼',
  expect: '會議論文',
  keywords: ['a', 'b'],
  ...extra,
});

describe('規劃的正規化', () => {
  it('一份正常的規劃原樣過去', () => {
    const plan = normalizePlan({
      reply: '我建議分成三條',
      relation: '這個主題跟專題裡那份 PDF 講的是同一套系統',
      directions: [direction('基準集怎麼建'), direction('人類評分的一致性')],
      out_of_scope: ['模型本身的架構'],
    });
    expect(plan.reply).toBe('我建議分成三條');
    expect(plan.directions.map((d) => d.title)).toEqual(['基準集怎麼建', '人類評分的一致性']);
    expect(plan.directions[0]?.keywords).toEqual(['a', 'b']);
    expect(plan.outOfScope).toEqual(['模型本身的架構']);
    expect(plan.overflow).toBe(false);
  });

  it('不是物件、少欄位、空標題 —— 回空的，不丟例外', () => {
    for (const raw of [null, undefined, 42, '一段話', [], {}]) {
      expect(normalizePlan(raw)).toEqual(EMPTY_PLAN);
    }
    expect(normalizePlan({ directions: [{ what: '沒有標題' }, null, 7] }).directions).toEqual([]);
    expect(normalizeDirection({ title: '   ' })).toBeNull();
  });

  it('標題只差標點的兩條算同一條 —— 否則同一條方向會花兩次錢', () => {
    const plan = normalizePlan({
      directions: [direction('6G 的標準進度'), direction('6G 的標準進度？')],
    });
    expect(plan.directions).toHaveLength(1);
  });

  it(`超過 ${MAX_DIRECTIONS} 條要說，不靜默截掉（R6）`, () => {
    const many = Array.from({ length: MAX_DIRECTIONS + 3 }, (_, i) => direction(`方向 ${i}`));
    const plan = normalizePlan({ directions: many });
    expect(plan.directions).toHaveLength(MAX_DIRECTIONS);
    expect(plan.overflow).toBe(true);
  });

  it('尾巴是空物件不算 overflow —— 那會讓畫面說一句假話', () => {
    const list = [
      ...Array.from({ length: MAX_DIRECTIONS }, (_, i) => direction(`方向 ${i}`)),
      { what: '沒有標題' },
      null,
    ];
    const plan = normalizePlan({ directions: list });
    expect(plan.directions).toHaveLength(MAX_DIRECTIONS);
    expect(plan.overflow).toBe(false);
  });

  it('超長的字切掉、空白壓成一個空格、關鍵詞去重也有上限', () => {
    const plan = normalizePlan({
      reply: 'x'.repeat(MAX_REPLY_CHARS + 50),
      directions: [
        direction('y'.repeat(MAX_DIRECTION_TITLE_CHARS + 20), {
          keywords: ['  一   二  ', '一 二', ...Array.from({ length: 20 }, (_, i) => `k${i}`)],
        }),
      ],
      out_of_scope: Array.from({ length: MAX_OUT_OF_SCOPE + 4 }, (_, i) => `不查 ${i}`),
    });
    expect(plan.reply).toHaveLength(MAX_REPLY_CHARS);
    expect(plan.directions[0]?.title).toHaveLength(MAX_DIRECTION_TITLE_CHARS);
    const keywords = plan.directions[0]?.keywords ?? [];
    expect(keywords[0]).toBe('一 二');
    expect(keywords).toHaveLength(MAX_KEYWORDS_PER_DIRECTION);
    // 壓過空白之後重複的那一個不再出現第二次。
    expect(keywords.filter((k) => k === '一 二')).toHaveLength(1);
    expect(plan.outOfScope).toHaveLength(MAX_OUT_OF_SCOPE);
  });
});

describe('研究的狀態機', () => {
  it('五步走得完，終態沒有下一步', () => {
    expect(nextStatus('planning')).toBe('collecting');
    expect(nextStatus('collecting')).toBe('awaiting-user');
    expect(nextStatus('awaiting-user')).toBe('reviewing');
    expect(nextStatus('reviewing')).toBe('building');
    expect(nextStatus('building')).toBe('done');
    expect(nextStatus('done')).toBeNull();
    expect(nextStatus('abandoned')).toBeNull();
  });

  it('只有 done 與 abandoned 算結束', () => {
    for (const status of RESEARCH_STATUSES) {
      expect(isOpen(status), status).toBe(!isFinal(status));
    }
    expect(RESEARCH_STATUSES.filter(isFinal)).toEqual(['done', 'abandoned']);
  });

  it('談一輪、改方向：只有規劃中可以', () => {
    for (const status of RESEARCH_STATUSES) {
      const only = status === 'planning';
      expect(mayConverse(status), status).toBe(only);
      expect(mayEditDirections(status), status).toBe(only);
    }
  });

  it('閘門一：規劃中、而且至少一條方向', () => {
    expect(mayStartCollecting('planning', 1)).toBe(true);
    expect(mayStartCollecting('planning', 0)).toBe(false);
    expect(mayStartCollecting('collecting', 3)).toBe(false);
  });

  it('放棄要還沒結束；刪除要已經結束', () => {
    expect(mayAbandon('planning')).toBe(true);
    expect(mayAbandon('done')).toBe(false);
    // **進行中的不能直接刪** —— 跑完的那筆作業會指向一個不存在的研究。
    expect(mayDelete('planning')).toBe(false);
    expect(mayDelete('done')).toBe(true);
    expect(mayDelete('abandoned')).toBe(true);
  });

  it('認不得的字串有一個明確的落點', () => {
    expect(statusOf('planning')).toBe('planning');
    expect(statusOf('什麼都不是')).toBe('planning');
    expect(statusOf(null)).toBe('planning');
    expect(kindOf('consolidate')).toBe('consolidate');
    expect(kindOf('研究')).toBe('research');
  });
});
