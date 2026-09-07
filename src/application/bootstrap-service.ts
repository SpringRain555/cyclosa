/**
 * 指標檔與資料根的啟動流程。
 *
 * **這一層的全部工作是把四種失敗轉成四個不同的錯誤碼**，
 * 因為使用者要做的事完全不同（REQ-0001：不要顯示一個空清單）。
 */
import {
  ensureDataRootLayout,
  resolveDataRoot,
  writePointerFile,
  type ResolveOutcome,
} from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';

export interface DataRootInfo {
  readonly dataRoot: string;
  readonly pointerPath: string;
}

/**
 * 每一種失敗都帶著**指標檔在哪**，而路徑相關的那幾種還帶著**它指到哪**。
 *
 * 這些欄位會一路帶到 UI —— 訊息本身在 `web/src/i18n/zh-TW.ts`，
 * 這裡只提供它需要的變數。**碼不進 UI，訊息不進這裡。**
 */
export async function resolveDataRootOrExplain(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<DataRootInfo>> {
  const cid = correlationId();
  const outcome: ResolveOutcome = await resolveDataRoot(env);

  switch (outcome.kind) {
    case 'ok':
      return ok({ dataRoot: outcome.dataRoot, pointerPath: outcome.pointerPath }, cid);

    case 'pointer-missing':
      return err('IO_POINTER_MISSING', cid, { pointerPath: outcome.pointerPath });

    case 'pointer-malformed':
      return err('IO_POINTER_MALFORMED', cid, {
        pointerPath: outcome.pointerPath,
        reason: outcome.reason,
      });

    case 'data-root-missing':
      return err('IO_DATA_ROOT_MISSING', cid, {
        pointerPath: outcome.pointerPath,
        dataRoot: outcome.dataRoot,
      });

    case 'data-root-not-writable':
      return err('IO_DATA_ROOT_NOT_WRITABLE', cid, {
        pointerPath: outcome.pointerPath,
        dataRoot: outcome.dataRoot,
      });
  }
}

/**
 * 使用者選了一個資料根之後：建四個頂層資料夾，寫指標檔。
 *
 * **順序不能反** —— 先確認建得起來再寫指標檔，
 * 否則會留下一個指向建不起來的地方的指標檔，而下次啟動看到的是
 * `IO_DATA_ROOT_NOT_WRITABLE` 而不是「你上次選的地方不能用」。
 */
export async function initDataRoot(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<DataRootInfo>> {
  const cid = correlationId();
  try {
    await ensureDataRootLayout(dataRoot);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC') return err('IO_DISK_FULL', cid, { dataRoot });
    return err('IO_DATA_ROOT_NOT_WRITABLE', cid, { dataRoot });
  }

  try {
    const pointerPath = await writePointerFile(dataRoot, env);
    return ok({ dataRoot, pointerPath }, cid);
  } catch {
    return err('IO_UNEXPECTED', cid, { at: 'write-pointer' });
  }
}
