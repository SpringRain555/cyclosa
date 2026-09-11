/**
 * 一份 JSON 是不是符合一份 JSON Schema —— **這個工具用得到的那一小塊**。
 *
 * ## 為什麼需要它（Stage 16）
 *
 * 本機 Ollama 的 `format` 用受限解碼**保證**輸出符合 schema，所以在那之前
 * 這個工具從來不需要自己驗。線上的 OpenAI 相容端點不一定有那個保證：
 * 有的收 `response_format: json_schema` 並真的套用，有的只到 `json_object`
 * （「回一份 JSON」，形狀不管），有的收了卻安靜地忽略。
 *
 * 那一層防護是 `expansion-prompts.ts` 檔頭寫的「三層」的第二層：
 * **能通過的只有實體與關係**，吐不出「執行某個動作」這種形狀的東西。
 * 端點不保證的時候，**同一個性質改由這裡保證** —— 機制從「生不出來」
 * 變成「生出來會被擋」，而那個性質本身沒有變。
 *
 * **所以這裡一律拒絕，不做「盡量解析」。** 一個形狀不對的輸出不是
 * 「少了幾個欄位的好輸出」，是一個沒有被限制過的輸出。
 *
 * ## 只支援用得到的關鍵字，**不認得的一律判不通過**
 *
 * 三份 schema（`ANGLES`／`SOURCES`／`EXTRACT`）用到的是八個關鍵字，
 * 另加格式探針要的三個。**遇到清單外的關鍵字不能略過** ——
 * 略過的意思是「那一條限制沒有被檢查，而結果寫著通過」。
 * `tests/guards/schema-keywords.test.ts` 釘住三份 schema 只用得到這些。
 *
 * 不引套件（ajv 之類）：domain 零相依（ADR-0002 的邊界），
 * 而這一小塊短到值得自己寫、自己測。
 */

export const SUPPORTED_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'enum',
  'minimum',
  'maximum',
] as const;

/** 允許出現、但不構成限制的註記。**它們不影響「符不符合」**，所以放行是對的。 */
const ANNOTATIONS = new Set(['description', 'title', '$schema']);

export type SchemaVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** 第一個不符合的地方，例如 `$.relations[3].quote`。**給人看的，不是給程式判斷的** */
      readonly path: string;
      readonly reason: string;
    };

type Schema = Readonly<Record<string, unknown>>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(want: string, value: unknown): boolean {
  const got = typeOf(value);
  // JSON Schema 的 `number` 包含整數；`integer` 不包含小數。
  return want === got || (want === 'number' && got === 'integer');
}

/** 字串長度用**碼位**算，不是 UTF-16 單位 —— JSON Schema 規定的是前者。 */
function lengthOf(s: string): number {
  return [...s].length;
}

function fail(path: string, reason: string): SchemaVerdict {
  return { ok: false, path, reason };
}

function check(schema: Schema, value: unknown, path: string): SchemaVerdict {
  for (const key of Object.keys(schema)) {
    if (!(SUPPORTED_KEYWORDS as readonly string[]).includes(key) && !ANNOTATIONS.has(key)) {
      // **不認得就不通過。** 見檔頭。
      return fail(path, `schema 用了這裡不支援的關鍵字 ${key}，無法確認它有被遵守`);
    }
  }

  const type = schema['type'];
  if (typeof type === 'string' && !typeMatches(type, value)) {
    return fail(path, `應該是 ${type}，實際是 ${typeOf(value)}`);
  }

  const allowed = schema['enum'];
  if (Array.isArray(allowed) && !allowed.some((v) => v === value)) {
    return fail(path, '不在允許的值裡');
  }

  if (typeof value === 'string') {
    const n = lengthOf(value);
    const min = schema['minLength'];
    const max = schema['maxLength'];
    if (typeof min === 'number' && n < min) return fail(path, `長度 ${n} < ${min}`);
    if (typeof max === 'number' && n > max) return fail(path, `長度 ${n} > ${max}`);
  }

  if (typeof value === 'number') {
    const min = schema['minimum'];
    const max = schema['maximum'];
    if (typeof min === 'number' && value < min) return fail(path, `${value} < ${min}`);
    if (typeof max === 'number' && value > max) return fail(path, `${value} > ${max}`);
  }

  if (Array.isArray(value)) {
    const min = schema['minItems'];
    const max = schema['maxItems'];
    if (typeof min === 'number' && value.length < min) {
      return fail(path, `${value.length} 項 < ${min}`);
    }
    if (typeof max === 'number' && value.length > max) {
      return fail(path, `${value.length} 項 > ${max}`);
    }
    const items = schema['items'];
    if (typeof items === 'object' && items !== null) {
      for (let i = 0; i < value.length; i++) {
        const r = check(items as Schema, value[i], `${path}[${i}]`);
        if (!r.ok) return r;
      }
    }
  }

  if (typeOf(value) === 'object') {
    const obj = value as Readonly<Record<string, unknown>>;
    const props =
      typeof schema['properties'] === 'object' && schema['properties'] !== null
        ? (schema['properties'] as Readonly<Record<string, Schema>>)
        : {};
    const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
    for (const key of required) {
      if (!(key in obj)) return fail(`${path}.${key}`, '缺少必要欄位');
    }
    if (schema['additionalProperties'] === false) {
      const extra = Object.keys(obj).find((k) => !(k in props));
      if (extra !== undefined) return fail(`${path}.${extra}`, '不在 schema 裡的欄位');
    }
    for (const [key, sub] of Object.entries(props)) {
      if (!(key in obj)) continue;
      const r = check(sub, obj[key], `${path}.${key}`);
      if (!r.ok) return r;
    }
  }

  return { ok: true };
}

/**
 * **這份值符不符合這份 schema。** 不符合的話帶回第一個不符合的地方。
 *
 * 只回第一個是刻意的：這一支的用途是「擋下來」，不是「列出所有錯」——
 * 一個形狀不對的模型輸出，錯一個跟錯十個的處置是一樣的。
 */
export function conformsTo(schema: Schema, value: unknown): SchemaVerdict {
  return check(schema, value, '$');
}
