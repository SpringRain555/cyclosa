/**
 * 圖上怎麼畫 —— **層決定畫法（B1），狀態決定顏色（B2）**（ADR-0015 ＋ ADR-0018）。
 *
 * 這裡回的是**語意描述**（漸細／等寬／點線／打叉），**不是顏色字面值**。
 * 顏色的唯一來源是 `web/src/styles/tokens.css`，而這一份決定的是
 * 「哪一條線該長什麼樣子」—— 兩件事分開，因為換色票不該動到規則。
 *
 * **為什麼放在 `domain/graph` 而不是元件裡**：ADR-0015 的那張四層表與
 * ADR-0018 的三條規則是**模型的語意**，不是某個元件的實作細節。
 * 放在這裡它才測得到 —— 而「四種畫法要各自實作與測試」正是 ADR-0015 的代價那一節。
 *
 * ⚠️ 零依賴（ADR-0014）。
 */
import { requiresAdjudication } from './types.js';
import type { EdgeLayer, EdgeStatus, ItemKind, NodeKind } from './types.js';
import type { Projection } from './projection.js';

/**
 * 線的四種畫法。**漸細＝有方向，等寬＝沒有方向**（Holten & van Wijk）。
 *
 * `folded` 不是一種線 —— 它是「這條線不畫，改成在來源節點上記一筆」。
 */
export type EdgeDrawing =
  /** 摺進來源節點（「＋3 轉載」），**預設根本不畫線** */
  | 'folded'
  /** 漸細 ＝ 有方向。粗細是可信度的排序線索，**讀不出數字** */
  | 'tapered'
  /** 等寬 ＋ 線中點一個方塊，方塊就是那個實體 */
  | 'boxed'
  /** 等寬點線，沒有方向 */
  | 'dotted'
  /** 等寬實線，沒有方向也沒有方塊 */
  | 'uniform';

/** 線的完整畫法。**每個狀態都有第二重編碼**（ADR-0018 規則 2）。 */
export interface EdgeLine {
  readonly drawing: EdgeDrawing;
  /** 待查證是虛線 —— 顏色（琥珀）之外的第二重編碼 */
  readonly dashed: boolean;
  /** 已否決是中間打叉。**沒有自己的顏色，因為色相用完了** */
  readonly crossed: boolean;
  /** 有沒有方向。只有具名關係有 */
  readonly directional: boolean;
  /** 預設不畫。`derived` 是因為摺起來了，`rejected` 是因為它是墓碑 */
  readonly hiddenByDefault: boolean;
}

/** 層 → 畫法。**四層四種畫法，一對一。** */
export function edgeDrawingFor(layer: EdgeLayer): EdgeDrawing {
  switch (layer) {
    case 'derived':
      return 'folded';
    case 'named':
      return 'tapered';
    case 'comention':
      return 'boxed';
    case 'similarity':
      return 'dotted';
  }
}

/**
 * 一條**實際存在的邊**要怎麼畫。
 *
 * 跟 `edgeDrawingFor` 的差別只有共同提及那一層，而那個差別是實作時
 * 看著畫面才發現的：`comention` 有**兩種長相**。
 *
 * - 實體低於展開門檻 → 攤平成一條 `item—item` 線，**線中點那個方塊就是它本人**
 * - 實體已經展開成節點 → 存在資料庫裡的那條 `item→entity` 邊只是一條普通的等寬線
 *
 * 兩種都畫成方塊的話，**同一個實體會在畫面上出現兩次**：
 * 一次是線末端的空心節點，一次是線中間的方塊。第一次截圖時就是那樣，
 * 而它看起來像是圖上多了一堆意義不明的小方塊。
 *
 * 判準是 `via`：**它有值就代表這條線是投影出來的**（`via` 就是被攤平的那個實體）。
 */
export function edgeDrawingOf(edge: {
  readonly layer: EdgeLayer;
  readonly via: string | null;
}): EdgeDrawing {
  if (edge.layer === 'comention' && edge.via === null) return 'uniform';
  return edgeDrawingFor(edge.layer);
}

/**
 * 一條邊要怎麼畫。**層先決定形狀，狀態再疊上去。**
 *
 * ## 查證狀態只畫在 `named` 層上
 *
 * 這一條不明顯，但它是 ADR-0018 規則 1（每個顏色只有一個意思）的直接後果：
 * **琥珀色的意思是「等你裁決」**，而另外三層根本不進裁決佇列（ADR-0015）——
 * 沒有人在等你對一條相似度線做判斷。
 *
 * 把它們也畫成琥珀虛線的話，圖上會佈滿永遠不會消失的「待查證」，
 * 而**真正在等人判斷的那些就淹沒在裡面了**。
 *
 * 資料庫那一欄仍然有值（`status` 是 NOT NULL），
 * **但對非 `named` 的層來說那個值沒有意義** —— 它該長什麼樣子是
 * Stage 8 寫入路徑的問題，記在 `open-questions.md` 的 Q6。
 */
