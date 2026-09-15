/**
 * **顏色與記號的清單，一份。**
 *
 * 兩個地方讀它：圖上左欄的 `GraphLegend.vue`（看著圖即時對照，只顯示
 * `compact` 的那些）與設定頁的 `StatusGuide.vue`（一次看完，全部）。
 *
 * ## 為什麼要抽出來
 *
 * 兩份手寫的清單一定會漂。而這個專案已經為同一種形狀付過錢：
 * **v0.3.0 的圖例上寫著「已否決（打叉）」，而那個叉根本沒實作** ——
 * 當時沒有任何路徑可以否決一條邊。發版檢查表的 D8 就是為那件事寫的
 * （「圖例上的每一行，在合成資料裡都要有一個實例」）。
 *
 * 所以這一份不只是共用，它還是**被測試釘住的那一份**：
 * `tests/guards/legend-coverage.test.ts` 檢查
 * ① 每個關聯層都對得上 `domain/graph/render-rules.ts` 的畫法、
 * ② 每個 token 都真的存在於 `tokens.css`、
 * ③ 每個 i18n key 都真的存在。
 *
 * ## `mark` 是 CSS class，不是顏色
 *
 * 樣本長什麼樣（方塊、環、漸細的線、虛線、叉）由 CSS 畫，
 * 而**兩個元件共用同一份樣式**（`legend-marks.css`）——
 * 否則設定頁上的虛線跟圖上那一欄的虛線會是兩種虛線。
 */

/**
 * 關聯的畫法。**必須與 `src/domain/graph/render-rules.ts` 的 `EdgeDrawing`
 * 逐字相同**，而 `web/` 是另一份建置、編譯器不會替我們比對這件事
 * （`docs/lessons.md`：「改掉一個跨建置的欄位名，762 個測試全綠」）。
 * 守門測試就是那個比對。
 */
export type EdgeDrawingName = 'folded' | 'tapered' | 'boxed' | 'dotted' | 'uniform';

export interface LegendItem {
  /** `t.graph.guide` 底下的 key。 */
  readonly key: string;
  /** 樣本的 CSS class（`legend-marks.css`）。空字串 ＝ 這一條沒有樣本，只有文字。 */
  readonly mark: string;
  /** 它用到的顏色 token。**空陣列是有意義的** —— 有些記號不靠顏色。 */
  readonly tokens: readonly string[];
  /**
   * 樣本裡要印的字元。
   *
   * **打叉是一個字元不是一個顏色**（ADR-0018：那一段的顏色預算滿了，
   * 所以已否決與已排除改用形狀）。放在宣告裡而不是讓模板去猜 mark 的字串 ——
   * 猜的話，改一個 class 名就會讓叉安靜地消失。
   */
  readonly glyph?: string;
  /** 圖上那一欄要不要顯示。**不是全部** —— 那一欄只有 232px。 */
  readonly compact: boolean;
  /** 這一條講的是哪一種關聯畫法。只有關聯層那一節有。 */
  readonly drawing?: EdgeDrawingName;
}

export interface LegendSection {
  /** `t.graph.guide.sections` 底下的 key。 */
  readonly key: string;
  /** 這一節在圖上那一欄要不要出現。 */
  readonly compact: boolean;
  readonly items: readonly LegendItem[];
}

export const LEGEND_SECTIONS: readonly LegendSection[] = [
  {
    key: 'nodes',
    compact: true,
    items: [
      {
        key: 'nodeItem',
        mark: 'swatch item',
        tokens: ['--node-item', '--node-outline'],
        compact: true,
      },
      {
        key: 'nodeNote',
        mark: 'swatch note',
        tokens: ['--node-note', '--node-outline'],
        compact: true,
      },
      // **實體靠空心分，不靠顏色。** 第三個資料色不存在（ADR-0018）。
      { key: 'nodeEntity', mark: 'swatch entity', tokens: ['--node-entity'], compact: true },
      {
        key: 'nodeExcluded',
        mark: 'swatch crossed',
        tokens: ['--edge-rejected'],
        compact: false,
        glyph: '✕',
      },
    ],
  },
  {
    key: 'rings',
    compact: true,
    items: [
      {
        key: 'ringSelected',
        mark: 'swatch ring-selected',
        tokens: ['--ring-selected'],
        compact: true,
      },
      { key: 'ringFocus', mark: 'swatch focus', tokens: ['--focus-marker'], compact: true },
      // **已讀在圖上不是一個環**（ADR-0024 把那個環拿掉了），是標籤的字重。
      { key: 'readWeight', mark: 'weight', tokens: [], compact: false },
      { key: 'neighbour', mark: '', tokens: [], compact: false },
    ],
  },
  {
    key: 'layers',
    compact: true,
    items: [
      {
        key: 'layerNamed',
        mark: 'line tapered',
        tokens: ['--edge-confirmed'],
        compact: true,
        drawing: 'tapered',
      },
      {
        key: 'layerComention',
        mark: 'line boxed',
        tokens: ['--edge-confirmed', '--node-entity'],
        compact: true,
        drawing: 'boxed',
      },
      {
        key: 'layerComentionOpen',
        mark: 'line uniform',
        tokens: ['--edge-confirmed'],
        compact: false,
        drawing: 'uniform',
      },
      {
        key: 'layerSimilarity',
        mark: 'line dotted',
        tokens: ['--edge-confirmed'],
        compact: true,
        drawing: 'dotted',
      },
      {
        key: 'layerDerived',
        mark: 'line folded',
        tokens: ['--line'],
        compact: true,
        drawing: 'folded',
      },
    ],
  },
  {
    key: 'status',
    compact: true,
    items: [
      { key: 'statusPending', mark: 'line pending', tokens: ['--edge-pending'], compact: true },
      {
        key: 'statusConfirmed',
        mark: 'line confirmed',
        tokens: ['--edge-confirmed'],
        compact: true,
      },
      {
        key: 'statusRejected',
        mark: 'line rejected',
        tokens: ['--edge-rejected'],
        compact: true,
        glyph: '✕',
      },
    ],
  },
  {
    key: 'projection',
    compact: false,
    items: [
      { key: 'projectionOne', mark: '', tokens: [], compact: false },
      { key: 'projectionTwo', mark: 'line boxed', tokens: ['--node-entity'], compact: false },
      { key: 'projectionThree', mark: 'swatch entity', tokens: ['--node-entity'], compact: false },
    ],
  },
  {
    key: 'panel',
    compact: false,
    items: [
      { key: 'panelSuccess', mark: 'swatch ui-success', tokens: ['--ui-success'], compact: false },
      // **紅色在關聯圖上永不出現**，這一行的重點就是那句話。
      { key: 'panelDanger', mark: 'swatch ui-danger', tokens: ['--ui-danger'], compact: false },
      { key: 'panelAction', mark: 'swatch ui-action', tokens: ['--ui-action'], compact: false },
    ],
  },
  {
    key: 'rules',
    compact: false,
    items: [
      { key: 'ruleDepth', mark: '', tokens: [], compact: false },
      { key: 'ruleDirection', mark: '', tokens: [], compact: false },
      { key: 'ruleWidth', mark: '', tokens: [], compact: false },
      { key: 'ruleSecondEncoding', mark: '', tokens: [], compact: false },
    ],
  },
];

/** 圖上那一欄要顯示的子集。**篩選規則寫在這裡，不在元件裡各寫一次。** */
export function compactSections(): readonly LegendSection[] {
  return LEGEND_SECTIONS.filter((s) => s.compact).map((s) => ({
    ...s,
    items: s.items.filter((i) => i.compact),
  }));
}
