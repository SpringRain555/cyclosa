/**
 * 內建的來源網站清單。
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
 * ## 兩條正交的軸：類型與領域
 *
 * **類型**（`category`）是固定的一組，因為它驅動行為：出版社沒探針、API 才有探針、
 * 出版社多半要登入。**領域**（`fields`）是自由的多值標籤，回答「誰會用到它」——
 * IEEE Xplore 是出版社 × 資安／資訊科學，PubMed 是書目 API × 生醫。
 *
 * 不用一棵樹（資安 › 新聞 › …）的理由：一棵樹逼每一列只能在一個地方，
 * 而 arXiv 同時是資安、資訊科學、物理的預印本。
 *
 * 領域的值跟 `nameZh` 一樣是資料、存中文字串。內建那幾列用的詞彙在
 * `SOURCE_FIELD_SUGGESTIONS`，畫面拿它當建議 —— 免得「資安」與「資訊安全」各長一份。
 *
 * ## 這一份可以被使用者蓋掉
 *
 * 使用者的增刪改存在 `%LOCALAPPDATA%\Cyclosa\sources.json`，
 * 而這一份跟著程式走。**升級這個工具會更新這份清單，不會動到你改過的那些。**
 */

/** 一個來源是一組可以直接程式化查詢的端點，還是一個給人看的網站。 */
export const SOURCE_KINDS = ['api', 'site'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * 類型。**這一組是唯一的定義** —— 設定檔的讀取（`config.ts`）與 i18n 的中文名
 * 都對著它，守門測試釘著三邊一致。2026-09-16 之前 `config.ts` 自己抄了一份，
 * 加一個類型要改兩處，而漏掉的症狀是使用者存的分類被安靜地退回「參考」。
 */
export const SOURCE_CATEGORIES = [
  /** 開放書目與全文 API */
  'scholarly-api',
  /** 預印本 */
  'preprint',
  /** 開放取用的全文庫 */
  'open-repository',
  /** 出版社與期刊平台 */
  'publisher',
  /** 政府、法規、官方公告 */
  'official',
  /** 百科與參考 */
  'reference',
  /** 資安新聞與分析 */
  'security-news',
  /** 漏洞與 exploit 資料庫 */
  'vulnerability-db',
  /** 社群與論壇 */
  'community',
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/**
 * 領域的建議詞彙。**內建每一列的 `fields` 都從這裡取**（守門測試釘著），
 * 使用者自己加的列可以用別的詞 —— 這是建議不是限制。
 */
export const SOURCE_FIELD_SUGGESTIONS = [
  '通用',
  '資訊科學',
  '資安',
  '生醫',
  '法律',
  '人文社科',
  '物理數學',
] as const;

export interface CatalogEntry {
  /** 網域。**比對用的鍵**，所以不含 `www.`。 */
  readonly host: string;
  readonly nameZh: string;
  readonly kind: SourceKind;
  readonly category: SourceCategory;
  /** 領域。多值；內建的列一定非空（守門測試）。 */
  readonly fields: readonly string[];
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
 *
 * 資安那一批是 2026-09-16 使用者給的清單（`docs/research/security-sources.md`）。
 * 會議與期刊不是網域，進不了這張表 —— 它們寫在對應出版社那一列的備註裡。
 */
export const CATALOG: readonly CatalogEntry[] = [
  {
    host: 'api.openalex.org',
    nameZh: 'OpenAlex',
    kind: 'api',
    category: 'scholarly-api',
    fields: ['通用'],
    expected: 'open',
    probe: 'https://api.openalex.org/works?per-page=1',
    noteZh: '免金鑰的書目資料庫。給一個 DOI 或關鍵字就回作者、機構、引用關係與摘要。',
  },
  {
    host: 'api.crossref.org',
    nameZh: 'Crossref',
    kind: 'api',
    category: 'scholarly-api',
    fields: ['通用'],
    expected: 'open',
    probe: 'https://api.crossref.org/works?rows=1',
    noteZh: 'DOI 的登記機構。書目最準，摘要涵蓋率看出版社有沒有存進去。',
  },
  {
    host: 'api.unpaywall.org',
    nameZh: 'Unpaywall',
    kind: 'api',
    category: 'scholarly-api',
    fields: ['通用'],
    expected: 'open',
    probe: null,
    noteZh: '這一個直接回答「這篇有沒有一份合法的開放全文」。 要帶一個 email 參數，所以沒有探針。',
  },
  {
    host: 'ebi.ac.uk',
    nameZh: 'Europe PMC',
    kind: 'api',
    category: 'scholarly-api',
    fields: ['生醫'],
    expected: 'open',
    probe: 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=cyclosa&format=json',
    noteZh: '生醫與生命科學。含全文檢索與預印本，開放全文比 PubMed 多。',
  },
  {
    host: 'eutils.ncbi.nlm.nih.gov',
    nameZh: 'PubMed（E-utilities）',
    kind: 'api',
    category: 'scholarly-api',
    fields: ['生醫'],
    expected: 'open',
    probe: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/einfo.fcgi?retmode=json',
    noteZh: '生醫書目。全文要看那一篇有沒有進 PMC。',
  },
  {
    host: 'api.semanticscholar.org',
    nameZh: 'Semantic Scholar',
    kind: 'api',
    category: 'scholarly-api',
    fields: ['通用', '資訊科學'],
    expected: 'open',
    probe: 'https://api.semanticscholar.org/graph/v1/paper/search?query=spider&limit=1',
    noteZh: '引用關係與 TLDR 摘要。沒有金鑰時限流較緊，撞到就會停。',
  },
  {
    host: 'dblp.org',
    nameZh: 'dblp',
    kind: 'api',
    category: 'scholarly-api',
    fields: ['資訊科學', '資安'],
    expected: 'open',
    probe: 'https://dblp.org/search/publ/api?q=security&format=json&h=1',
    noteZh: '資訊科學的書目。查一篇論文發表在哪個會議、DOI 是什麼、同一位作者還寫了什麼。',
  },
  {
    host: 'export.arxiv.org',
    nameZh: 'arXiv',
    kind: 'api',
    category: 'preprint',
    fields: ['資訊科學', '資安', '物理數學'],
    expected: 'open',
    probe: 'https://export.arxiv.org/api/query?search_query=all:spider&max_results=1',
    noteZh: '物理、數學、資訊、量化生物的預印本。全文一律開放；資安在 cs.CR。',
  },
  {
    host: 'api.biorxiv.org',
    nameZh: 'bioRxiv／medRxiv',
    kind: 'api',
    category: 'preprint',
    fields: ['生醫'],
    expected: 'open',
    probe: 'https://api.biorxiv.org/details/biorxiv/2020-01-01/2020-01-02',
    noteZh: '生物與醫學預印本。未經同儕審查，引用時要標明。',
  },
  {
    host: 'eprint.iacr.org',
    nameZh: 'IACR ePrint',
    kind: 'site',
    category: 'preprint',
    fields: ['資安', '資訊科學'],
    expected: 'open',
    probe: null,
    noteZh: '密碼學預印本，全文開放。Real World Crypto（RWC）相關的論文多半先出現在這裡。',
  },
  {
    host: 'ncbi.nlm.nih.gov',
    nameZh: 'PMC 全文庫',
    kind: 'site',
    category: 'open-repository',
    fields: ['生醫'],
    expected: 'open',
    probe: null,
    noteZh: '付費牆論文的合法開放版本經常在這裡。Unpaywall 會直接給你那個網址。',
  },
  {
    host: 'doaj.org',
    nameZh: 'DOAJ',
    kind: 'api',
    category: 'open-repository',
    fields: ['通用'],
    expected: 'open',
    probe: 'https://doaj.org/api/search/articles/spider?pageSize=1',
    noteZh: '開放取用期刊目錄。收錄在這裡的期刊全文一律免費。',
  },
  {
    host: 'usenix.org',
    nameZh: 'USENIX',
    kind: 'site',
    category: 'open-repository',
    fields: ['資安', '資訊科學'],
    expected: 'open',
    probe: null,
    noteZh: 'USENIX Security Symposium 的論文全文開放，直接在會議頁上。',
  },
  {
    host: 'ndss-symposium.org',
    nameZh: 'NDSS',
    kind: 'site',
    category: 'open-repository',
    fields: ['資安', '資訊科學'],
    expected: 'open',
    probe: null,
    noteZh: 'Network and Distributed System Security Symposium 的論文全文開放。',
  },
  {
    host: 'nature.com',
    nameZh: 'Nature',
    kind: 'site',
    category: 'publisher',
    fields: ['通用', '生醫'],
    expected: 'mixed',
    probe: null,
    noteZh: '多半要訂閱。首頁回 200 而文章回 403，所以沒有探針 —— 判斷來自你自己的紀錄。',
  },
  {
    host: 'science.org',
    nameZh: 'Science（AAAS）',
    kind: 'site',
    category: 'publisher',
    fields: ['通用'],
    expected: 'mixed',
    probe: null,
    noteZh: '多半要訂閱。部分文章在出版半年後開放。',
  },
  {
    host: 'sciencedirect.com',
    nameZh: 'ScienceDirect（Elsevier）',
    kind: 'site',
    category: 'publisher',
    fields: ['通用'],
    expected: 'login',
    probe: null,
    noteZh: '幾乎都要機構授權。這是最常撞到的那一個。',
  },
  {
    host: 'onlinelibrary.wiley.com',
    nameZh: 'Wiley Online Library',
    kind: 'site',
    category: 'publisher',
    fields: ['通用'],
    expected: 'login',
    probe: null,
    noteZh: '多半要機構授權。',
  },
  {
    host: 'link.springer.com',
    nameZh: 'SpringerLink',
    kind: 'site',
    category: 'publisher',
    fields: ['通用', '資訊科學'],
    expected: 'mixed',
    probe: null,
    noteZh: '開放取用的比例比其他幾家高，但仍然要看單篇。ACNS、DIMVA、RAID 的論文集多半在這裡。',
  },
  {
    host: 'ieeexplore.ieee.org',
    nameZh: 'IEEE Xplore',
    kind: 'site',
    category: 'publisher',
    fields: ['資安', '資訊科學'],
    expected: 'login',
    probe: null,
    noteZh:
      '多半要機構授權。IEEE S&P、Euro S&P、CSF 的論文，以及 TIFS、TDSC、IEEE Security & Privacy 三份期刊多半在這裡。',
  },
  {
    host: 'dl.acm.org',
    nameZh: 'ACM Digital Library',
    kind: 'site',
    category: 'publisher',
    fields: ['資安', '資訊科學'],
    expected: 'login',
    probe: null,
    noteZh: '多半要機構授權。CCS、AsiaCCS、WiSec、ACSAC 的論文與 TOPS 期刊多半在這裡。',
  },
  {
    host: 'jstor.org',
    nameZh: 'JSTOR',
    kind: 'site',
    category: 'publisher',
    fields: ['人文社科'],
    expected: 'login',
    probe: null,
    noteZh: '人文社科的回溯典藏。幾乎都要機構授權。',
  },
  {
    host: 'airitilibrary.com',
    nameZh: '華藝線上圖書館',
    kind: 'site',
    category: 'publisher',
    fields: ['通用', '人文社科'],
    expected: 'login',
    probe: null,
    noteZh: '台灣的中文期刊與學位論文。多半要機構授權。',
  },
  {
    host: 'ndltd.ncl.edu.tw',
    nameZh: '臺灣博碩士論文知識加值系統',
    kind: 'site',
    category: 'open-repository',
    fields: ['通用'],
    expected: 'mixed',
    probe: null,
    noteZh: '書目一律開放，全文看作者有沒有授權。',
  },
  {
    host: 'judgment.judicial.gov.tw',
    nameZh: '司法院裁判書查詢',
    kind: 'site',
    category: 'official',
    fields: ['法律'],
    expected: 'mixed',
    probe: null,
    noteZh: '判決原文。查詢介面靠瀏覽器執行程式，靜態多半抓不到。',
  },
  {
    host: 'data.gov.tw',
    nameZh: '政府資料開放平臺',
    kind: 'site',
    category: 'official',
    fields: ['通用', '法律'],
    expected: 'open',
    probe: null,
    noteZh: '公開資料集。原始出處優先於二手整理。',
  },
  {
    host: 'cve.org',
    nameZh: 'CVE Program',
    kind: 'site',
    category: 'vulnerability-db',
    fields: ['資安'],
    expected: 'open',
    probe: null,
    noteZh: '漏洞編號的正本。舊網址 cve.mitre.org 已轉到這裡；要程式化查詢走 NVD 那一列。',
  },
  {
    host: 'services.nvd.nist.gov',
    nameZh: 'NVD（NIST）',
    kind: 'api',
    category: 'vulnerability-db',
    fields: ['資安'],
    expected: 'open',
    probe: 'https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=1',
    noteZh: 'CVE 的機器可讀版本：CVSS、影響產品、參考連結。沒有金鑰時限流較緊。',
  },
  {
    host: 'exploit-db.com',
    nameZh: 'Exploit Database',
    kind: 'site',
    category: 'vulnerability-db',
    fields: ['資安'],
    expected: 'open',
    probe: null,
    noteZh: '公開的 exploit 與 PoC。內容是資料不是指令 —— 抓回來的程式碼一律只當文字讀。',
  },
  {
    host: 'isc.sans.edu',
    nameZh: 'SANS Internet Storm Center',
    kind: 'api',
    category: 'security-news',
    fields: ['資安'],
    expected: 'open',
    probe: 'https://isc.sans.edu/api/infocon?json',
    noteZh: '每日日誌、事件分析與統計。有文件寫明的 API。',
  },
  {
    host: 'packetstorm.news',
    nameZh: 'Packet Storm Security',
    kind: 'site',
    category: 'security-news',
    fields: ['資安'],
    expected: 'open',
    probe: null,
    noteZh: '新聞、文章與 exploit。',
  },
  {
    host: 'securelist.com',
    nameZh: 'SecureList（Kaspersky）',
    kind: 'site',
    category: 'security-news',
    fields: ['資安'],
    expected: 'open',
    probe: null,
    noteZh: '威脅研究與惡意程式分析。',
  },
  {
    host: 'thehackernews.com',
    nameZh: 'The Hacker News',
    kind: 'site',
    category: 'security-news',
    fields: ['資安'],
    expected: 'open',
    probe: null,
    noteZh: '資安新聞。二手整理居多，找到之後優先追回它引用的原始公告。',
  },
  {
    host: 'thehackpost.com',
    nameZh: 'The Hacker Post',
    kind: 'site',
    category: 'security-news',
    fields: ['資安'],
    expected: 'open',
    probe: null,
    noteZh: '資安新聞。',
  },
  {
    host: 'informationsecurity.com.tw',
    nameZh: '資安人科技網',
    kind: 'site',
    category: 'security-news',
    fields: ['資安'],
    expected: 'open',
    probe: null,
    noteZh: '繁體中文的資安新聞與產業動態。',
  },
  {
    host: 'forums.hak5.org',
    nameZh: 'Hak5 Forum',
    kind: 'site',
    category: 'community',
    fields: ['資安'],
    expected: 'mixed',
    probe: null,
    noteZh: '論壇。部分版面要登入；貼文是個人說法，當線索不當出處。',
  },
  {
    host: 'zh.wikipedia.org',
    nameZh: '維基百科（中文）',
    kind: 'site',
    category: 'reference',
    fields: ['通用'],
    expected: 'open',
    probe: null,
    noteZh: '當地圖用，不當出處用 —— 它的價值是把你帶到它的參考文獻。',
  },
  {
    host: 'wikidata.org',
    nameZh: 'Wikidata',
    kind: 'site',
    category: 'reference',
    fields: ['通用'],
    expected: 'open',
    probe: null,
    noteZh: '實體的權威識別碼（QID）。跨語言對齊靠它，不靠自建對照表。',
  },
  {
    host: 'scholar.google.com',
    nameZh: 'Google Scholar',
    kind: 'site',
    category: 'reference',
    fields: ['通用'],
    expected: 'login',
    probe: null,
    noteZh: 'robots.txt 不准抓，所以這個工具抓不到它。只當人手查的入口 —— 找到的連結自己貼進來。',
  },
];

/** 網域正規化：去掉 `www.`、轉小寫。**比對的鍵。** */
export function normaliseHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, '');
}

/** 領域標籤正規化：去空白、去重、丟掉空的。**不做同義詞合併** —— 那是建議詞彙的工作。 */
export function normaliseFields(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

export function catalogByHost(): ReadonlyMap<string, CatalogEntry> {
  return new Map(CATALOG.map((e) => [normaliseHost(e.host), e]));
}
