/**
 * 把模型的抽取結果整理成「實體 ＋ 具名關係」。
 *
 * ## 這一階段產生的是哪幾種邊
 *
 * | 層 | 誰連誰 | 要出處嗎 | 進裁決佇列嗎 |
 * |---|---|:--:|:--:|
 * | `comention` | `item` → `entity`（這一份提到這個實體）| 否 | **否**（可重算，Q6）|
 * | `named` | `entity` → `entity`（一個主張）| **要** | **是** |
 *
 * `comention` 是二分圖的骨架，投影三段決定它畫成什麼（ADR-0015）。
 * **`named` 才是主張**，而主張要能被檢查 —— 所以它一定帶引文。
 *
 * ## 為什麼關係的兩端一定要是宣告過的實體
 *
 * 模型很容易在關係裡冒出一個沒有在實體清單裡出現過的名字
 * （通常是同一個東西的另一種寫法）。照收的話會產生**兩個看起來一樣的節點**，
 * 而使用者沒有合併它們的工具。**對不上就丟掉那一條關係，不新增節點。**
 */

/** `entity.type` 的六個值。**這裡是給模型的 enum，也是丟棄的依據。** */
export const ENTITY_TYPES = ['person', 'org', 'place', 'event', 'work', 'concept'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

const MAX_NAME_CHARS = 80;
const MAX_REL_CHARS = 40;
const MAX_ENTITIES = 20;
const MAX_RELATIONS = 20;

export interface EntityDraft {
  readonly name: string;
  readonly type: EntityType;
}

export interface RelationDraft {
  readonly subject: string;
  readonly rel: string;
  readonly object: string;
  /** 原文裡的一句話。**位置不在這裡** —— 位置由 `locateQuote` 自己找 */
  readonly quote: string;
}

export interface Extraction {
  readonly entities: readonly EntityDraft[];
  readonly relations: readonly RelationDraft[];
  /** 丟掉了幾條關係，以及為什麼。**畫面上要說得出來**，不是安靜地少幾條 */
  readonly dropped: {
    readonly unknownEntity: number;
    readonly selfRelation: number;
    readonly duplicate: number;
  };
}

type Raw = Record<string, unknown>;

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? '' : trimmed;
}

/** 實體名的比對鍵。**大小寫與空白不算差別**，其餘照原樣 —— 不做同義詞。 */
export function entityKey(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

export function normalizeExtraction(raw: unknown): Extraction {
  const root = typeof raw === 'object' && raw !== null ? (raw as Raw) : {};

  const entities: EntityDraft[] = [];
  const byKey = new Map<string, string>();
  for (const entry of Array.isArray(root['entities']) ? (root['entities'] as unknown[]) : []) {
    if (entities.length >= MAX_ENTITIES) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Raw;
    const name = text(row['name'], MAX_NAME_CHARS);
    if (name.length === 0) continue;
    const type = row['type'];
    // **型別對不上就丟掉整個實體。** provider 宣告了 `json_schema`，
    // 所以這裡對不上代表它沒照 schema 走 —— 猜一個型別只會產生一個標錯的節點。
    if (typeof type !== 'string' || !(ENTITY_TYPES as readonly string[]).includes(type)) continue;
    const key = entityKey(name);
    if (key.length === 0 || byKey.has(key)) continue;
    byKey.set(key, name);
    entities.push({ name, type: type as EntityType });
  }

  const relations: RelationDraft[] = [];
  const seen = new Set<string>();
  let unknownEntity = 0;
  let selfRelation = 0;
  let duplicate = 0;

  for (const entry of Array.isArray(root['relations']) ? (root['relations'] as unknown[]) : []) {
    if (relations.length >= MAX_RELATIONS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Raw;

    const rel = text(row['rel'], MAX_REL_CHARS);
    const quote = typeof row['quote'] === 'string' ? row['quote'] : '';
    if (rel.length === 0 || quote.length === 0) continue;

    const subjectKey = entityKey(text(row['subject'], MAX_NAME_CHARS));
    const objectKey = entityKey(text(row['object'], MAX_NAME_CHARS));
    const subject = byKey.get(subjectKey);
    const object = byKey.get(objectKey);
    if (subject === undefined || object === undefined) {
      unknownEntity++;
      continue;
    }
    if (subjectKey === objectKey) {
      selfRelation++;
      continue;
    }

    const key = `${subjectKey} ${rel} ${objectKey}`;
    if (seen.has(key)) {
      duplicate++;
      continue;
    }
    seen.add(key);
    relations.push({ subject, rel, object, quote });
  }

  return { entities, relations, dropped: { unknownEntity, selfRelation, duplicate } };
}
