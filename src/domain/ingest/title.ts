/**
 * 一份檔案匯入之後**叫什麼名字**（2026-10-02）。
 *
 * PDF 檔案裡有一格標題（`Info.Title`），原本只要它不是空的就用它。2026-10-02 拿一本書的 28 章來匯入，
 * 那一格全是 `deeplearningbook.org/contents/linear_algebra.html` 這種 —— 瀏覽器「列印成 PDF」時，
 * 頁面沒有 `<title>` 就把網址填進去。**檔名反而是好的**（`2 Linear Algebra.pdf`），而清單上 28 份
 * 看起來都是一串網址。
 *
 * 所以規則是：**檔案裡的那一格像預設名，就改用檔名**（去副檔名）；檔名也像預設名的話，
 * 留檔案裡的那一格（兩邊都爛的時候，至少不要把一個看得出來源的網址換成 `download (3)`）。
 * 兩邊都像預設名的那一格，之後交給模型讀前幾頁提一個名字 —— 那是使用者按了才改的事，不在這裡。
 *
 * **「像預設名」是一張刻意保守的清單**：網址、帶副檔名的檔名、辦公軟體與掃描器的預設名、
 * 一串雜湊或數字。認錯的代價不對稱 —— 把一個真標題當成預設名，換上的是使用者自己取的檔名（還行）；
 * 把一個網址當成真標題，是現在這個樣子。
 */

/** 去掉最後一個副檔名（只認常見的文件與網頁副檔名，`v1.2` 這種不動）。 */
export function stripDocumentExtension(name: string): string {
  return name.replace(
    /\.(pdf|html?|xhtml|php|aspx?|jsp|docx?|pptx?|xlsx?|odt|rtf|txt|md|epub)$/i,
    '',
  );
}

const URL_LIKE = [
  /^[a-z][a-z0-9+.-]*:\/\//i, // http://、https://、file://
  /^www\./i,
  // 瀏覽器把網址變成檔名時的樣子：`example.org_contents_x.html`、`example.org/contents/x.html`。
  // 點後面要是字母的頂級網域（`.org_`、`.co.uk/`），`Vol.2_Notes` 這種真標題才不會被當成網址。
  /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}[/_\\]/i,
];

const DEFAULT_NAMES = [
  /^untitled(\s+document)?(\s*\d+)?$/i,
  /^(new\s+)?document\s*\d*$/i,
  /^microsoft (word|powerpoint|excel)\s*-\s*/i,
  /^download(\s*\(\d+\))?$/i,
  /^(scan|img|image|dsc|pxl|screenshot)[\s_-]*\d+/i,
  /^(output|print|page|file|export)(\s*\d+)?$/i,
  /^無標題/,
  /^未命名/,
];

/** 一串雜湊或數字（`8f3a9c1e2b`、`20260930_1530`、`000123`）。 */
const OPAQUE = /^[0-9a-f]{8,}$|^[0-9_\-\s]+$/i;

/** 這個名字看起來是機器填的預設名，不是人取的標題。 */
export function looksLikeDefaultName(raw: string): boolean {
  const name = raw.trim();
  if (name.length === 0) return true;
  if (URL_LIKE.some((re) => re.test(name))) return true;
  if (/\.(pdf|html?|xhtml|php|aspx?|jsp|docx?|pptx?|xlsx?|odt|rtf)$/i.test(name)) return true;
  if (DEFAULT_NAMES.some((re) => re.test(name))) return true;
  return OPAQUE.test(name);
}

export interface TitleSources {
  /** 檔案自己帶的標題（PDF 的 `Info.Title`）；沒有就是 `null` */
  readonly embedded: string | null;
  /** 檔名（含副檔名也可以） */
  readonly fileName: string;
}

/** 這份檔案在清單、關聯圖、閱讀器上顯示的名字。 */
export function pickTitle(sources: TitleSources): string {
  const embedded = sources.embedded?.trim() ?? '';
  const fromFile = stripDocumentExtension(sources.fileName.trim());
  if (embedded.length > 0 && !looksLikeDefaultName(embedded)) return embedded;
  if (fromFile.length > 0 && !looksLikeDefaultName(fromFile)) return fromFile;
  // 兩邊都像預設名：留檔案裡的那一格（它多半還看得出來源），再不行才用檔名。
  return embedded.length > 0 ? embedded : fromFile.length > 0 ? fromFile : sources.fileName;
}
