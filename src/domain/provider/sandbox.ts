/**
 * 沙箱裡不該有什麼（ADR-0006 第 5 條、storage-layout）。
 *
 * **驗收條件是「這個目錄裡不得出現任何抓取產物」** ——
 * agent 找到的 URL 一律交回主程式走唯一的擷取管線，
 * 因為節流、robots、雜湊、manifest 只存在於那一層。
 * **開第二條路等於那一層不存在。**
 *
 * ## 為什麼是白名單而不是「看到 HTML 或 PDF 就報」
 *
 * `storage-layout.md` 舉的例子是 HTML 與 PDF，而那是**例子不是清單**。
 * 黑名單漏掉的每一種副檔名都是一個安靜通過的違規
 * （`.mhtml`、`.warc`、`.webp`、沒有副檔名的一坨位元組…）。
 *
 * **這個目錄是我們開的，我們知道自己會放什麼進去**，
 * 所以預設拒絕、只放行那幾種純文字。這跟 repo 的 `.gitignore` 用 allowlist
 * 是同一條理由。
 *
 * 代價寫在這裡：agent 想暫存一個 `.csv` 也會被報成違規。
 * **那是刻意的** —— 誤報的處理方式是「來人看一眼再決定要不要放行」，
 * 而漏報的處理方式是「沒有人會知道」。
 */

/** 沙箱裡放行的副檔名。**小寫比對，一律含點。** */
export const SANDBOX_ALLOWED_EXTENSIONS: readonly string[] = [
  '.json',
  '.jsonl',
  '.md',
  '.txt',
  '.log',
];

function extensionOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at).toLowerCase();
}

/**
 * 回傳違規的檔名。**空陣列代表乾淨。**
 *
 * 傳進來的是相對於沙箱根的路徑（含子目錄），因為
 * 「`downloads/a.html`」跟「`a.html`」要能分辨得出來。
 */
export function sandboxViolations(relativePaths: readonly string[]): readonly string[] {
  return relativePaths.filter((path) => {
    const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
    if (name.length === 0) return false;
    return !SANDBOX_ALLOWED_EXTENSIONS.includes(extensionOf(name));
  });
}
