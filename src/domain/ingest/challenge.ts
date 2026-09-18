/**
 * 「這一頁是內容，還是一張反爬蟲的驗證頁？」
 *
 * ## 為什麼需要這個判斷
 *
 * 2026-09-16 我們把 dblp 的探針寫進內建清單，依據是「它回 200、content-type 是
 * text/html」。**那一頁是 Anubis 的驗證頁**，而探測只看錯誤碼，所以清單上它是「讀得到」，
 * 而同一版的清單第一次進了 agent 的提示詞 —— 一個錯的事實被送進模型。
 *
 * **狀態碼不是內容的證據。** 一張驗證頁會用 200 回應，因為對瀏覽器來說它確實成功了：
 * 那一頁本來就是要被執行的。對這個工具來說它是一次失敗，而且是最糟的那一種 ——
 * 安靜的失敗，把驗證頁的文字當成正文存進專題。
 *
 * ## 三層，由強到弱（2026-09-18 定，open-questions Q7）
 *
 * | 層 | 依據 | 結論 |
 * |---|---|---|
 * | 1 | **要的型別與拿到的型別矛盾**：我們問的是一支 API，回來的是 HTML | `challenge` |
 * | 2 | **廠商自己宣告的信號**：`cf-mitigated: challenge`、頁面裡的 Anubis 標記 | `challenge` |
 * | 3 | 結構上的弱信號**全部同時成立**：HTML ＋ 自稱 noindex ＋ 很小 ＋ 不准快取 | `suspect` |
 *
 * **第一層最強而且零猜測** —— 它不需要知道世界上有哪些反爬蟲產品，
 * 只需要知道我們自己要的是什麼。dblp 那一次，第一層就足夠了。
 *
 * **第二層是一份會過期的清單**，所以每一條都帶出處與日期，而且只收
 * 「廠商自己放上去、用來表明這是驗證頁」的東西 —— 不收「看起來很像」的字眼。
 * 反例：Cloudflare 的 JS Detection 會把 `__CF$cv$params` 注入**正常的內容頁**，
 * 所以那個字串不是驗證頁的證據，這裡不收它。
 *
 * **第三層永遠不下定論**，只回 `suspect`：它的意思是「別存，讓人看一眼」。
 * 四個條件要同時成立才算，因為每一個單獨看都會誤判正常的頁面。
 *
 * > 這一份刻意不列「Just a moment…」「Checking your browser」這種標題字串。
 * > Q2 的教訓是憑印象列出來的標記清單在真實頁面上一次都沒命中，
 * > 而標題會隨產品改版與語系變，出處也無法查證。
 *
 * ⚠️ 純函式，零依賴。
 */

/**
 * 呼叫的人**要的是什麼型別**。
 *
 * `data` ＝ 這是一支 API，回來的應該是機器格式（JSON／XML／Atom…），
 * **不可能是 HTML 網頁**。內建清單裡有探針的每一列都是 `kind: 'api'`，
 * 所以探測一律用這個值。
 *
 * `any` ＝ 使用者貼進來的一般網址，HTML 是正常的。
 */
export type FetchExpect = 'data' | 'any';

/** `content` 照常處理；`challenge` 不存；`suspect` 也不存，但理由要說成「不確定」。 */
export type ContentVerdict = 'content' | 'challenge' | 'suspect';

export interface ChallengeVerdict {
  readonly verdict: ContentVerdict;
  /** 哪一層判的。`content` 時是 `null`。 */
  readonly basis: 'expected-type' | 'vendor' | 'weak' | null;
  /** 第二層才有：是哪一個產品。**寫進 detail 與日誌，不進 UI 字串。** */
  readonly vendor: string | null;
}

const CONTENT: ChallengeVerdict = { verdict: 'content', basis: null, vendor: null };

/**
 * 掃標記時只看內文的前面這麼多字元。
 *
 * 驗證頁整頁都很小（實測 dblp 那一張是 7.5 KB），而一份真正的長文
 * 不應該為了找標記被整篇掃一遍。
 */
export const MARKER_SCAN_CHARS = 16 * 1024;

/**
 * 第三層的「很小」。
 *
 * 20,000 這個數字跟 `extract-confidence.ts` 的 `looksJsOnly` 是同一個 ——
 * 那一支的門檻是「HTML 至少要有這麼長才談得上是 JS-only」，
 * 而**驗證頁正好落在它下面**，所以那條規則永遠看不到它。這一層補的就是那個洞。
 */
