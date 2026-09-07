/**
 * 專題名稱 → 資料夾名稱。
 *
 * **一個專題就是一個資料夾**，而資料夾名稱要能被人看懂 ——
 * 使用者會直接在檔案總管裡搬它、備份它、丟給別人（REQ-0001）。
 * 所以不用 UUID 當資料夾名。
 *
 * 純函式，沒有 I/O。
 */

/**
 * Windows 檔名**真正**不能用的字元 ＋ 控制字元。
 *
 * 空白與連字號**不在這裡** —— 它們在 Windows 檔名裡完全合法，
 * 而且 `toSlug` 會主動產生連字號。把它們列為非法會讓
 * 「`toSlug` 產出的東西過不了 `isUsableSlug`」。
 *
 * **兩個常數是同一組字元的兩種用法**：帶 `g` 的用來取代，不帶的用來檢查 ——
 * 帶 `g` 的 regex 呼叫 `.test()` 會記住 `lastIndex`，
 * 於是同一個輸入連續問兩次會得到不同答案。
 */
const ILLEGAL_PATTERN = '[<>:"/\\\\|?*\\u0000-\\u001f]';
const ILLEGAL_CHAR = new RegExp(ILLEGAL_PATTERN);
const ILLEGAL_CHAR_GLOBAL = new RegExp(ILLEGAL_PATTERN, 'g');

/**
 * Windows 的保留裝置名。**這些名字建不出資料夾**，
 * 而且錯誤訊息完全看不出原因（會說「存取被拒」而不是「這個名字不能用」）。
 */
const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export const MAX_SLUG_LENGTH = 60;

/**
 * **中文保留原樣。** NTFS 支援 unicode 檔名，而把「蓬萊塵蛛」轉成
 * `peng-lai-chen-zhu` 會讓使用者在檔案總管裡認不出自己的專題 ——
 * 那正好違反「一個專題就是一個資料夾，你可以直接搬它」這條設計。
 *
 * 空白與點收斂成連字號：**Windows 會靜默吃掉結尾的點與空白**，
 * 所以 `我的專題.` 建出來的資料夾叫 `我的專題`，之後每次比對都對不上。
 */
export function toSlug(name: string): string {
  let s = name
    .normalize('NFC')
    .replace(ILLEGAL_CHAR_GLOBAL, '')
    .replace(/[\s.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    // 截斷之後可能又留下結尾的連字號
    .replace(/-+$/, '');

  if (s.length > 0 && RESERVED.has(s.toUpperCase())) s = `${s}-case`;
  return s;
}

export function isUsableSlug(slug: string): boolean {
  if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH) return false;
  if (ILLEGAL_CHAR.test(slug)) return false;
  if (RESERVED.has(slug.toUpperCase())) return false;
  // 結尾的點與空白在 Windows 上會被吃掉
  if (/[\s.]$/.test(slug)) return false;
  return true;
}
