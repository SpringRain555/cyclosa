import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';

/** D14-1：以收到的位元組計算，BOM 也計入上限。 */
export const MAX_NOTE_FILE_BYTES = 1024 * 1024;

export interface NoteFileInput {
  readonly fileName: string;
  readonly body: string;
}

/** 只驗證附件，不寫入資料；儲存與索引由後續的筆記服務負責。 */
export function parseNoteFile(fileName: string, bytes: Uint8Array): Result<NoteFileInput> {
  const cid = correlationId();
  if (bytes.byteLength > MAX_NOTE_FILE_BYTES) return err('NOTE_FILE_TOO_LARGE', cid);
  // 標頭必須是檔名；絕不把使用者傳來的路徑拿去寫檔。
  const hasControl = Array.from(fileName).some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );
  if (!/^.+\.md$/i.test(fileName) || /[\\/]/.test(fileName) || hasControl) {
    return err('NOTE_FILE_UNSUPPORTED', cid);
  }
  try {
    // fatal 拒絕壞編碼；預設會移除開頭的 UTF-8 BOM。
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return ok({ fileName, body }, cid);
  } catch {
    return err('NOTE_FILE_UNSUPPORTED', cid);
  }
}
