/**
 * 內建的來源網站清單（Stage 10.5）。
 *
 * ## 這份清單是建議，不是事實
 *
 * 每一列的 `expected` 是「一般而言」，而**畫面上顯示的判斷不來自這一欄** ——
 * 它來自你自己抓過的結果，或一次真的探測。
 * 這一欄的用途只有一個：**在你還沒抓過任何東西的時候，給一個起點。**
 *
 * 所以這份清單寫錯了不會造成錯誤的行為，只會造成一次多餘的檢查 ——
 * 而那正是這個功能設計成「先驗證再查」的理由。
 *
 * ## 探針為什麼可以是空的
 *
 * 探針要探的是**一篇代表性的文章**，不是首頁 ——
 * 出版社的首頁一律回 200，而文章回 403。
 *
 * 而「一篇有代表性、而且網址長期穩定的文章」對出版社網站來說**我們給不出來**：
 * 隨便挑一篇，它下架或改網址之後，這個工具會開始回報一個假的「連不到」。
 * **給不出來就留空，讓那一列的判斷完全依賴你自己的紀錄。**
 * 憑空編一個看起來合理的網址，比沒有探針糟得多。
 *
 * 開放 API 那幾列有探針，因為它們的端點形狀是**文件寫明的**，
 * 而且那個端點就是我們真正會用的那一個。
 *
 * ## 這一份可以被使用者蓋掉
 *
 * 使用者的增刪改存在 `%LOCALAPPDATA%\Cyclosa\sources.json`，
 * 而這一份跟著程式走。**升級這個工具會更新這份清單，不會動到你改過的那些。**
 */

/** 一個來源是一組可以直接程式化查詢的端點，還是一個給人看的網站。 */
export type SourceKind = 'api' | 'site';

export type SourceCategory =
  /** 開放書目與全文 API */
  | 'scholarly-api'
  /** 預印本 */
  | 'preprint'
  /** 開放取用的全文庫 */
  | 'open-repository'
  /** 出版社與期刊平台 */
  | 'publisher'
  /** 政府、法規、官方公告 */
  | 'official'
  /** 百科與參考 */
  | 'reference';

export interface CatalogEntry {
  /** 網域。**比對用的鍵**，所以不含 `www.`。 */
  readonly host: string;
  readonly nameZh: string;
  readonly kind: SourceKind;
  readonly category: SourceCategory;
  /** 一般而言讀不讀得到。**只是起點，不是判斷。** */
  readonly expected: 'open' | 'login' | 'mixed';
  /**
   * 探針網址。**沒有就是 `null`** —— 見上面。
   * 有的都是文件寫明的 API 端點，也就是我們真正會用的那一個。
   */
  readonly probe: string | null;
  /** 一句話說它是什麼、什麼時候有用。 */
  readonly noteZh: string;
}

/**
 * 內建清單。
 *
 * 排序照「對這個工具的實際用處」而不是字母 ——
 * **最上面那幾個是「把付費牆變成一個讀得到的網址」的那些**，
 * 而那正是 2026-09-08 那次跑（6 個來源 5 個付費牆）最缺的東西。
 */
