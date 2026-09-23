/**
 * 子圖查詢的參數、界線與摺疊規則。
 *
 * **沒有「整張圖」這個東西**（ADR-0008）—— 連型別都不要留下那個可能。
 * 這一份定義的是「一次要看多少」，而那個數字是有界的。
 *
 * ⚠️ 零依賴（ADR-0014）。
 */
import type { ConfidenceTier, EdgeLayer, EdgeStatus } from './types.js';

/**
 * 跳數上限。
 *
 * **「2 跳」是預設值，不是研究結論** —— 有依據的是「要有上限」這件事。
 * 節點數大約以分支度的跳數次方成長（分支度 10 時：1 跳 11、2 跳 111、3 跳 1,111、
 * 4 跳 11,111），所以第 4 跳沒有存在的意義：它必然超過任何合理的預算。
 */
export const MAX_HOPS = 3;
export const DEFAULT_HOPS = 2;

/**
 * 節點預算 —— **超過這個數字工具列的那一格標琥珀，但仍然可以按**。
 *
 * 2,000 是 REQ-0005 的互動 fps 驗收點（2k 節點 ≥ 30 fps）。
 * 也就是說：**超過預算 ＝ 進入沒有被驗收過的區間**，不是「不准」。
 */
export const NODE_BUDGET = 2_000;

/**
 * 硬上限 —— 超過就回 `GRAPH_SUBGRAPH_TOO_LARGE`（413），**不回一個巨大的結果**。
 *
 * 8,000 不是拍的：**它就是 ADR-0007「換掉 `3d-force-graph`」的觸發條件**。
 * 在那個點以上我們已經知道它不好用了，交出去只會是一個當掉的分頁。
 *
 * **預算與硬上限是兩個不同的數字，這是刻意的** ——
 * 兩者相同的話，琥珀色警示就沒有意義了（超過預算等於直接失敗，警示無事可警）。
 */
export const RENDER_LIMIT = 8_000;

/** 每一格跳數會帶進幾個節點。`/subgraph/size` 回的就是這個。 */
export interface HopCounts {
  /** `hops` → 累計節點數（含焦點本身）。鍵是 1..MAX_HOPS */
  readonly counts: Readonly<Record<string, number>>;
  readonly budget: number;
  /** 超過預算的那幾格。工具列把它們標成琥珀色 */
  readonly overBudget: readonly string[];
  /**
   * 哪幾格的數字是**下界**而不是實際值。
   *
   * 走訪在超過 `RENDER_LIMIT` 之後就停了（2026-09-10 的規模量測：
   * 走完 3 跳要 1.5–4.6 秒，而這一支的預算是 50 ms）。
   * **超過硬上限的子圖一律回 413，所以「32,170」與「超過 8,000」
   * 對使用者是同一句話** —— 而後者便宜得多。
   *
   * 這一欄存在的理由是**不要讓一個下界看起來像一個數**。
   * 畫面上那幾格要顯示「8000+」，不是「8001」。
   */
  readonly capped: readonly string[];
}

export function normalizeHops(raw: unknown): number {
  // **空字串要走預設值，不要走夾取。**
  // `Number('')` 是 0（不是 NaN），所以少了這一行，查詢字串裡一個
  // 空的 `hops=` 會安靜地變成 1 跳 —— 使用者看到的圖比他要的小一層，
  // 而畫面上沒有任何東西說明為什麼。
  if (raw === '' || raw === null || raw === undefined) return DEFAULT_HOPS;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_HOPS;
  const rounded = Math.trunc(n);
  if (rounded < 1) return 1;
  if (rounded > MAX_HOPS) return MAX_HOPS;
  return rounded;
}

export function overBudgetHops(
  counts: Readonly<Record<string, number>>,
  budget: number = NODE_BUDGET,
): readonly string[] {
  return Object.keys(counts)
    .filter((k) => (counts[k] ?? 0) > budget)
    .sort();
}

/**
 * 子圖的篩選條件。
 *
 * **每一個都是「留下什麼」而不是「拿掉什麼」**，除了 `statuses` ——
 * 那一個的預設值刻意排除已否決，因為墓碑預設隱藏（ADR-0016）。
 */
