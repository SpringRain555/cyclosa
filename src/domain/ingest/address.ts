/**
 * 一個 IP 位址是不是**公開網路上的位址**（ADR-0038）。純函式，零 I/O。
 *
 * 擷取管線抓的網址有三個來源：使用者貼的、找來源的模型交回的、以及對方伺服器的**轉址**。
 * 後兩者都是外部文字決定的 —— 一個網頁只要回 `302 Location: http://127.0.0.1:7433/api/...`，
 * 爬蟲就會替它去敲這台電腦上的本機服務（包括 Cyclosa 自己）或區網裡的設備，
 * 而抓回來的東西會存成快照、送進模型。請求守門（ADR-0036）擋的是瀏覽器送進來的請求，
 * **擋不到爬蟲自己送出去的**。
 *
 * 所以每一跳送出之前，主機名解析出來的每一個位址都要過這一關。
 *
 * **不用 `node:net` 的 `BlockList`**：`domain/` 不 import 任何 node 模組（守門測試）。
 * 這裡只需要「是不是落在幾個保留區段裡」，手寫比引一個模組進來便宜。
 */

export type AddressScope =
  | 'public'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'shared'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  /** 不是一個認得的 IPv4／IPv6 字面值。**當成不安全** —— 認不得就不放行。 */
  | 'invalid';

function parseIPv4(text: string): readonly number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function scopeOfIPv4(o: readonly number[]): AddressScope {
  const [a = 0, b = 0, c = 0] = o;
  if (a === 0) return 'unspecified'; // 0.0.0.0/8 —— 連 0.0.0.0 在多數系統上等於連本機
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'shared'; // CGNAT（RFC 6598）
  if (a === 192 && b === 0 && c === 0) return 'reserved'; // IETF 協定指派（RFC 6890）
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // 效能測試（RFC 2544）
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved'; // 含 255.255.255.255
  return 'public';
}

/** IPv6 字面值 → 8 個 16 位元的組。支援 `::` 縮寫與結尾內嵌 IPv4。 */
function parseIPv6(text: string): readonly number[] | null {
  let s = text;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.length === 0) return null;

  // 結尾內嵌的 IPv4（`::ffff:127.0.0.1`）先換成兩組十六進位
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (h: string): string[] => (h.length === 0 ? [] : h.split(':'));
  const head = groupsOf(halves[0] ?? '');
  const rest = halves.length === 2 ? groupsOf(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const out: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function scopeOfIPv6(g: readonly number[]): AddressScope {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const zeroHead = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (zeroHead && g5 === 0 && g6 === 0 && g7 === 0) return 'unspecified';
  if (zeroHead && g5 === 0 && g6 === 0 && g7 === 1) return 'loopback';
  // IPv4-mapped（::ffff:a.b.c.d）與 IPv4-compatible（::a.b.c.d）：**照裡面那個 IPv4 判**，
  // 否則 `[::ffff:127.0.0.1]` 就是一條繞過 IPv4 規則的路
  if (zeroHead && (g5 === 0xffff || g5 === 0)) {
    return scopeOfIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  // NAT64（64:ff9b::/96）同理
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return scopeOfIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return 'private'; // fec0::/10 site-local（已廢止，仍有人用）
  if ((g0 & 0xff00) === 0xff00) return 'multicast';
  if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved'; // 文件用
  return 'public';
}

/**
 * 判斷一個 IP 字面值的範圍。IPv6 可以帶或不帶方括號（URL 的 hostname 帶、DNS 解析結果不帶）。
 */
export function addressScope(ip: string): AddressScope {
  const text = ip.trim().replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(text);
  if (v4 !== null) return scopeOfIPv4(v4);
  if (text.includes(':')) {
    const v6 = parseIPv6(text);
    if (v6 !== null) return scopeOfIPv6(v6);
  }
  return 'invalid';
}
