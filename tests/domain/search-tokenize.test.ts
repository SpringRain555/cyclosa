import { describe, expect, it } from 'vitest';
import {
  bigrams,
  cjkRatio,
  indexTargets,
  isCjkLanguage,
  normalize,
  queryGrams,
  toFtsPhrase,
} from '../../src/domain/search/tokenize.js';
import { rankKey, rankTitles } from '../../src/domain/search/collate.js';

describe('中文 bigram', () => {
  it('連續中文切成相鄰兩字', () => {
    const grams = [...bigrams('台積電').keys()];
    expect(grams).toEqual(['台積', '積電']);
  });

  it('**兩個字的查詢切得出一個 gram** —— 這正是 FTS5 trigram 做不到的那件事', () => {
    expect(queryGrams('疫情')).toEqual(['疫情']);
  });

  it('三個字的查詢切成兩個，要 AND 起來', () => {
    expect(queryGrams('關聯圖')).toEqual(['關聯', '聯圖']);
  });

  it('拉丁字被當成分隔，不進 bigram', () => {
    const grams = [...bigrams('台積 TSMC 電').keys()];
    // 「台積」是一段，「電」自己一段（長度 1 → 收 unigram）
    expect(grams).toEqual(['台積', '電']);
  });

  it('長度 1 的連續段落收 unigram，長度 ≥2 的不收', () => {
    expect([...bigrams('A股').keys()]).toEqual(['股']);
    expect([...bigrams('股市').keys()]).toEqual(['股市']);
  });

  it('次數會累加', () => {
    expect(bigrams('疫情 疫情').get('疫情')).toBe(2);
  });

  it('索引與查詢用同一支正規化', () => {
    expect(normalize('ＡＢＣ')).toBe('abc');
    expect([...bigrams('日本語').keys()]).toEqual(['日本', '本語']);
  });

  it('日文與韓文也走 bigram', () => {
    expect([...bigrams('ひらがな').keys()]).toHaveLength(3);
    expect([...bigrams('한국어').keys()]).toHaveLength(2);
  });
});

describe('依語言選索引', () => {
  it('CJK 走 bigram、拉丁走 FTS5', () => {
    expect(indexTargets('cmn')).toEqual({ bigram: true, fts: false });
    expect(indexTargets('eng')).toEqual({ bigram: false, fts: true });
  });

  it('**`und` 兩條都建** —— 不知道就都建', () => {
    expect(indexTargets('und')).toEqual({ bigram: true, fts: true });
  });

  it('認得哪些碼是 CJK', () => {
    expect(isCjkLanguage('jpn')).toBe(true);
    expect(isCjkLanguage('deu')).toBe(false);
  });
});

describe('CJK 比例（用證據推翻語言標籤）', () => {
  it('算得出比例，空白不算', () => {
    expect(cjkRatio('中文')).toBe(1);
    expect(cjkRatio('abcd')).toBe(0);
    expect(cjkRatio('ab 中文')).toBeCloseTo(0.5, 5);
    expect(cjkRatio('')).toBe(0);
  });
});

describe('FTS5 的查詢字串', () => {
  it('**包成片語**，否則使用者的字會變成 FTS5 的語法', () => {
    expect(toFtsPhrase('a AND b')).toBe('"a and b"');
    expect(toFtsPhrase('a NEAR/2 b')).toBe('"a near/2 b"');
  });

  it('內部的雙引號重複一次跳脫', () => {
    expect(toFtsPhrase('say "hi"')).toBe('"say ""hi"""');
  });
});

describe('標題名次', () => {
  it('名次是零填補的，所以字串排序等於數字排序', () => {
    expect(rankKey(0)).toBe('00000000');
    expect(rankKey(42) < rankKey(100)).toBe(true);
  });

  it('數字照數值排，不是照字元排', () => {
    const ranked = rankTitles([
      { id: 'a', title: '第 10 章' },
      { id: 'b', title: '第 2 章' },
    ]);
    expect(ranked.find((r) => r.id === 'b')!.rank < ranked.find((r) => r.id === 'a')!.rank).toBe(
      true,
    );
  });

  it('**同名時用 id 決勝** —— 否則兩次重排的名次會不一樣，cursor 分頁會跳列', () => {
    const once = rankTitles([
      { id: 'z', title: '一樣' },
      { id: 'a', title: '一樣' },
    ]);
    const twice = rankTitles([
      { id: 'a', title: '一樣' },
      { id: 'z', title: '一樣' },
    ]);
    expect(once).toEqual(twice);
  });
});