export const WEAK_MAX_BYTES = 20_000;

/**
 * 廠商自己宣告的**標頭**。
 *
 * | 產品 | 依據 |
 * |---|---|
 * | Cloudflare | 官方文件「Detect a Challenge Page response」：任何類型的挑戰頁都會帶 `cf-mitigated: challenge`，而且 `challenge` 是這個標頭唯一的合法值（2026-09-18 查） |
 *
 * **加一條之前要有出處** —— 這裡不收從部落格抄來的欄位名。
 */
const VENDOR_HEADERS: readonly {
  readonly header: string;
  readonly value: string;
  readonly vendor: string;
}[] = [{ header: 'cf-mitigated', value: 'challenge', vendor: 'cloudflare' }];

/**
 * 廠商自己放進**頁面**的標記。
 *
 * | 產品 | 標記 | 依據 |
 * |---|---|---|
 * | Anubis | `id="anubis_version"`、樣式表路徑 `/.within.website/x/xess` | 2026-09-18 實際抓 `dblp.org` 的探針網址，回應是 200 ＋ text/html ＋ 這兩個標記 |
 *
 * 兩條都是產品自己的識別字（版本標籤與它自家的靜態資源路徑），
 * 不是「看起來像」的句子。
 */
const VENDOR_BODY: readonly { readonly needle: string; readonly vendor: string }[] = [
  { needle: 'id="anubis_version"', vendor: 'anubis' },
  { needle: '/.within.website/x/xess', vendor: 'anubis' },
];

/** `<meta name="robots" … content="…noindex…">` —— 驗證頁會自己說別收錄它。 */
const META_NOINDEX = /<meta[^>]+name=["']?robots["']?[^>]*content=["']?[^"'>]*noindex/i;

function isHtml(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.toLowerCase();
  return type.includes('text/html') || type.includes('application/xhtml');
}

/**
 * 只看標頭的那一半。**錯誤狀態碼上也要能問** ——
 * 401／403 現在一律記成「要登入」，而一個帶著 `cf-mitigated` 的 403
 * 不是要登入，是這個站對工具關門。兩者給使用者的建議完全不同。
 */
export function vendorChallengeHeader(headers: Readonly<Record<string, string>>): string | null {
  for (const marker of VENDOR_HEADERS) {
    const got = headers[marker.header];
    if (typeof got === 'string' && got.toLowerCase().includes(marker.value)) return marker.vendor;
  }
  return null;
}

export interface HttpFacts {
  /** 標頭，**鍵一律小寫**（`Headers` 迭代出來就是小寫）。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly contentType: string | null;
  /** 整份內容有多少 bytes。第三層的「很小」看這個，不是看 `bodyHead` 的長度。 */
  readonly bodySize: number;
  /** 解碼過的內文開頭（最多 `MARKER_SCAN_CHARS`）。不是文字型別就給空字串。 */
  readonly bodyHead: string;
  readonly expect: FetchExpect;
}

/**
 * 三層一次問完。**呼叫的人只需要看 `verdict`。**
 *
 * 順序就是強度：第一層成立就不必再問後面兩層，
 * 而第三層永遠只回 `suspect`。
 */
export function classifyChallenge(facts: HttpFacts): ChallengeVerdict {
  // 第一層：要的是機器格式，回來的是網頁。**這一層不需要認得任何產品。**
  if (facts.expect === 'data' && isHtml(facts.contentType)) {
    return { verdict: 'challenge', basis: 'expected-type', vendor: null };
  }

  // 第二層：廠商自己說的。
  const byHeader = vendorChallengeHeader(facts.headers);
  if (byHeader !== null) return { verdict: 'challenge', basis: 'vendor', vendor: byHeader };

  const head = facts.bodyHead.slice(0, MARKER_SCAN_CHARS);
  for (const marker of VENDOR_BODY) {
    if (head.includes(marker.needle)) {
      return { verdict: 'challenge', basis: 'vendor', vendor: marker.vendor };
    }
  }

  // 第三層：四個弱信號**全部**成立才算，而且只到「不確定」。
  const cacheControl = (facts.headers['cache-control'] ?? '').toLowerCase();
  const weak =
    isHtml(facts.contentType) &&
    facts.bodySize > 0 &&
    facts.bodySize < WEAK_MAX_BYTES &&
    cacheControl.includes('no-store') &&
    META_NOINDEX.test(head);
  if (weak) return { verdict: 'suspect', basis: 'weak', vendor: null };

  return CONTENT;
}