export interface SubgraphFilters {
  /** 空陣列 ＝ 四層全要 */
  readonly layers: readonly EdgeLayer[];
  /** 空陣列 ＝ 全要（含已否決）。**預設不含已否決** */
  readonly statuses: readonly EdgeStatus[];
  /** 可信度下限。`null` ＝ 不篩 */
  readonly minTier: ConfidenceTier | null;
  /** 節點型別（`item` 的 kind 或 `entity` 的 type）。空 ＝ 全要 */
  readonly kinds: readonly string[];
  /** 關聯的建立時間範圍（毫秒）。`null` ＝ 不篩 */
  readonly since: number | null;
  readonly until: number | null;
}

export const DEFAULT_FILTERS: SubgraphFilters = {
  layers: [],
  // **預設排除已否決** —— 它是墓碑，不是一種可以順便看看的狀態
  statuses: ['pending', 'confirmed'],
  minTier: null,
  kinds: [],
  since: null,
  until: null,
};

const LAYERS: readonly string[] = ['derived', 'named', 'comention', 'similarity'];
const STATUSES: readonly string[] = ['pending', 'confirmed', 'rejected'];
const TIERS: readonly string[] = ['weak', 'medium', 'strong'];

/** `item.kind` 與 `entity.type` 的值域併起來 —— 節點型別篩選同時管兩種節點。 */
const KINDS: readonly string[] = [
  'web',
  'pdf',
  'image',
  'text',
  'note',
  'reference',
  'person',
  'org',
  'place',
  'event',
  'work',
  'concept',
];

/** 可信度等級的順序。**篩選是「至少這一級」**，所以要能比大小。 */
export const TIER_ORDER: Readonly<Record<ConfidenceTier, number>> = {
  weak: 0,
  medium: 1,
  strong: 2,
};

function pickKnown<T extends string>(raw: unknown, allowed: readonly string[]): readonly T[] {
  const list =
    typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw.map((v) => String(v)) : [];
  const out: string[] = [];
  for (const value of list) {
    const trimmed = value.trim();
    // **認不得的值直接丟掉，不報錯** —— 一個打錯字的篩選條件不該讓整張圖打不開。
    // 但也不能當成「沒篩」，否則使用者會看到比他要求的更多東西。
    if (allowed.includes(trimmed) && !out.includes(trimmed)) out.push(trimmed);
  }
  // `allowed` 是呼叫端給的值域，所以留下來的每一個都是 T —— 但編譯器看不出這件事
  return out as unknown as readonly T[];
}

/**
 * 從查詢字串生出一組合法的篩選條件。
 *
 * **不合法的值一律丟掉而不是報錯** —— 這支查詢在工具列上每動一下就跑一次，
 * 而一個 400 會讓整張圖消失。
 */
export function normalizeFilters(raw: {
  readonly layers?: unknown;
  readonly status?: unknown;
  readonly minConfidence?: unknown;
  readonly types?: unknown;
  readonly since?: unknown;
  readonly until?: unknown;
}): SubgraphFilters {
  const statuses = pickKnown<EdgeStatus>(raw.status, STATUSES);
  const minTierRaw = typeof raw.minConfidence === 'string' ? raw.minConfidence.trim() : '';
  const time = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  return {
    layers: pickKnown<EdgeLayer>(raw.layers, LAYERS),
    statuses: statuses.length > 0 ? statuses : DEFAULT_FILTERS.statuses,
    minTier: TIERS.includes(minTierRaw) ? (minTierRaw as ConfidenceTier) : null,
    kinds:
      typeof raw.types === 'string' || Array.isArray(raw.types) ? pickKnown(raw.types, KINDS) : [],
    since: time(raw.since),
    until: time(raw.until),
  };
}

/**
 * `derived` 摺進來源節點。
 *
 * ADR-0015 的代價那一節寫著：**`derived` 預設不畫線意味著圖上看不到它們，
 * 使用者要看得到「這個節點摺了 3 個轉載」這件事本身，否則會以為資料漏了。**
 * 這支算的就是那個數字。
 *
 * @returns nodeId → 摺進去幾條
 */
export function foldDerived(
  edges: readonly { readonly source: string; readonly target: string; readonly layer: EdgeLayer }[],
): ReadonlyMap<string, number> {
  const folded = new Map<string, number>();
  for (const edge of edges) {
    if (edge.layer !== 'derived') continue;
    // 摺進**來源**節點：「這一篇有 3 個轉載」，而不是「這 3 篇各有一個來源」
    folded.set(edge.source, (folded.get(edge.source) ?? 0) + 1);
  }
  return folded;
}
