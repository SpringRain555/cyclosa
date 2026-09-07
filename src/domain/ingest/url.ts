/**
 * URL 正規化與同一性判斷。**純函式，零 I/O。**
 *
 * 這一層決定「哪兩個 URL 是同一個東西」，而那個判斷會影響：
 * 節流是不是同一個網域、要不要重抓、`item` 會不會長出兩個。
 */

export type UrlOutcome =
  | { readonly kind: 'ok'; readonly url: string; readonly host: string }
  /** 不是 http／https。`file:`、`javascript:`、`data:` 都走這裡。 */
  | { readonly kind: 'unsupported-scheme'; readonly scheme: string }
  | { readonly kind: 'malformed' };

/**
 * **只接受 http 與 https。**
 *
 * 其餘 scheme 不是「還沒支援」而是**刻意不支援** ——
 * `file:` 會讓擷取管線變成一個任意讀本機檔案的東西，
 * 而本機檔案有自己的入口（匯入檔案），走的是同一條管線的另一個開頭。
 */
export function normalizeUrl(input: string): UrlOutcome {
  const raw = input.trim();
  if (raw.length === 0) return { kind: 'malformed' };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: 'malformed' };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { kind: 'unsupported-scheme', scheme: u.protocol.replace(/:$/, '') };
  }
  if (u.hostname.length === 0) return { kind: 'malformed' };

  // **只拿掉 fragment。** 它本來就不會被送出去，留著只會讓同一個頁面
  // 因為 #section 不同而被當成兩份。
  //
  // **query 一律保留** —— 拿掉 `utm_*` 這種「大家都知道沒用」的參數很誘人，
  // 但那份清單會過期，而且拿錯一個就會抓到不同的內容。
  // 我們寧可多存一份快照，也不要存到一份「不是使用者貼的那一頁」。
  u.hash = '';

  return { kind: 'ok', url: u.toString(), host: u.hostname.toLowerCase() };
}

/**
 * 節流的單位。**是主機名，不是註冊網域。**
 *
 * `a.example.com` 與 `b.example.com` 分開計時，是因為判斷「哪些主機屬於同一個
 * 擁有者」需要一份公共後綴清單（PSL），而那份清單會過期、而且要多一個依賴。
 * **這個選擇偏保守的方向嗎？不是** —— 它可能讓我們對同一個擁有者同時發兩個請求。
 * 代價寫在這裡，觸發條件是「日誌裡出現對同一擁有者的密集請求」。
 */
export function throttleKey(host: string): string {
  return host.toLowerCase();
}

/** 顯示用的網域（作業紀錄表格的「網域」欄）。 */
export function displayHost(url: string): string {
  const out = normalizeUrl(url);
  return out.kind === 'ok' ? out.host : '';
}
