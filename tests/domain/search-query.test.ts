/**
 * 查詢那一半的規則。
 *
 * **這一份守的是 ADR-0009 的代價那一節**：bigram 會跨詞誤中，
 * 而索引表裡沒有位置 —— 所以誤中只能靠回去讀正文分辨。
 * 那件事的判斷寫在 `checkText` 與 `rankHits`，這裡逐條釘住它。
 */
import { describe, expect, it } from 'vitest';

import {
  checkText,
  parseQuery,
  rankHits,
  snippetAround,
  type RankableHit,
} from '../../src/domain/search/query.js';
import { findFirstFolded } from '../../src/domain/text/offsets.js';

describe('查詢依「查詢字串本身」選路，不是依 item.lang', () => {
  it('純中文走 bigram', () => {
    const q = parseQuery('台積電');
    expect(q?.route).toBe('bigram');
    // 三個字切出兩個 gram，兩個都要命中 —— 這正是 trigram 做不到的那件事
    expect(q?.grams).toEqual(['台積', '積電']);
    expect(q?.phrase).toBeNull();
  });

  it('**中文兩個字**切出一個 gram —— 這是這一階段的驗收句', () => {
    expect(parseQuery('疫情')?.grams).toEqual(['疫情']);
  });

  it('純英文走 FTS5，而且包成片語', () => {
    const q = parseQuery('spider decorations');
    expect(q?.route).toBe('fts');
    expect(q?.grams).toEqual([]);
    expect(q?.phrase).toBe('"spider decorations"');
  });

  it('中英混合兩條都走，**而送進 FTS5 的只有非 CJK 的那幾段**', () => {
    const q = parseQuery('塵蛛 Cyclosa');
    expect(q?.route).toBe('both');
    expect(q?.grams).toEqual(['塵蛛']);
    // 整串丟給 unicode61 的話，中文那段會變成一個永遠不命中的 token
    expect(q?.phrase).toBe('"cyclosa"');
  });

  it('片語裡的雙引號要跳脫 —— 那不是 SQL 注入，是注入 FTS5 的查詢語言', () => {
    expect(parseQuery('say "hi"')?.phrase).toBe('"say ""hi"""');
  });

  it('空的、只有空白的 → null（呼叫端回 SEARCH_QUERY_EMPTY）', () => {
    expect(parseQuery('')).toBeNull();
    expect(parseQuery('   \n ')).toBeNull();
  });
});

describe('正文確認：三種狀態，不是一個布林值', () => {
  const text = '台積電今天公布財報，而市場早就知道了。';

  it('正文裡真的有這串字 → hit，而且拿得到位置', () => {
    const r = checkText(text, '台積電');
    expect(r.status).toBe('hit');
    expect(r.span).toEqual({ start: 0, end: 3 });
  });

  it('**跨詞誤中 → miss**：兩個 gram 都在，但那串字不在', () => {
    // 「來台積極」有 台積、「累積電力」有 積電 —— 索引會把它當候選
    const noisy = '他來台積極參與，後來又累積電力數據。';
    const r = checkText(noisy, '台積電');
    expect(r.status).toBe('miss');
    expect(r.span).toBeNull();
  });

  it('**正文讀不到 → no-text，不是 miss** —— 那是不知道，不是不對', () => {
    expect(checkText(null, '台積電').status).toBe('no-text');
  });

  it('大小寫視為等價 —— Cyclosa 與 cyclosa 是同一個字', () => {
    expect(checkText('The genus Cyclosa builds…', 'cyclosa').status).toBe('hit');
  });

  it('空白視為等價 —— 抽取器換版之後空白會變', () => {
    expect(checkText('spider   decorations', 'spider decorations').status).toBe('hit');
  });
});

describe('大小寫等價只給檢索，引文那一支不受影響', () => {
  it('findFirstFolded 找得到，而位置仍然是原文的位置', () => {
    const span = findFirstFolded('The genus Cyclosa formosana', 'CYCLOSA');
    expect(span).toEqual({ start: 10, end: 17 });
  });

  it('轉小寫會變長的字元不參與折疊 —— 否則位置會偏', () => {
    // 'İ'.toLowerCase() 是兩個字元；折疊掉它會讓 map 對不上
    const span = findFirstFolded('İstanbul 的資料', '的資料');
    expect(span).toEqual({ start: 9, end: 12 });
  });
});

function hit(over: Partial<RankableHit>): RankableHit {
  return {
    id: 'a',
    status: 'hit',
    inTitle: false,
    indexScore: 0.5,
    titleRank: '00000001',
    ...over,
  };
}

describe('排序：確認過的在前面，而「沒驗」排在「誤中」前面', () => {
  it('三種狀態的順序是 hit → no-text → miss', () => {
    const order = rankHits([
      hit({ id: 'miss', status: 'miss' }),
      hit({ id: 'unknown', status: 'no-text' }),
      hit({ id: 'ok', status: 'hit' }),
    ]).map((h) => h.id);
    // **不知道排在確定不對的前面** —— 後者我們已經看過正文了
    expect(order).toEqual(['ok', 'unknown', 'miss']);
  });

  it('都確認過的時候，標題命中排前面', () => {
    const order = rankHits([
      hit({ id: 'body', inTitle: false, indexScore: 0.9 }),
      hit({ id: 'title', inTitle: true, indexScore: 0.1 }),
    ]).map((h) => h.id);
    expect(order).toEqual(['title', 'body']);
  });

  it('同一層裡索引分數高的在前面', () => {
    const order = rankHits([
      hit({ id: 'low', indexScore: 0.2 }),
      hit({ id: 'high', indexScore: 0.8 }),
    ]).map((h) => h.id);
    expect(order).toEqual(['high', 'low']);
  });

  it('**完全同分時用名次與 id 決勝** —— 不然兩次查詢的順序會不一樣', () => {
    const a = rankHits([hit({ id: 'b' }), hit({ id: 'a' })]).map((h) => h.id);
    const b = rankHits([hit({ id: 'a' }), hit({ id: 'b' })]).map((h) => h.id);
    expect(a).toEqual(b);
  });
});

describe('摘要：位置一起回，前端不用自己再找一次', () => {
  const text = '前面這一段是鋪陳，接著出現台積電這三個字，後面還有一段話收尾。';

  it('命中的位置在摘要裡指得到那三個字', () => {
    const span = { start: text.indexOf('台積電'), end: text.indexOf('台積電') + 3 };
    const s = snippetAround(text, span, 6);
    expect(s.text.slice(s.matchStart, s.matchEnd)).toBe('台積電');
    expect(s.cutHead).toBe(true);
    expect(s.cutTail).toBe(true);
  });

  it('**壓掉換行之後位置要跟著校正** —— 中文正文上偏移常常是 0，所以這個錯很容易漏', () => {
    const spaced = 'a\n\n\n  b   spider   here';
    const at = spaced.indexOf('spider');
    const s = snippetAround(spaced, { start: at, end: at + 6 }, 40);
    expect(s.text).toBe('a b spider here');
    expect(s.text.slice(s.matchStart, s.matchEnd)).toBe('spider');
  });

  it('整段都在範圍內時不標示截斷', () => {
    const s = snippetAround('短短一句', { start: 0, end: 2 }, 50);
    expect(s.cutHead).toBe(false);
    expect(s.cutTail).toBe(false);
  });
});
