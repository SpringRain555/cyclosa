/**
 * 一個來源網站「現在讀不讀得到」的判斷（Stage 10.5）。
 *
 * ## 為什麼這件事需要一組規則，而不是一個布林
 *
 * 2026-09-08 第一次真的跑一次擴展：agent 找到 6 個學術來源，**5 個是付費牆**。
 * 成功率 17%，而每一次無效的嘗試都花了時間與錢。
 *
 * 直覺的做法是「先探測一下這個站活不活著」。**那個做法幾乎沒有用**：
 * 出版社的首頁一律回 200，而文章回 403。
 * **「這個站活著」與「這個站的內容我讀得到」是兩個問題，而使用者要的是第二個。**
 *
 * 所以這裡的判斷有兩個來源，而**先看的是自己的紀錄**：
 *
 * | 來源 | 性質 |
 * |---|---|
 * | **你自己抓過的結果** | 真的發生過的事，**而且不花任何一個請求** |
 * | 探針 | 只用在沒抓過的網域，而且探的是一篇代表性文章，不是首頁 |
 *
 * ## 判斷帶時間，因為它是某個時刻的事實
 *
 * 出版社改政策、機構授權到期，隔天就不一樣了。
 * **「兩天前檢查：需要登入」比「需要登入」誠實。**
 *
 * ⚠️ 純函式，零依賴。
 */

/** 一個網站的可讀取程度。**這是判斷，不是設定。** */
export type SiteAccess =
  /** 抓得到而且抽得出正文 */
  | 'open'
  /** 需要登入或訂閱（401／403）—— **不繞過，交給人工取得** */
  | 'login'
  /** 對方限流中（429／503）—— **立刻停，不重試** */
  | 'throttled'
  /** 連不到（DNS／TLS／逾時）或對方回錯 */
  | 'unreachable'
  /** robots.txt 不准 */
  | 'disallowed'
  /** 靜態抓不到，正文要靠瀏覽器執行程式才會出現 */
  | 'js-only'
  /** 沒有任何依據 —— **沒抓過，也還沒探測過** */
  | 'unknown';

/**
 * 擷取的錯誤碼 → 這個網站的可讀取程度。
 *
 * **這張表刻意跟 `error-codes.md` 一對一**，而不是自己另立一套分類 ——
 * 兩套分類會漂，而且使用者在作業紀錄上看到的字要跟這裡一致。
 */
export function accessFromCode(code: string | null): SiteAccess {
  if (code === null) return 'open';
  switch (code) {
    case 'FETCH_LOGIN_REQUIRED':
      return 'login';
    case 'FETCH_RATE_LIMITED':
      return 'throttled';
    case 'FETCH_ROBOTS_DISALLOWED':
      return 'disallowed';
    case 'PARSE_JS_ONLY':
      return 'js-only';
    case 'FETCH_DNS':
    case 'FETCH_TLS':
    case 'FETCH_TIMEOUT':
    case 'FETCH_HTTP_4XX':
    case 'FETCH_HTTP_5XX':
      return 'unreachable';
    default:
      // 抽取信心低、重複、型別不支援…… 這些**不是網站的問題**。
      return 'open';
  }
}

/** 這個網域上發生過的事。`run_item` 聚合出來的。 */
export interface SiteHistory {
  readonly attempts: number;
  readonly byAccess: Readonly<Partial<Record<SiteAccess, number>>>;
  readonly lastAt: number | null;
  readonly lastCode: string | null;
}

export const EMPTY_HISTORY: SiteHistory = {
  attempts: 0,
  byAccess: {},
  lastAt: null,
  lastCode: null,
};

/**
 * 一次探測的結果。
 *
 * `at` 是**必要欄位**：一個沒有時間的檢查結果會被當成永久的事實，
 * 而它不是。
 */
export interface SiteProbe {
  readonly access: SiteAccess;
  readonly code: string | null;
  readonly at: number;
  /** 探的是哪一個網址。**不是首頁** —— 首頁的 200 什麼都不代表。 */
  readonly url: string;
}

/**
 * 把紀錄與探針合成一個要顯示的判斷。
 *
 * **紀錄優先於探針**，而且理由不是它比較新：
 * 探針探的是**一篇**代表性文章，紀錄是**你真的想讀的那些**。
 * 一個機構授權涵蓋了某本期刊而不涵蓋另一本的時候，只有紀錄看得出來。
 */
export interface SiteVerdict {
  readonly access: SiteAccess;
  /** 這個判斷是從哪來的 —— **畫面上要說出來**。 */
  readonly basis: 'history' | 'probe' | 'none';
  readonly at: number | null;
  /** 抓過幾次。0 代表這個判斷完全來自探針。 */
  readonly attempts: number;
}

/**
 * 多數決，而**「需要登入」在平手時勝出**。
 *
 * 兩種錯的代價不對稱：把一個其實讀得到的站標成要登入，
 * 使用者頂多多看一眼；把一個要登入的站標成讀得到，
 * agent 會一直往那裡找，而**每一次都要花錢才發現**。
 */
const TIE_BREAK: readonly SiteAccess[] = [
  'login',
  'disallowed',
  'js-only',
  'throttled',
  'unreachable',
  'open',
];

export function verdictOf(history: SiteHistory, probe: SiteProbe | null): SiteVerdict {
  if (history.attempts > 0) {
    let best: SiteAccess = 'open';
    let bestCount = -1;
    for (const access of TIE_BREAK) {
      const n = history.byAccess[access] ?? 0;
      if (n > bestCount) {
        best = access;
        bestCount = n;
      }
    }
    return { access: best, basis: 'history', at: history.lastAt, attempts: history.attempts };
  }
  if (probe !== null) {
    return { access: probe.access, basis: 'probe', at: probe.at, attempts: 0 };
  }
  return { access: 'unknown', basis: 'none', at: null, attempts: 0 };
}

/**
 * agent 該不該優先往這個網域找。
 *
 * **「不優先」不是「封鎖」。** 一篇讀不到的重要論文仍然值得出現在
 * 「待人工取得」清單上 —— 擋掉它等於假裝那篇論文不存在。
 * 這支只影響排序與提示詞裡的建議，不影響任何一條 URL 能不能被送進管線。
 */
export function preferenceOf(verdict: SiteVerdict): 'prefer' | 'neutral' | 'deprioritise' {
  if (verdict.access === 'open') return 'prefer';
  if (verdict.access === 'unknown') return 'neutral';
  return 'deprioritise';
}
