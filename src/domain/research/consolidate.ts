import { ENTITY_TYPES } from '../provider/relations.js';
import { conformsTo } from '../provider/schema-check.js';
import { mergePairKey } from '../entity/merge-candidates.js';

/**
 * 整理的第一片：**把還沒抽過的資料抽進圖**（ADR-0033 D13 操作表的「抽這幾份」，S24-1）。
 *
 * ## 「還沒抽過」是一個事實，不是模型的意見
 *
 * 完整的整理（D13）由模型讀專題的摘要、交出一張操作清單；這一片不需要那一步 ——
 * 哪幾份還沒抽過，資料庫數得出來。所以這裡沒有規劃、也沒有模型呼叫，清單直接列給人勾（Q10：預設不勾）。
 *
 * ## 為什麼不能只看 `extracted_at`
 *
 * 那一欄是 schema v12（Stage 22）才有的，**只有研究建圖寫它**。在那之前抽過的資料
 * （舊的擴展、手動抽取、範例專題）那一欄是空的，卻已經有機器建的關聯拿它當出處。
 * 只看那一欄的話，清單上會出現一堆其實抽過的資料，勾下去就是重抽一次。
 * 「抽過但 0 條」與「沒抽過」對舊資料仍然分不出來（D11 寫過）—— 那一種照樣列出來，讓人決定要不要再試。
 */

/** 判斷一份資料能不能出現在「還沒抽過」清單上所需要的事實。 */
export interface ExtractionFacts {
  readonly kind: string;
  readonly status: string;
  readonly extractedAt: number | null;
  /** 有幾筆**機器建的**關聯拿它當出處。人建的不算 —— 你手動連一條線不等於它被抽過。 */
  readonly machineEvidence: number;
  /** 衍生正文有沒有字。圖片與掃描件沒有（這一版不做 OCR），抽不了。 */
  readonly hasBody: boolean;
}

/** 書目節點沒有正文；筆記是點註，不是資料（D14）。 */
const NOT_SOURCES: readonly string[] = ['reference', 'note'];

/** 匯入完成的資料停在 `included`；`parsed` 是中間態。排除的、失敗的、還沒抓的都不算。 */
const USABLE: readonly string[] = ['parsed', 'included'];

/** 這一份還沒抽過，而且抽得了。 */
export function isUnextracted(facts: ExtractionFacts): boolean {
  if (NOT_SOURCES.includes(facts.kind)) return false;
  if (!USABLE.includes(facts.status)) return false;
  if (facts.extractedAt !== null) return false;
  if (facts.machineEvidence > 0) return false;
  return facts.hasBody;
}

/**
 * 復原一筆作業之後，那一份的「抽過了」要不要清回去。
 *
 * **只清這一筆作業寫的那一個。** 作業結束之後又被別的作業抽過一次（時間在這一筆的區間之外）的，
 * 那個標記是後來那一次的，不是這一筆的。
 */
export function extractedByRun(
  extractedAt: number | null,
  run: { readonly startedAt: number | null; readonly endedAt: number | null },
  now: number,
): boolean {
  if (extractedAt === null || run.startedAt === null) return false;
  return extractedAt >= run.startedAt && extractedAt <= (run.endedAt ?? now);
}

export const CONSOLIDATE_OP_KINDS = ['merge', 'extract', 'add-edge', 'retype', 'digest'] as const;
export type ConsolidateOpKind = (typeof CONSOLIDATE_OP_KINDS)[number];

export const CONSOLIDATE_OP_ORDER: readonly ConsolidateOpKind[] = [
  'merge',
  'retype',
  'extract',
  'add-edge',
  'digest',
];

export type ConsolidateOpState = 'proposed' | 'done' | 'failed' | 'stale' | 'skipped';

export interface ConsolidateOpPayloadByKind {
  readonly merge: { readonly keep: string; readonly drop: string };
  readonly extract: { readonly itemIds: readonly string[] };
  readonly 'add-edge': {
    readonly source: string;
    readonly target: string;
    readonly rel: string;
    readonly itemId: string;
    readonly quote: string;
  };
  readonly retype: { readonly entityId: string; readonly to: (typeof ENTITY_TYPES)[number] };
  readonly digest: { readonly itemIds: readonly string[] };
}