export const CATALOG: readonly CatalogEntry[] = [
  {
    host: 'api.openalex.org',
    nameZh: 'OpenAlex',
    kind: 'api',
    category: 'scholarly-api',
    expected: 'open',
    probe: 'https://api.openalex.org/works?per-page=1',
    noteZh: '免金鑰的書目資料庫。給一個 DOI 或關鍵字就回作者、機構、引用關係與摘要。',
  },
  {
    host: 'api.crossref.org',
    nameZh: 'Crossref',
    kind: 'api',
    category: 'scholarly-api',
    expected: 'open',
    probe: 'https://api.crossref.org/works?rows=1',
    noteZh: 'DOI 的登記機構。書目最準，摘要涵蓋率看出版社有沒有存進去。',
  },
  {
    host: 'api.unpaywall.org',
    nameZh: 'Unpaywall',
    kind: 'api',
    category: 'scholarly-api',
    expected: 'open',
    probe: null,
    noteZh:
      '**這一個直接回答「這篇有沒有一份合法的開放全文」。** 要帶一個 email 參數，所以沒有探針。',
  },
  {
    host: 'ebi.ac.uk',
    nameZh: 'Europe PMC',
    kind: 'api',
    category: 'scholarly-api',
    expected: 'open',
    probe: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=cyclosa&format=json',
    noteZh: '生醫與生命科學。含全文檢索與預印本，開放全文比 PubMed 多。',
  },
  {
    host: 'eutils.ncbi.nlm.nih.gov',
    nameZh: 'PubMed（E-utilities）',
    kind: 'api',
    category: 'scholarly-api',
    expected: 'open',
    probe: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?retmode=json',
    noteZh: '生醫書目。全文要看那一篇有沒有進 PMC。',
  },
  {
    host: 'api.semanticscholar.org',
    nameZh: 'Semantic Scholar',
    kind: 'api',
    category: 'scholarly-api',
    expected: 'open',
    probe: 'https://api.semanticscholar.org/graph/v1/paper/search?query=spider&limit=1',
    noteZh: '引用關係與 TLDR 摘要。沒有金鑰時限流較緊，撞到就會停。',
  },
  {
    host: 'export.arxiv.org',
    nameZh: 'arXiv',
    kind: 'api',
    category: 'preprint',
    expected: 'open',
    probe: 'https://export.arxiv.org/api/query?search_query=all:spider&max_results=1',
    noteZh: '物理、數學、資訊、量化生物的預印本。**全文一律開放。**',
  },
  {
    host: 'api.biorxiv.org',
    nameZh: 'bioRxiv／medRxiv',
    kind: 'api',
    category: 'preprint',
    expected: 'open',
    probe: 'https://api.biorxiv.org/details/biorxiv/2020-01-01/2020-01-02',
    noteZh: '生物與醫學預印本。**未經同儕審查**，引用時要標明。',
  },
  {
    host: 'ncbi.nlm.nih.gov',
    nameZh: 'PMC 全文庫',
    kind: 'site',
    category: 'open-repository',
    expected: 'open',
    probe: null,
    noteZh: '付費牆論文的合法開放版本經常在這裡。Unpaywall 會直接給你那個網址。',
  },
  {
    host: 'doaj.org',
    nameZh: 'DOAJ',
    kind: 'api',
    category: 'open-repository',
    expected: 'open',
    probe: 'https://doaj.org/api/search/articles/spider?pageSize=1',
    noteZh: '開放取用期刊目錄。收錄在這裡的期刊全文一律免費。',
  },
  {
    host: 'nature.com',
    nameZh: 'Nature',
    kind: 'site',
    category: 'publisher',
    expected: 'mixed',
    probe: null,
    noteZh: '多半要訂閱。**首頁回 200 而文章回 403，所以沒有探針** —— 判斷來自你自己的紀錄。',
  },
  {
    host: 'science.org',
    nameZh: 'Science（AAAS）',
    kind: 'site',
    category: 'publisher',
    expected: 'mixed',
    probe: null,
    noteZh: '多半要訂閱。部分文章在出版半年後開放。',
  },
  {
    host: 'sciencedirect.com',
    nameZh: 'ScienceDirect（Elsevier）',
    kind: 'site',
    category: 'publisher',
    expected: 'login',
    probe: null,
    noteZh: '幾乎都要機構授權。**這是最常撞到的那一個。**',
  },
  {
    host: 'onlinelibrary.wiley.com',
    nameZh: 'Wiley Online Library',
    kind: 'site',
    category: 'publisher',
    expected: 'login',
    probe: null,
    noteZh: '多半要機構授權。',
  },
  {
    host: 'link.springer.com',
    nameZh: 'SpringerLink',
    kind: 'site',
    category: 'publisher',
    expected: 'mixed',
    probe: null,
    noteZh: '開放取用的比例比其他幾家高，但仍然要看單篇。',
  },
  {
    host: 'jstor.org',
    nameZh: 'JSTOR',
    kind: 'site',
    category: 'publisher',
    expected: 'login',
    probe: null,
    noteZh: '人文社科的回溯典藏。幾乎都要機構授權。',
  },
  {
    host: 'airitilibrary.com',
    nameZh: '華藝線上圖書館',
    kind: 'site',
    category: 'publisher',
    expected: 'login',
    probe: null,
    noteZh: '台灣的中文期刊與學位論文。多半要機構授權。',
  },
  {
    host: 'ndltd.ncl.edu.tw',
    nameZh: '臺灣博碩士論文知識加值系統',
    kind: 'site',
    category: 'open-repository',
    expected: 'mixed',
    probe: null,
    noteZh: '書目一律開放，全文看作者有沒有授權。',
  },
  {
    host: 'judgment.judicial.gov.tw',
    nameZh: '司法院裁判書查詢',
    kind: 'site',
    category: 'official',
    expected: 'mixed',
    probe: null,
    noteZh: '判決原文。**查詢介面靠瀏覽器執行程式**，靜態多半抓不到。',
  },
  {
    host: 'data.gov.tw',
    nameZh: '政府資料開放平臺',
    kind: 'site',
    category: 'official',
    expected: 'open',
    probe: null,
    noteZh: '公開資料集。原始出處優先於二手整理。',
  },
  {
    host: 'zh.wikipedia.org',
    nameZh: '維基百科（中文）',
    kind: 'site',
    category: 'reference',
    expected: 'open',
    probe: null,
    noteZh: '**當地圖用，不當出處用** —— 它的價值是把你帶到它的參考文獻。',
  },
  {
    host: 'wikidata.org',
    nameZh: 'Wikidata',
    kind: 'site',
    category: 'reference',
    expected: 'open',
    probe: null,
    noteZh: '實體的權威識別碼（QID）。跨語言對齊靠它，不靠自建對照表。',
  },
];

/** 網域正規化：去掉 `www.`、轉小寫。**比對的鍵。** */
export function normaliseHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

export function catalogByHost(): ReadonlyMap<string, CatalogEntry> {
  return new Map(CATALOG.map((e) => [normaliseHost(e.host), e]));
}
