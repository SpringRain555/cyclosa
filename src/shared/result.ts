/**
 * 每個用例都回這個信封，成功與失敗都是。
 *
 * **不丟例外當控制流。** 例外只留給「真的沒預期到」的情況，
 * 而那些在最外層會被包成 `*_UNEXPECTED` ＋ correlationId
 * （REQ-0008：不得出現英文 stack trace 直接噴到使用者畫面上）。
 */
import type { ErrorCode } from '../domain/errors/codes.js';

export type Ok<T> = {
  readonly ok: true;
  readonly data: T;
  readonly correlationId: string;
};

export type Err = {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly correlationId: string;
  /**
   * 給日誌與診斷用的結構化細節。
   *
   * **不進 UI**，而且**不得放來源內容或筆記內容** ——
   * 診斷匯出要去識別化（REQ-0008），最省事的做法是一開始就不要放進來。
   */
  readonly detail?: Readonly<Record<string, unknown>>;
};

export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T, correlationId: string): Ok<T> {
  return { ok: true, data, correlationId };
}

export function err(
  code: ErrorCode,
  correlationId: string,
  detail?: Readonly<Record<string, unknown>>,
): Err {
  return detail === undefined
    ? { ok: false, code, correlationId }
    : { ok: false, code, correlationId, detail };
}

export function isOk<T>(r: Result<T>): r is Ok<T> {
  return r.ok;
}

export function isErr<T>(r: Result<T>): r is Err {
  return !r.ok;
}