export type ConsolidateOpPayload = ConsolidateOpPayloadByKind[ConsolidateOpKind];
export type ConsolidateOpDraft = {
  [K in ConsolidateOpKind]: {
    readonly kind: K;
    readonly payload: ConsolidateOpPayloadByKind[K];
    readonly why: string;
  };
}[ConsolidateOpKind];
type OpSchema = Readonly<Record<string, unknown>>;

export const MERGE_OP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { keep: { type: 'string', minLength: 1 }, drop: { type: 'string', minLength: 1 } },
  required: ['keep', 'drop'],
} as const;

export const EXTRACT_OP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    itemIds: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: { type: 'string', minLength: 1 },
    },
  },
  required: ['itemIds'],
} as const;

export const ADD_EDGE_OP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', minLength: 1 },
    target: { type: 'string', minLength: 1 },
    rel: { type: 'string', minLength: 1, maxLength: 40 },
    itemId: { type: 'string', minLength: 1 },
    quote: { type: 'string', minLength: 8, maxLength: 500 },
  },
  required: ['source', 'target', 'rel', 'itemId', 'quote'],
} as const;

export const RETYPE_OP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    entityId: { type: 'string', minLength: 1 },
    to: { type: 'string', enum: ENTITY_TYPES },
  },
  required: ['entityId', 'to'],
} as const;

export const DIGEST_OP_SCHEMA = EXTRACT_OP_SCHEMA;

export const CONSOLIDATE_OP_SCHEMAS: Readonly<Record<ConsolidateOpKind, OpSchema>> = {
  merge: MERGE_OP_SCHEMA,
  extract: EXTRACT_OP_SCHEMA,
  'add-edge': ADD_EDGE_OP_SCHEMA,
  retype: RETYPE_OP_SCHEMA,
  digest: DIGEST_OP_SCHEMA,
};

/** 各操作的參數與種類一起交給受限解碼；回傳後仍嚴格驗證。 */
export const CONSOLIDATE_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operations: {
      type: 'array',
      maxItems: 200,
      items: {
        anyOf: Object.entries(CONSOLIDATE_OP_SCHEMAS).map(([kind, payload]) => ({
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: [kind] },
            payload,
            why: { type: 'string', minLength: 1, maxLength: 2000 },
          },
          required: ['kind', 'payload', 'why'],
        })),
      },
    },
  },
  required: ['operations'],
} as const;

/** JSON 形狀不合或任一種操作的參數不合時，整份清單都不採用。 */
export function parseConsolidatePlan(raw: string): readonly ConsolidateOpDraft[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!conformsTo(CONSOLIDATE_PLAN_SCHEMA, value).ok) return null;
  const rows = (value as { operations: readonly unknown[] }).operations;
  const out: ConsolidateOpDraft[] = [];
  for (const candidate of rows) {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const row = candidate as Record<string, unknown>;
    const kind = row['kind'];
    if (
      typeof kind !== 'string' ||
      !(CONSOLIDATE_OP_KINDS as readonly string[]).includes(kind) ||
      typeof row['why'] !== 'string' ||
      row['why'].trim().length === 0 ||
      typeof row['payload'] !== 'object' ||
      row['payload'] === null ||
      Array.isArray(row['payload'])
    )
      return null;
    const typedKind = kind as ConsolidateOpKind;
    if (!conformsTo(CONSOLIDATE_OP_SCHEMAS[typedKind], row['payload']).ok) return null;
    out.push({
      kind: typedKind,
      payload: row['payload'],
      why: row['why'].trim(),
    } as ConsolidateOpDraft);
  }
  return out;
}

