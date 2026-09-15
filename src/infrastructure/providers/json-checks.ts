/**
 * 「這個端點、這個模型支援哪一種 JSON 模式」的量測結果。
 *
 * 放在 `%LOCALAPPDATA%\Cyclosa\provider-checks.json`。
 *
 * ## 為什麼不跟 `providers.json` 放在一起
 *
 * `providers.json` 是**使用者選的**（連到哪、用哪個模型、金鑰在哪個變數）；
 * 這一份是**量出來的**。兩者壞掉的方式不一樣：
 * 設定錯了是使用者要改的東西，量測舊了是按一顆「重新檢查」的事。
 * 混在一起的話，「存設定」會把一份量測蓋掉，或反過來。
 *
 * ## 為什麼要快取，又為什麼不過期
 *
 * 一次量測是**一到兩次真的請求**，而線上端點會計費。
 * 每跑一次任務就量一次，等於替每一次擴展多付一筆使用者沒看到的錢。
 *
 * 不設過期時間，因為「多久算舊」沒有一個誠實的數字 —— 所以改成
 * **每一筆都帶著量的時間，畫面上照實顯示**，旁邊一顆「重新檢查」。
 * 那是 v0.7.0 來源清單的同一個做法：「依你抓過的 3 次」與
 * 「依一次檢查」如果長得一樣，使用者就會把後者當成前者。
 *
 * **只在 `openai` 傳輸上用。** 本機 Ollama 的原生 `format` 永遠是受限解碼，
 * 那是那條協定的定義，不是量出來的。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { pointerFilePath } from '../fs/paths.js';

export type MeasuredJsonMode = 'schema' | 'object' | 'none';

export interface JsonCheck {
  readonly mode: MeasuredJsonMode;
  /** epoch 毫秒。**畫面上一定要顯示它** —— 見檔頭 */
  readonly checkedAt: number;
  /** 為什麼是這個結果，給人看的。例如「json_schema 被拒：HTTP 400」 */
  readonly detail: string;
}

export function checksFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(pointerFilePath(env)), 'provider-checks.json');
}

/**
 * 同一個模型在兩個端點上是兩件事，同一個端點上的兩個模型也是 ——
 * 支援度可以按模型而異（有的伺服器只對部分模型開受限解碼）。
 * 位址先去掉結尾斜線，免得同一個端點記成兩筆。
 */
export function checkKey(baseUrl: string, model: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}|${model.trim()}`;
}

function isCheck(v: unknown): v is JsonCheck {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r['mode'] === 'schema' || r['mode'] === 'object' || r['mode'] === 'none') &&
    typeof r['checkedAt'] === 'number' &&
    typeof r['detail'] === 'string'
  );
}

/** **壞掉的檔 ＝ 全部沒量過**，不報錯 —— 下一次跑任務時會重量，代價是一次請求。 */
export async function readJsonChecks(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadonlyMap<string, JsonCheck>> {
  try {
    const raw = JSON.parse(await readFile(checksFilePath(env), 'utf8')) as Record<string, unknown>;
    return new Map(Object.entries(raw).filter((e): e is [string, JsonCheck] => isCheck(e[1])));
  } catch {
    return new Map();
  }
}

export async function writeJsonCheck(
  baseUrl: string,
  model: string,
  check: JsonCheck,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const current = new Map(await readJsonChecks(env));
  current.set(checkKey(baseUrl, model), check);
  const path = checksFilePath(env);
  await mkdir(dirname(path), { recursive: true });
  // `.json` 一律 UTF-8 無 BOM（CONVENTIONS §8）。
  await writeFile(path, `${JSON.stringify(Object.fromEntries(current), null, 2)}\n`, 'utf8');
}
