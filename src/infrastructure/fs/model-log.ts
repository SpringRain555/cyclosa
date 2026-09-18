/**
 * 把一次模型呼叫寫進專題資料夾。**紀錄的形狀與規矩在
 * `domain/provider/call-record.ts`** —— 這一層只負責寫檔。
 *
 * 位置：`<專題>\model-calls\<run-id>.jsonl`，一次呼叫一行。
 *
 * **一個作業一個檔**，不是全專題一個檔：查的時候問的永遠是
 * 「剛剛那一次跑了什麼」，而一個 5 MB 的大檔要從頭掃。
 * 副檔名照 `manifest.jsonl` 的慣例 —— 這個專案已經有一種「一行一個 JSON」了。
 *
 * ## 寫失敗不能讓作業失敗
 *
 * 這是診斷用的旁支，而**擴展本身不依賴它**。磁碟滿了、檔名衝突、
 * 權限不對 —— 任何一種都只該少一筆紀錄，不該讓一次真的花了錢的抽取整個掉下來。
 * 所以這一支自己吞掉例外並記一行 warn。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { toJsonl, type ModelCallRecord } from '../../domain/provider/call-record.js';
import { logger } from '../../shared/log.js';

export function modelLogDir(caseFolder: string): string {
  return join(caseFolder, 'model-calls');
}

export function modelLogPath(caseFolder: string, runId: string): string {
  return join(modelLogDir(caseFolder), `${runId}.jsonl`);
}

/**
 * 附加一筆。**失敗只記 warn，不丟例外。**
 *
 * `runId` 是空字串的時候寫進 `pending.jsonl` —— 歸納角度那一次呼叫
 * 發生在作業列被建立之前（那一次的結果決定要不要建），
 * **而「還沒有 run id」不是不記錄的理由**。
 */
export async function appendModelCall(caseFolder: string, record: ModelCallRecord): Promise<void> {
  try {
    await mkdir(modelLogDir(caseFolder), { recursive: true });
    const name = record.runId.length > 0 ? record.runId : 'pending';
    await appendFile(join(modelLogDir(caseFolder), `${name}.jsonl`), toJsonl(record), 'utf8');
  } catch (e) {
    logger.warn('模型呼叫紀錄寫不進去', {
      correlationId: record.correlationId,
      runId: record.runId,
      why: String((e as Error).message ?? e),
    });
  }
}