export interface ConsolidateValidationFacts {
  readonly mergeCandidateKeys?: ReadonlySet<string>;
  readonly liveEntityIds: ReadonlySet<string>;
  readonly itemIds: ReadonlySet<string>;
  readonly extractableItemIds: ReadonlySet<string>;
  readonly endpointIds: ReadonlySet<string>;
  readonly verifiedQuoteKeys: ReadonlySet<string>;
  readonly digestibleItemIds?: ReadonlySet<string>;
}

export interface DroppedConsolidateOp {
  readonly kind: ConsolidateOpKind;
  readonly reason: string;
}

export function consolidateQuoteKey(itemId: string, quote: string): string {
  return JSON.stringify([itemId, quote]);
}

/** 純資料驗證：資料庫與正文事實由應用層整理成集合後傳入。 */
export function validateConsolidatePlan(
  drafts: readonly ConsolidateOpDraft[],
  facts: ConsolidateValidationFacts,
): {
  readonly operations: readonly ConsolidateOpDraft[];
  readonly dropped: readonly DroppedConsolidateOp[];
} {
  const operations: ConsolidateOpDraft[] = [];
  const dropped: DroppedConsolidateOp[] = [];
  const drop = (kind: ConsolidateOpKind, reason: string): void => {
    dropped.push({ kind, reason });
  };

  for (const draft of drafts) {
    switch (draft.kind) {
      case 'merge':
        if (
          !facts.liveEntityIds.has(draft.payload.keep) ||
          !facts.liveEntityIds.has(draft.payload.drop)
        ) {
          drop(draft.kind, 'merge-id-missing');
        } else if (draft.payload.keep === draft.payload.drop) {
          drop(draft.kind, 'merge-same-id');
        } else if (
          facts.mergeCandidateKeys !== undefined &&
          !facts.mergeCandidateKeys.has(mergePairKey(draft.payload.keep, draft.payload.drop))
        ) {
          drop(draft.kind, 'merge-not-candidate');
        } else {
          operations.push(draft);
        }
        break;
      case 'extract':
        if (draft.payload.itemIds.some((id) => !facts.extractableItemIds.has(id))) {
          drop(draft.kind, 'extract-item-not-unextracted');
        } else {
          operations.push(draft);
        }
        break;
      case 'add-edge':
        if (
          draft.payload.source === draft.payload.target ||
          !facts.endpointIds.has(draft.payload.source) ||
          !facts.endpointIds.has(draft.payload.target) ||
          !facts.itemIds.has(draft.payload.itemId)
        ) {
          drop(draft.kind, 'edge-id-missing');
        } else if (
          !facts.verifiedQuoteKeys.has(
            consolidateQuoteKey(draft.payload.itemId, draft.payload.quote),
          )
        ) {
          drop(draft.kind, 'edge-quote-not-found');
        } else {
          operations.push(draft);
        }
        break;
      case 'retype':
        if (!facts.liveEntityIds.has(draft.payload.entityId))
          drop(draft.kind, 'retype-entity-missing');
        else operations.push(draft);
        break;
      case 'digest':
        if (draft.payload.itemIds.some((id) => !facts.itemIds.has(id)))
          drop(draft.kind, 'digest-item-missing');
        else if (
          draft.payload.itemIds.some((id) => !(facts.digestibleItemIds ?? facts.itemIds).has(id))
        )
          drop(draft.kind, 'digest-item-not-undigested');
        else operations.push(draft);
        break;
    }
  }
  return { operations, dropped };
}
/** 穩定排序：同一類操作保留清單序號，種類依 ADR-0033 C7 執行。 */
export function orderConsolidateOps<
  T extends { readonly kind: ConsolidateOpKind; readonly ord: number },
>(operations: readonly T[]): readonly T[] {
  const rank = new Map(CONSOLIDATE_OP_ORDER.map((kind, index) => [kind, index]));
  return [...operations].sort(
    (a, b) =>
      (rank.get(a.kind) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.kind) ?? Number.MAX_SAFE_INTEGER) || a.ord - b.ord,
  );
}

/** 只把還待執行、而這次重新驗證已不成立的操作標成失效。 */
export function isConsolidateOpStale(state: ConsolidateOpState, validNow: boolean): boolean {
  return state === 'proposed' && !validNow;
}
