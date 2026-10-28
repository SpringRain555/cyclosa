/**
 * 同一篇換了一個網址（2026-10-28 試用回饋 8）。
 *
 * 試用時同一篇論文在 PMC 與期刊網站各來了一份、同一篇的 PDF 與摘要頁也各一份 ——
 * 確認畫面上是兩列、預設都進圖，建圖就抽兩次、圖上兩個節點講同一件事。
 *
 * ## 認法：網址裡的識別碼，加上正規化之後的標題
 *
 * | 鍵 | 從哪裡來 |
 * |---|---|
 * | `url` | 網址本身（去掉 `#` 之後、結尾的 `/`、大小寫不分的主機）|
 * | `doi` | 網址路徑裡的 `10.xxxx/…`（期刊頁、doi.org、bioRxiv）；去掉 `.full`／`.pdf`／`/abstract` 與版本號 `v2` |
 * | `arxiv` | `arxiv.org/abs|pdf|html/<編號>`，版本號不算 |
 * | `pmc`、`pmid` | PMC 編號、PubMed 的網址 |
 * | `title` | 標題拿掉網站尾巴（「… \| bioRxiv」）、NFKC、小寫、只留字母與數字；**夠長才算**（太短的標題會撞在一起）|
 *
 * 兩份只要有一個鍵相同就算「可能是同一篇」。**這是提示不是判決**：畫面標出來、預設改成不進圖，人可以改回來。
 *
 * ## 誰是正本
 *
 * 專題裡已經有的資料永遠是正本；這次的候選裡，**抓到正文的先算、同樣情況照順序** ——
 * 一份抓到的 PDF 跟一份沒抓到的書目頁撞在一起，留抓到的那一份。
 *
 * ⚠️ 純函式，零依賴。
 */

export type DuplicateReason = 'url' | 'doi' | 'arxiv' | 'pmc' | 'pmid' | 'title' | 'content';

export interface IdentityKey {
  readonly key: string;
  readonly reason: DuplicateReason;
}

/** 標題正規化之後至少這麼長才當成鍵 —— 「Introduction」「Abstract」這種一定會撞。 */
export const MIN_TITLE_KEY_CHARS = 16;

/** 網站名接在標題後面的那一段：「… | bioRxiv」「… - PubMed」。最後一段不超過這麼長才拿掉。 */
const SITE_SUFFIX = /\s+[|｜\-–—]\s+[^|｜\-–—]{1,40}$/u;

function normalTitle(title: string): string | null {
  const folded = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return [...folded].length >= MIN_TITLE_KEY_CHARS ? folded : null;
}

function normalUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return null;
  }
}

function decoded(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function doiOf(url: string): string | null {
  const m = /\b(10\.\d{4,9}\/[^\s?#&]+)/i.exec(decoded(url));
  if (m === null) return null;
  let doi = (m[1] as string).toLowerCase();
  // 期刊與預印本站在 DOI 後面接的頁面種類，不是 DOI 的一部分
  for (;;) {
    const next = doi.replace(/(\.full|\.pdf|\.abstract|\/full|\/abstract|\/pdf|\/epdf)$/, '');
    if (next === doi) break;
    doi = next;
  }
  // bioRxiv／medRxiv 的版本號（…046672v1）
  return doi.replace(/(\d)v\d+$/, '$1');
}

/** 一份資料的識別鍵。標題可以給好幾個（搜尋結果上的、抓回來那一頁的）。 */
export function identityKeys(url: string, titles: readonly string[]): readonly IdentityKey[] {
  const keys: IdentityKey[] = [];
  const add = (key: string, reason: DuplicateReason): void => {
    if (!keys.some((k) => k.key === key)) keys.push({ key, reason });
  };

  const plainUrl = url.length > 0 ? normalUrl(url) : null;
  if (plainUrl !== null) add(`url:${plainUrl}`, 'url');
  const doi = doiOf(url);
  if (doi !== null) add(`doi:${doi}`, 'doi');
  const arxiv = /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i.exec(url);
  if (arxiv !== null) add(`arxiv:${(arxiv[1] as string).toLowerCase()}`, 'arxiv');
  const pmc = /\bPMC(\d+)\b/i.exec(url);
  if (pmc !== null) add(`pmc:${pmc[1] as string}`, 'pmc');
  const pmid = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i.exec(url);
  if (pmid !== null) add(`pmid:${pmid[1] as string}`, 'pmid');

  for (const title of titles) {
    const trimmed = title.trim();
    if (trimmed.length === 0) continue;
    const full = normalTitle(trimmed);
    if (full !== null) add(`title:${full}`, 'title');
    const stripped = normalTitle(trimmed.replace(SITE_SUFFIX, ''));
    if (stripped !== null) add(`title:${stripped}`, 'title');
  }
  return keys;
}

export interface DuplicateSubject {
  readonly id: string;
  readonly url: string;
  readonly titles: readonly string[];
}

export interface DuplicateCandidate extends DuplicateSubject {
  /** 抓到正文了（`fetched`／`uploaded`）。撞在一起時抓到的那一份當正本。 */
  readonly fetched: boolean;
}

export interface DuplicateOf {
  /** 正本那一份的 id：專題裡的資料（`item`）或這次的另一個候選（`candidate`）。 */
  readonly id: string;
  readonly kind: 'item' | 'candidate';
  readonly reason: DuplicateReason;
}

/**
 * 這次的候選裡，哪幾個「可能跟某一份是同一篇」。正本自己不在結果裡。
 *
 * `existing` 是專題裡**這次研究以外**的資料 —— 這次候選自己抓回來的那幾份不要放進來，
 * 否則每一個候選都會撞到自己的那一份。
 */
export function findDuplicates(
  existing: readonly DuplicateSubject[],
  candidates: readonly DuplicateCandidate[],
): ReadonlyMap<string, DuplicateOf> {
  const owner = new Map<string, { readonly id: string; readonly kind: 'item' | 'candidate' }>();
  for (const item of existing) {
    for (const { key } of identityKeys(item.url, item.titles)) {
      if (!owner.has(key)) owner.set(key, { id: item.id, kind: 'item' });
    }
  }

  const out = new Map<string, DuplicateOf>();
  // 抓到正文的先登記，同樣情況照原本的順序 —— 正本挑抓到的那一份。
  const ordered = [...candidates.filter((c) => c.fetched), ...candidates.filter((c) => !c.fetched)];
  for (const candidate of ordered) {
    const keys = identityKeys(candidate.url, candidate.titles);
    const hit = keys.find(({ key }) => owner.has(key));
    if (hit !== undefined) {
      const first = owner.get(hit.key) as {
        readonly id: string;
        readonly kind: 'item' | 'candidate';
      };
      if (first.id !== candidate.id) {
        out.set(candidate.id, { id: first.id, kind: first.kind, reason: hit.reason });
        continue;
      }
    }
    for (const { key } of keys)
      if (!owner.has(key)) owner.set(key, { id: candidate.id, kind: 'candidate' });
  }
  return out;
}
