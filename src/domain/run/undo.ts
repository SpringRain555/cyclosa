/**
 * 「復原這次作業」要刪掉哪些、要留下哪些。
 *
 * ## 為什麼這件事需要一條規則，而不是一句 `DELETE WHERE run_id = ?`
 *
 * 那一句會刪掉**你在這中間做過的判斷**。
 * 一次擴展跑完你確認了三條關聯、排除了兩份資料、對其中一句話做了點註 ——
 * 然後你按「復原」，因為剩下那三十條是雜訊。
 *
 * **一條 `DELETE` 會把那三個動作一起丟掉，而且不會說一聲。**
 * 這個工具從 v0.4.0 起只有一條規則是絕對的：
 * **機器永遠不得覆寫人工判定** —— 而「復原」是機器在動人的東西。
 *
 * 所以復原跟 `rebuild` 遵守同一句話：**不碰 `sources\`，也不碰人的判定。**
 *
 * ## 四種「人動過」
 *
 * | 情況 | 為什麼留 |
 * |---|---|
 * | `origin='human'` 的邊 | 那條邊本來就是你建的，它只是碰巧在這次作業期間 |
 * | 人裁決過的邊（確認／否決／改判）| 那個判斷是你做的 |
 * | 你讀過、排除過、或標過點註的資料 | 三種都是你對那一份表過態 |
 * | **留下來的邊的出處所在的那一份** | 見下面 |
 *
 * 最後一條不是「人動過」，是**一致性**：出處與資料之間有外鍵而且會連帶刪除，
 * 所以刪掉一份被留下來的邊引用的資料，那條邊就會變成
 * **一條已確認、卻沒有任何出處的關聯** —— 而那正是這個工具最不能有的東西。
 *
 * ## 純函式
 *
 * 它拿到的是一組事實，回的是兩張 id 清單。這樣「哪些會被留下來」
 * 測得起來，而不用先跑一次真的擴展。
 */

export interface RunEdgeFact {
  readonly id: string;
  readonly origin: 'machine' | 'human';
  /** 有沒有人對它按過確認／否決／改判。 */
  readonly adjudicatedByHuman: boolean;
  /** 它的出處出自哪幾份資料。 */
  readonly evidenceItemIds: readonly string[];
}

export interface RunItemFact {
  readonly id: string;
  readonly read: boolean;
  /** 有點註錨在它上面。 */
  readonly annotated: boolean;
  /** 被人手動排除。 */
  readonly excluded: boolean;
}

export interface UndoPlan {
  readonly deleteEdges: readonly string[];
  readonly keepEdges: readonly string[];
  readonly deleteItems: readonly string[];
  readonly keepItems: readonly string[];
  /**
   * 因為「有一條留下來的邊靠它當出處」而被留下來的那幾份。
   *
   * **要單獨帶出來**：使用者會問「我沒碰過這一份，它為什麼還在」，
   * 而那個答案跟「你讀過它」是完全不同的一句話。
   */
  readonly keptAsEvidence: readonly string[];
}

export function planUndo(edges: readonly RunEdgeFact[], items: readonly RunItemFact[]): UndoPlan {
  const keepEdges: string[] = [];
  const deleteEdges: string[] = [];
  for (const edge of edges) {
    if (edge.origin === 'human' || edge.adjudicatedByHuman) keepEdges.push(edge.id);
    else deleteEdges.push(edge.id);
  }

  const kept = new Set(keepEdges);
  const backing = new Set<string>();
  for (const edge of edges) {
    if (!kept.has(edge.id)) continue;
    for (const itemId of edge.evidenceItemIds) backing.add(itemId);
  }

  const keepItems: string[] = [];
  const deleteItems: string[] = [];
  const keptAsEvidence: string[] = [];
  for (const item of items) {
    const touched = item.read || item.annotated || item.excluded;
    if (touched) {
      keepItems.push(item.id);
    } else if (backing.has(item.id)) {
      keepItems.push(item.id);
      keptAsEvidence.push(item.id);
    } else {
      deleteItems.push(item.id);
    }
  }

  return { deleteEdges, keepEdges, deleteItems, keepItems, keptAsEvidence };
}

/** 這次復原有沒有留下任何東西。**畫面上要說出這件事**，不能只報一個刪除數。 */
export function keptAnything(plan: UndoPlan): boolean {
  return plan.keepEdges.length > 0 || plan.keepItems.length > 0;
}
