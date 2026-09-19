/**
 * 量出來的端點事實：「這個端點、這個模型支援哪一種 JSON 模式」，
 * 以及（v0.24.2 起）「它會不會上網搜尋」。
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
 *
 * ## 兩種量測共用這一個檔，所以寫一筆時其餘每一筆原樣留著
 *
 * JSON 格式那一種的鍵是 `位址|模型`；搜尋那一種前面多一段 `browse|`。
 * v0.24.1 之前寫檔是「讀出認得的那幾筆 → 加一筆 → 整份寫回」，
 * 多了第二種之後那樣寫會把**另一種的每一筆都洗掉** —— 所以寫的時候讀原始內容，
 * 只換自己那一個鍵。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { pointerFilePath } from '../fs/paths.js';

export type MeasuredJsonMode = 'schema' | 'object' | 'none';

/**
 * 這個端點走哪一種協定（v0.24.2，ADR-0034）：`responses` 是 Responses API（`/responses`），
 * `chat` 是 Chat Completions（`/chat/completions`）—— **只有 `/responses` 不存在的端點才是後者**。
 */
export type OpenAiProtocol = 'responses' | 'chat';

export interface JsonCheck {
  readonly mode: MeasuredJsonMode;
  /** epoch 毫秒。**畫面上一定要顯示它** —— 見檔頭 */
  readonly checkedAt: number;
  /** 為什麼是這個結果，給人看的。例如「json_schema 被拒：HTTP 400」 */
  readonly detail: string;
  /**
   * 量的時候走的協定。**v0.24.1 之前的紀錄沒有這一欄，讀到就當沒量過**（`isCheck`）——
   * 那些是對 Chat Completions 量的，而現在先走的是 Responses API，同一個端點要重量一次。
   */
  readonly protocol: OpenAiProtocol;
}

/**
 * 「這個端點上的這個模型會不會上網搜尋」（v0.24.2，ADR-0034）。
 *
 * `ok` 只在**回應裡真的有一筆完成的搜尋、而且交回的形狀對**的時候是 `true` ——
 * 「端點收了 `tools` 沒報錯」不算，收了卻安靜忽略的端點正是要擋的那一種。
 */
export interface BrowseCheck {
  readonly ok: boolean;
  /** epoch 毫秒 */
  readonly checkedAt: number;
  /** 為什麼是這個結果：搜了幾次，或對方回了什麼 */
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

const BROWSE_PREFIX = 'browse|';

function isCheck(v: unknown): v is JsonCheck {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r['mode'] === 'schema' || r['mode'] === 'object' || r['mode'] === 'none') &&
    typeof r['checkedAt'] === 'number' &&
    typeof r['detail'] === 'string' &&
    (r['protocol'] === 'responses' || r['protocol'] === 'chat')
  );
}

function isBrowseCheck(v: unknown): v is BrowseCheck {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['ok'] === 'boolean' &&
    typeof r['checkedAt'] === 'number' &&
    typeof r['detail'] === 'string'
  );
}

/** 整份檔的原始內容。**壞掉的檔 ＝ 全部沒量過**，不報錯 —— 下一次跑任務時會重量。 */
async function readRaw(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(await readFile(checksFilePath(env), 'utf8')) as unknown;
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 換掉一個鍵，其餘原樣寫回（見檔頭最後一節）。 */
async function writeEntry(key: string, value: unknown, env: NodeJS.ProcessEnv): Promise<void> {
  const current = await readRaw(env);
  current[key] = value;
  const path = checksFilePath(env);
  await mkdir(dirname(path), { recursive: true });
  // `.json` 一律 UTF-8 無 BOM（CONVENTIONS §8）。
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

export async function readJsonChecks(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadonlyMap<string, JsonCheck>> {
  const raw = await readRaw(env);
  return new Map(
    Object.entries(raw).filter(
      (e): e is [string, JsonCheck] => !e[0].startsWith(BROWSE_PREFIX) && isCheck(e[1]),
    ),
  );
}

export async function writeJsonCheck(
  baseUrl: string,
  model: string,
  check: JsonCheck,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writeEntry(checkKey(baseUrl, model), check, env);
}

/** 搜尋那一種。**鍵跟 JSON 那一種一樣是 `checkKey`**（前綴只存在於檔案裡）。 */
export async function readBrowseChecks(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadonlyMap<string, BrowseCheck>> {
  const raw = await readRaw(env);
  const out = new Map<string, BrowseCheck>();
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith(BROWSE_PREFIX) && isBrowseCheck(value)) {
      out.set(key.slice(BROWSE_PREFIX.length), value);
    }
  }
  return out;
}

export async function writeBrowseCheck(
  baseUrl: string,
  model: string,
  check: BrowseCheck,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await writeEntry(`${BROWSE_PREFIX}${checkKey(baseUrl, model)}`, check, env);
}
