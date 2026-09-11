/**
 * 守門：**範例專案的語料檔本身。**
 *
 * ## 為什麼這是一條守門測試而不是一般測試
 *
 * 這個檔案是**手寫的資料**，而它描述的是「哪一段文字出自哪一條法規」——
 * 一個打錯的引文不會讓任何東西壞掉，它只會讓範例專案裡出現一條
 * **看起來完整、而出處指向錯誤文件**的關聯。
 *
 * 那正是這個工具存在的理由的反面。
 *
 * > 組裝語料的時候這條檢查當場抓到兩個錯：`cr52 → cr64` 與 `cr44 → cr64`
 * > 這兩條「受限於」的出處**不在來源那一份上**，而是在 `cr64` 的條文裡
 * > （是 §64 列舉了 §52）。語料格式因此多了一個 `evidenceFrom`。
 *
 * e2e（`tests/e2e/sample-case.test.ts`）也會間接抓到同一件事
 * —— 引文定位不到就不會寫出處，而那裡有一條「每一條關聯都有出處」。
 * 但那要跑完整條匯入管線（十幾秒），而這裡是毫秒級，
 * **失敗訊息也直接指到是哪一條。**
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EDGE_LAYERS, type EntityType } from '../../src/domain/graph/types.js';
import { tierOf } from '../../src/domain/graph/confidence.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORPUS = join(REPO_ROOT, 'src', 'assets', 'sample-corpus.json');

interface Corpus {
  version: number;
  caseName: string;
  seed: string;
  source: Record<string, string>;
  articles: { key: string; law: string; article: string; text: string; url: string }[];
  entities: { key: string; type: EntityType; name: string }[];
  edges: {
    from: string;
    to: string;
    rel: string;
    origin: 'human' | 'machine';
    confidence?: number;
    evidenceFrom?: string;
    quote: string;
  }[];
}

const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as Corpus;
const articleOf = new Map(corpus.articles.map((a) => [a.key, a]));
const keys = new Set([...articleOf.keys(), ...corpus.entities.map((e) => e.key)]);

describe('範例語料', () => {
  /** **這一條是最重要的。** 引文對不上出處，等於一條假的證據鏈。 */
  it('每一段引文都在它所引的那一條法規原文裡逐字存在', () => {
    const bad = corpus.edges
      .filter((e) => {
        const a = articleOf.get(e.evidenceFrom ?? e.from);
        return a === undefined || !a.text.includes(e.quote);
      })
      .map((e) => `${e.evidenceFrom ?? e.from}：${e.quote}`);
    expect(bad).toEqual([]);
  });

  it('每一條關聯的兩端都指得到一個真的節點', () => {
    const dangling = corpus.edges
      .filter((e) => !keys.has(e.from) || !keys.has(e.to))
      .map((e) => `${e.from} → ${e.to}`);
    expect(dangling).toEqual([]);
  });

  it('每一條條文都指到它自己那一條的網址，而且八條各不相同', () => {
    for (const a of corpus.articles) {
      // `flno=` 就是「哪一條」。少了它，出處只指得到整部法規。
      expect(a.url, `${a.law} ${a.article}`).toMatch(/^https:\/\/law\.moj\.gov\.tw\/.*flno=\d+$/);
    }
    expect(new Set(corpus.articles.map((a) => a.url)).size).toBe(corpus.articles.length);
  });

  /**
   * **可信度三段要各出現至少一次。**
   *
   * 範例專案的工作之一是讓使用者看到那三段長什麼樣子 ——
   * 全部落在同一段的話，`weak`／`medium`／`strong` 在畫面上永遠只有一種。
   *
   * 第一次實跑時八條裡有七條是 `strong`、一條 `medium`、**零條 `weak`**，
   * 所以補了一條真的該被懷疑的跨法推論
   * （政府資訊公開法 §7 → 公文），而不是把某個數字調小。
   */
  it('可信度三段各有至少一條，而且「弱」那一條是真的該被懷疑的', () => {
    const tiers = new Set(
      corpus.edges.filter((e) => e.origin === 'machine').map((e) => tierOf(e.confidence ?? 1)),
    );
    expect([...tiers].sort()).toEqual(['medium', 'strong', 'weak']);
  });

  it('既有待查證的也有已確認的 —— 兩種畫法都要看得到', () => {
    const origins = new Set(corpus.edges.map((e) => e.origin));
    expect([...origins].sort()).toEqual(['human', 'machine']);
  });

  it('授權資訊齊全 —— 少一欄就等於少一句出處', () => {
    for (const field of [
      'dataset',
      'datasetUrl',
      'agency',
      'licence',
      'licenceUrl',
      'downloadUrl',
      'datasetUpdatedAt',
      'retrievedAt',
      'alsoPublicDomain',
    ]) {
      expect(corpus.source[field], field).toBeTruthy();
    }
  });

  it('專題名稱說得出它是範例', () => {
    // 使用者在清單上第一眼就要分得出這不是他自己蒐集的東西。
    expect(corpus.caseName).toContain('範例');
  });

  it('`named` 是一個真的層別 —— 產生器把每一條都寫進那一層', () => {
    // 這一條守的是「產生器寫的層別名字沒有拼錯」：
    // `sample-service.ts` 寫死 `'named'`，而層別是 `domain` 宣告的。
    expect(EDGE_LAYERS).toContain('named');
  });
});
