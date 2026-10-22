/**
 * **路徑參數在進路由之前先驗過**（ADR-0038 第二部分）。
 *
 * `:slug` 會被 `join(casesDir, slug)` 接成資料夾路徑，`:itemId` 之類會被接成檔名 ——
 * 而 Fastify 會把參數裡的 `%2F` 解碼成 `/`，所以 `/api/cases/..%2F..%2Fx/...`
 * 拿到的 slug 就是 `../../x`。`isUsableSlug` 原本只在建立與改名時問，讀取的每一條路都沒問。
 *
 * 目前沒有一條路真的走得出去：開專題資料庫之前會先看 `case.sqlite` 在不在、不會新建。
 * 但「剛好沒有被利用」不是一道防線 —— 下一個接上檔案路徑的端點就不一定了。
 * 所以統一在這裡擋，路由與 service 不必各自記得。
 *
 * 規則：
 * - `slug` 必須過 `isUsableSlug`（跟建立專題時同一條），否則回 `CASE_NOT_FOUND` ——
 *   一個不可能被建出來的 slug，對應的專題就是不存在。
 * - 其他參數（各種 id、`kind`、`host`…）不得含路徑分隔字元、NUL，也不得是 `.`／`..`，否則 404。
 *   **只擋路徑字元、不驗格式**：id 有 UUID 也有別的形狀，驗格式會在下一種 id 出現時誤擋。
 */
import type { FastifyInstance } from 'fastify';
import { httpStatusOf } from '../../domain/errors/codes.js';
import { isUsableSlug } from '../../domain/case/slug.js';

export type ParamVerdict = 'ok' | 'bad-slug' | 'bad-segment';

export function isSafeSegment(value: string): boolean {
  if (value.length === 0) return false;
  if (value === '.' || value === '..') return false;
  return !/[/\\\0]/.test(value);
}

export function paramVerdict(params: Readonly<Record<string, unknown>>): ParamVerdict {
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== 'string') continue;
    if (name === 'slug') {
      if (!isUsableSlug(value)) return 'bad-slug';
    } else if (!isSafeSegment(value)) {
      return 'bad-segment';
    }
  }
  return 'ok';
}

export function registerParamGuard(app: FastifyInstance): void {
  // `preValidation`：路由已經比對好、`req.params` 已經解碼，handler 還沒跑。
  app.addHook('preValidation', async (req, reply) => {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const verdict = paramVerdict(params);
    if (verdict === 'ok') return;
    if (verdict === 'bad-slug') {
      return reply
        .code(httpStatusOf('CASE_NOT_FOUND'))
        .send({ ok: false, code: 'CASE_NOT_FOUND', correlationId: 'bad-slug' });
    }
    return reply.code(404).send({ ok: false, code: 'NOT_FOUND', message: '找不到這個端點' });
  });
}
