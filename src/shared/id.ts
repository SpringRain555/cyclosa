import { randomBytes, randomUUID } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value: bigint, length: number): string {
  let out = '';
  let v = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(v % 32n)] + out;
    v /= 32n;
  }
  return out;
}

/**
 * 操作識別碼。**UI 上要能複製**（REQ-0008），所以它不能是 UUID 那種長度。
 *
 * 前 10 碼是毫秒時間戳（Crockford base32），後 6 碼隨機 ——
 * 好處是**在日誌裡按字典序排就是時間序**，而使用者回報時只要唸 16 個字。
 * 沒有用 UUID 是因為 36 個字沒有人願意抄。
 */
export function correlationId(now: number = Date.now()): string {
  const time = encode(BigInt(now), 10);
  const rand = randomBytes(4).readUInt32BE(0);
  return `${time}${encode(BigInt(rand), 6)}`;
}

/** 資料列的 id。這個不給人看，所以用 UUID 沒關係。 */
export function newId(): string {
  return randomUUID();
}