export function edgeLineFor(layer: EdgeLayer, status: EdgeStatus): EdgeLine {
  const drawing = edgeDrawingFor(layer);
  const adjudicated = requiresAdjudication(layer);
  return {
    drawing,
    dashed: adjudicated && status === 'pending',
    crossed: adjudicated && status === 'rejected',
    directional: drawing === 'tapered',
    hiddenByDefault: drawing === 'folded' || (adjudicated && status === 'rejected'),
  };
}

/** 節點的填色語意。**只有兩個顏色，而第三色不存在**（ADR-0018）。 */
export type NodeFill =
  /** 冷藍 ＝ 外面抓回來的 */
  | 'item'
  /** 暖洋紅 ＝ 你自己寫的 */
  | 'note'
  /** 灰 ＋ **空心** —— 靠實心／空心分，不靠顏色 */
  | 'entity';

export interface NodeGlyph {
  readonly fill: NodeFill;
  /** 實體是空心的 */
  readonly hollow: boolean;
  /** 已排除：中間打叉，預設隱藏 */
  readonly crossed: boolean;
  readonly hiddenByDefault: boolean;
}

/**
 * 節點怎麼畫。
 *
 * **`note` 走暖色是因為它是你寫的，不是因為它是另一種資料** ——
 * 那一對（冷／暖）是有意義的軸，不是隨手挑的兩個顏色。
 */
export function nodeGlyphFor(input: {
  readonly kind: NodeKind;
  readonly itemKind?: ItemKind | undefined;
  readonly excluded?: boolean | undefined;
}): NodeGlyph {
  const excluded = input.excluded === true;
  if (input.kind === 'entity') {
    return { fill: 'entity', hollow: true, crossed: excluded, hiddenByDefault: excluded };
  }
  const fill: NodeFill = input.itemKind === 'note' ? 'note' : 'item';
  return { fill, hollow: false, crossed: excluded, hiddenByDefault: excluded };
}

/**
 * 環。**外環＝你在哪，內環＝讀過了**，兩者可以同時存在。
 *
 * 「剛讀過」**不是獨立狀態，它就是選取**（ADR-0018）——
 * 點下一個節點時選取自然轉移，舊的留下灰內環。不為它再發明一個記號。
 */
export interface NodeRings {
  /** 青色外環 */
  readonly selected: boolean;
  /** 灰色內環，長期狀態 */
  readonly read: boolean;
  /** 白色準星 ＋ 傾斜環**疊在上面**，不取代節點自己的畫法 */
  readonly focus: boolean;
}

export function ringsFor(input: {
  readonly selected?: boolean | undefined;
  readonly readAt?: number | null | undefined;
  readonly isFocus?: boolean | undefined;
}): NodeRings {
  return {
    selected: input.selected === true,
    read: typeof input.readAt === 'number',
    focus: input.isFocus === true,
  };
}

/**
 * 一跳鄰域的強調。
 *
 * **只提亮、不加框**；其餘維持原亮度**不改暗**。
 * 為了讓提亮有空間，休息狀態本來就帶一點霧化底 ——
 * **所以選不選都一樣，不會忽明忽暗**（ADR-0018）。
 *
 * 回傳的是 0–1 的不透明度倍率，**不是顏色**。
 */
export const REST_OPACITY = 0.72;
export const NEIGHBOUR_OPACITY = 1;

export function emphasisFor(hopDistance: number, hasSelection: boolean): number {
  if (!hasSelection) return REST_OPACITY;
  return hopDistance <= 1 ? NEIGHBOUR_OPACITY : REST_OPACITY;
}

/**
 * 語意縮放 —— **改變表示型態，不是只放大**。
 * 近距離顯示標題，遠距離只顯示形狀與顏色。門檻是相機到焦點的距離（世界單位）。
 *
 * 兩個門檻是**從像素推回來的，不是挑的**。
 *
 * 節點邊長 7 個世界單位，鏡頭 fov 50°、視窗高 900 px：
 * 距離 d 時它在畫面上大約佔 `7 × 450 ÷ (d × tan25°) ≈ 6760 ÷ d` 個像素。
 *
 * - 字要看得懂，節點至少要有 8 px → d ≤ 845
 * - 要顯示縮圖之類的細節，至少要 25 px → d ≤ 270
 *
 * **第一次截圖時這兩個數字是 260 / 110**，而 `zoomToFit` 之後的距離
 * 遠大於 260 —— 於是預設視角一個標籤都不顯示。數字沒有錯，
 * **錯的是它們不是從任何東西推出來的**。
 */
export const LABEL_DISTANCE = 845;
export const DETAIL_DISTANCE = 270;

export type ZoomLevel = 'shape' | 'label' | 'detail';

export function zoomLevelFor(cameraDistance: number): ZoomLevel {
  if (cameraDistance <= DETAIL_DISTANCE) return 'detail';
  if (cameraDistance <= LABEL_DISTANCE) return 'label';
  return 'shape';
}

/**
 * 實體投影出來的線該不該畫。
 *
 * `projectionFor` 回的是「這個實體怎麼畫」，這一支回的是
 * 「**它攤平出來的那些線**該不該存在」—— 兩者是同一個決定的兩面。
 */
export function drawsComentionLines(projection: Projection): boolean {
  return projection === 'edge';
}

export function drawsAsNode(projection: Projection): boolean {
  return projection === 'node';
}
