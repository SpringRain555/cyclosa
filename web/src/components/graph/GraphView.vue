<script setup lang="ts">
/**
 * `GraphView` —— **`3d-force-graph` 唯一被允許出現的地方**（`graph-view.md`）。
 *
 * 換掉它的觸發條件是數字：**8k 節點時互動 fps 掉到 30 以下**（ADR-0007）。
 * 那一天要改的就只有這一個檔案，因為外面的人拿到的一直是我們自己的詞彙。
 *
 * ## 兩套詞彙的交界
 *
 * glossary 明寫 **`link` 不要用**（它在前端是 `<a>`，在這個套件的 API 裡
 * 又是它自己的邊 —— 三個意思）。所以 `link` 這個字只出現在這個檔案裡
 * 跟套件對話的那幾行，外面一律 `edge`。
 *
 * ## 佈局不在這裡算
 *
 * 這個套件內建 d3 力導向，而**我們把它的力拿掉**，改用
 * `workers/layout.worker.ts` 算出來的位置。三件事要同時成立：
 *
 * 1. `charge` 與 `center` 設成 `null`；
 * 2. **`link` 力留著但強度設 0** —— 不能拿掉：把 `edge.source` 從字串
 *    換成節點物件這件事是那個力做的，拿掉之後每一條邊都會被當成
 *    無效的邊**靜默略過**；
 * 3. `cooldownTicks`／`cooldownTime` 設成無限大 —— 套件只在「引擎還在跑」
 *    的時候才把節點座標同步到 three.js 物件上，引擎停了之後
 *    worker 再怎麼算都不會反映到畫面。
 *
 * 這三條裡任何一條漏掉，症狀都是「圖不動」而不是錯誤訊息。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import type { Object3D } from 'three';

import {
  edgeDrawingOf,
  emphasisFor,
  labelWeightFor,
  zoomLevelFor,
} from '@domain/graph/render-rules';
import type { SubgraphEdge, SubgraphNode } from '../../api';
import LayoutWorker from '../../workers/layout.worker?worker';
import type { LayoutMessage, LayoutRequest } from '../../workers/layout.worker';
import {
  buildLabel,
  buildLine,
  buildNode,
  lineMaterial,
  MAX_LABELS,
  placeLine,
  token,
  type LineDrawing,
} from './objects';

const props = defineProps<{
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
  focusId: string;
  selectedId: string | null;
  /** 一鍵切 2D。**只改佈局不改資料**（ADR-0007）*/
  flat: boolean;
  /** 圖例上的開關：預設不畫的那兩種要不要顯示出來 */
  showDerived: boolean;
  showRejected: boolean;
}>();

const emit = defineEmits<{
  (event: 'select', id: string | null): void;
  (event: 'focus', id: string): void;
}>();

/** 送進套件的節點。**是 props 的純物件複本** —— 套件會就地改它們（寫入座標、
 * 把邊的兩端從字串換成物件），而 Vue 的響應式代理不該被那樣對待。 */
type Datum = SubgraphNode & { x?: number; y?: number; z?: number };
/**
 * **`source`／`target` 要先 `Omit` 掉再放寬。**
 * `SubgraphEdge` 上它們是 `string`，而套件會**就地**把它們換成節點物件 ——
 * 直接交集的話兩者會被收斂回 `string`，然後「換成物件之後」那條路
 * 在型別上是 `never`，而執行期它每次都會走到。
 */
type EdgeLike = Omit<SubgraphEdge, 'source' | 'target'>;
type EdgeDatum = EdgeLike & {
  source: string | Datum;
  target: string | Datum;
};

const host = ref<HTMLDivElement | null>(null);

let graph: ForceGraph3DInstance<Datum, EdgeDatum> | null = null;
let worker: Worker | null = null;
let data: Datum[] = [];
let byId = new Map<string, Datum>();
let groupById = new Map<string, Object3D>();
let labelsInScene: Object3D[] = [];
let edgeShafts: { shaft: Object3D; color: string; source: string; target: string }[] = [];
let neighbours = new Set<string>();
let lastZoom = '';
let fitPending = true;

// ── 資料 → 畫法 ─────────────────────────────────────────────

function drawingOf(edge: EdgeLike): LineDrawing {
  const drawing = edgeDrawingOf(edge);
  // 轉載預設不畫；圖例打開它的時候用等寬，因為它沒有方向可言
  return drawing === 'folded' ? 'uniform' : drawing;
}

function colorOf(edge: EdgeLike): string {
  if (edge.crossed) return token('--edge-rejected');
  if (edge.dashed) return token('--edge-pending');
  return token('--edge-confirmed');
}

/** **粗細是排序線索，讀不出數字**（ADR-0015）。共同提及一律等粗。 */
function radiusOf(edge: EdgeLike): number {
  if (edge.layer === 'comention') return 0.34;
  return 0.3 + edge.confidence * 1.1;
}

function nodeColorOf(node: SubgraphNode): string {
  if (node.kind === 'entity') return token('--node-entity');
  return node.subKind === 'note' ? token('--node-note') : token('--node-item');
}

function drawn(edge: EdgeLike): boolean {
  if (edge.folded) return props.showDerived;
  if (edge.crossed) return props.showRejected;
  return true;
}

/** 選取節點的一跳鄰域。**只提亮、不加框**，所以這裡只算集合。 */
function recomputeNeighbours(): void {
  neighbours = new Set<string>();
  const selected = props.selectedId;
  if (selected === null) return;
  for (const edge of props.edges) {
    if (edge.source === selected) neighbours.add(edge.target);
    else if (edge.target === selected) neighbours.add(edge.source);
  }
}

function opacityOf(id: string): number {
  const hasSelection = props.selectedId !== null;
  const distance = id === props.selectedId ? 0 : neighbours.has(id) ? 1 : 2;
  return emphasisFor(distance, hasSelection);
}

// ── 物件 ────────────────────────────────────────────────────

function makeNodeObject(node: Datum): Object3D {
  const group = buildNode({
    color: nodeColorOf(node),
    hollow: node.hollow,
    dashed: node.dashed,
    opacity: opacityOf(node.id),
    selected: node.id === props.selectedId,
    isFocus: node.id === props.focusId,
    crossed: node.excluded,
  });

  // **標籤有上限**：每個標籤是一張自己的貼圖，而且超過那個數量畫面上的字
  // 早就疊在一起了 —— 這個上限同時是效能界線與可讀性界線
  if (labelsInScene.length < MAX_LABELS) {
    // **未讀粗體、已讀正常**（ADR-0024）。判斷在 domain 裡，
    // 因為「哪一種節點有已讀這件事」是一條規則，不是一個畫法。
    const label = buildLabel(
      node.title,
      token('--text-secondary'),
      labelWeightFor({ kind: node.kind, readAt: node.readAt }) === 'bold',
    );
    if (label !== null) {
      group.add(label);
      labelsInScene.push(label);
    }
  }

  groupById.set(node.id, group);
  return group;
}

function makeEdgeObject(edge: EdgeDatum): Object3D {
  const color = colorOf(edge);
  const group = buildLine({
    drawing: drawingOf(edge),
    dashed: edge.dashed,
    color,
    opacity: emphasisFor(2, props.selectedId !== null),
    radius: radiusOf(edge),
    boxColor: token('--node-entity'),
    // 已否決在線中點打叉。**顏色之外的第二重編碼**（ADR-0018 規則 2）——
    // 少了它，已否決跟已確認只差一階灰，而那一階灰的意思是遠近
    crossed: edge.crossed,
  });
  const shaft = group.children.find((child) => child.name === 'shaft');
  if (shaft !== undefined) edgeShafts.push({ shaft, color, ...idsOf(edge) });
  return group;
}

function idsOf(edge: EdgeDatum): { source: string; target: string } {
  const source = typeof edge.source === 'string' ? edge.source : (edge.source.id ?? '');
  const target = typeof edge.target === 'string' ? edge.target : (edge.target.id ?? '');
  return { source, target };
}

// ── 選取：不重建物件，只改材質與環的可見性 ──────────────────

function applyEmphasis(): void {
  recomputeNeighbours();

  for (const [id, group] of groupById) {
    const opacity = opacityOf(id);
    for (const child of group.children) {
      if (child.name === 'ring-selected') child.visible = id === props.selectedId;
      else if (child.name === 'focus-horizon') child.visible = id === props.focusId;
      if (child.name !== 'body' && child.name !== 'reference-outline') continue;
      const material = (
        child as unknown as { material?: { opacity: number; transparent: boolean } }
      ).material;
      if (material !== undefined) {
        const scale: unknown = child.userData['opacityScale'];
        material.opacity = opacity * (typeof scale === 'number' ? scale : 1);
        material.transparent = material.opacity < 1;
      }
    }
  }

  const hasSelection = props.selectedId !== null;
  for (const entry of edgeShafts) {
    const touches =
      entry.source === props.selectedId ||
      entry.target === props.selectedId ||
      (hasSelection && (neighbours.has(entry.source) || neighbours.has(entry.target)));
    const opacity = emphasisFor(touches ? 1 : 2, hasSelection);
    (entry.shaft as unknown as { material: unknown }).material = lineMaterial(entry.color, opacity);
  }
}

// ── 佈局 ────────────────────────────────────────────────────

/** 主執行緒往 worker 只送控制訊息（都很小）—— **要 transfer 的是回程那一邊**。 */
function send(message: LayoutRequest): void {
  worker?.postMessage(message);
}

function startLayout(): void {
  // **照 id 排序**：`d3-force-3d` 的初始位置與亂數都是確定性的，
  // 所以只要節點順序穩定，同一批資料兩次打開就會長得一樣
  // （「佈局要穩定可預期比好看重要」）。
  const ids = data.map((node) => node.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const pairs: [number, number][] = [];
  for (const edge of props.edges) {
    const a = index.get(edge.source);
    const b = index.get(edge.target);
    // **摺起來的轉載仍然算進佈局** —— 線不畫，但那群節點還是該靠在一起
    if (a !== undefined && b !== undefined) pairs.push([a, b]);
  }
  send({ type: 'start', ids, edges: pairs, dimensions: props.flat ? 2 : 3 });
}

function onLayoutMessage(event: MessageEvent<LayoutMessage>): void {
  const message = event.data;

  if (message.type === 'settled') {
    // 佈局收斂了才框畫面 —— **收斂前框會框到一團還在攤開的東西**。
    // 每次換資料只框一次，之後鏡頭是使用者的。
    if (fitPending) {
      fitPending = false;
      graph?.zoomToFit(700, 90);
    }
    return;
  }
  if (message.type !== 'tick') return;
  const positions = message.positions;
  for (let i = 0; i < data.length; i += 1) {
    const node = data[i];
    if (node === undefined) continue;
    node.x = positions[i * 3] ?? 0;
    node.y = positions[i * 3 + 1] ?? 0;
    node.z = positions[i * 3 + 2] ?? 0;
  }
}

// ── 每一幀 ──────────────────────────────────────────────────

/**
 * fps 讀數，**`?fps=1` 才出現**。
 *
 * 它存在的理由是 ADR-0007：換渲染器的觸發條件是
 * 〈**8k 節點時互動 fps 掉到 30 以下**〉—— 而一個沒有人量得到的
 * 觸發條件等於沒有觸發條件。v0.12.0 那兩項 fps 預算是六項裡
 * **唯一兩項伺服器量不到的**（它們在瀏覽器裡，而且跟 GPU 有關）。
 *
 * 數的是 `onEngineTick`，不是另開一個 `requestAnimationFrame` 迴圈 ——
 * 因為引擎永遠「在跑」（`cooldownTicks(Infinity)`，見檔案開頭），
 * 所以每一次 tick 就是一幀。**另開一個迴圈量到的是瀏覽器還能不能排幀，
 * 不是這張圖畫得多快。**
 */
const fpsOn = typeof window !== 'undefined' && new URLSearchParams(location.search).has('fps');
const fps = ref(0);
let frames = 0;
let fpsSince = 0;

function countFrame(): void {
  if (!fpsOn) return;
  const at = performance.now();
  if (fpsSince === 0) {
    fpsSince = at;
    return;
  }
  frames += 1;
  const span = at - fpsSince;
  if (span >= 500) {
    fps.value = Math.round((frames * 1000) / span);
    frames = 0;
    fpsSince = at;
  }
}

function onFrame(): void {
  countFrame();
  const instance = graph;
  if (instance === null) return;
  const focus = byId.get(props.focusId);
  if (focus === undefined) return;

  // **轉動中心 ＝ 焦點節點**，而且轉動中永遠停在畫面中心。
  // 拖曳轉動需要一個支點，而那個支點不該是任意的幾何中心。
  const controls = instance.controls() as {
    target?: { set(x: number, y: number, z: number): void };
  };
  controls.target?.set(focus.x ?? 0, focus.y ?? 0, focus.z ?? 0);

  // **語意縮放：改變表示型態，不是只放大。**
  const camera = instance.camera().position;
  const dx = camera.x - (focus.x ?? 0);
  const dy = camera.y - (focus.y ?? 0);
  const dz = camera.z - (focus.z ?? 0);
  const level = zoomLevelFor(Math.sqrt(dx * dx + dy * dy + dz * dz));
  if (level !== lastZoom) {
    lastZoom = level;
    for (const label of labelsInScene) label.visible = level !== 'shape';
  }
}

// ── 生命週期 ────────────────────────────────────────────────

function rebuild(): void {
  const instance = graph;
  if (instance === null) return;

  const retiring = labelsInScene;
  labelsInScene = [];
  edgeShafts = [];
  groupById = new Map();

  data = [...props.nodes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((n) => ({ ...n }));
  byId = new Map(data.map((node) => [node.id, node]));
  recomputeNeighbours();

  instance.graphData({
    nodes: data,
    links: props.edges.map((edge) => ({ ...edge })),
  });

  fitPending = true;
  startLayout();

  // 上一批的標籤貼圖等套件把舊物件從場景移掉之後再丟 ——
  // **貼圖不會自己消失**，而在同一輪裡丟會動到還在畫的東西
  requestAnimationFrame(() => {
    for (const label of retiring) {
      const material = (
        label as unknown as { material?: { map?: { dispose(): void }; dispose(): void } }
      ).material;
      material?.map?.dispose();
      material?.dispose();
    }
  });
}

let observer: ResizeObserver | null = null;

onMounted(() => {
  const element = host.value;
  if (element === null) return;

  worker = new LayoutWorker();
  worker.onmessage = onLayoutMessage;

  const instance = new ForceGraph3D(element, {
    controlType: 'trackball',
  }) as unknown as ForceGraph3DInstance<Datum, EdgeDatum>;
  graph = instance;

  instance
    .backgroundColor(token('--bg-app'))
    .showNavInfo(false)
    .nodeId('id')
    .nodeThreeObject(makeNodeObject)
    .nodeLabel((node: Datum) => node.title)
    .linkVisibility((edge: EdgeDatum) => drawn(edge))
    .linkThreeObject(makeEdgeObject)
    .linkPositionUpdate((object, coords, edge) => {
      placeLine(object, coords.start, coords.end, radiusOf(edge));
      return true;
    })
    .onNodeClick((node: Datum) => emit('select', node.id))
    .onNodeRightClick((node: Datum) => emit('focus', node.id))
    .onBackgroundClick(() => emit('select', null))
    // 引擎永遠「在跑」，否則座標不會被同步到 three.js 物件上
    .cooldownTicks(Infinity)
    .cooldownTime(Infinity)
    .onEngineTick(onFrame);

  // 力全部退場：佈局是 worker 的事。
  // **`link` 這一個不能設成 null** —— 見檔案開頭。
  instance.d3Force('charge', null);
  instance.d3Force('center', null);
  const linkForce = instance.d3Force('link') as
    { strength?: (value: number) => unknown } | undefined;
  linkForce?.strength?.(0);

  observer = new ResizeObserver(() => {
    instance.width(element.clientWidth).height(element.clientHeight);
  });
  observer.observe(element);
  instance.width(element.clientWidth).height(element.clientHeight);

  rebuild();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  send({ type: 'stop' });
  worker?.terminate();
  worker = null;
  graph?._destructor();
  graph = null;
});

watch(
  () => [props.nodes, props.edges],
  () => rebuild(),
);

watch(
  () => props.selectedId,
  () => applyEmphasis(),
);

watch(
  () => props.focusId,
  (id) => {
    applyEmphasis();
    const target = byId.get(id);
    if (target === undefined) return;
    // 換焦點時鏡頭跟著移過去
    graph?.cameraPosition({}, { x: target.x ?? 0, y: target.y ?? 0, z: target.z ?? 0 }, 700);
  },
);

watch(
  () => props.flat,
  (flat) => {
    /**
     * **切 2D 只改佈局不改資料**（ADR-0007）——
     * 送一個訊息叫 worker 少算一個維度，資料本身一個位元組都沒動。
     *
     * ⚠️ **這裡不呼叫套件的 `numDimensions()`。**
     * 它看起來才是「正規」的做法，實際上按下去整張圖會空白 ——
     * 那支會重跑一次佈局初始化，而我們的力已經全部拿掉了，
     * 重跑之後畫面與資料就對不起來。而且它是多餘的：
     * 位置本來就由 worker 決定，套件那一側只負責畫。
     */
    send({ type: 'dimensions', dimensions: flat ? 2 : 3 });

    /**
     * **2D 要把旋轉關掉，不是只把鏡頭轉正。**
     *
     * 第一版只做了「把鏡頭移到正對平面」，而使用者按下去之後
     * 隨手一拖就又是斜的 —— 於是 2D 與 3D 看起來沒有差別，
     * 而**那個差別正是這顆按鈕存在的全部理由**（ADR-0007：
     * 3D 只做瀏覽，精確操作要能切到一個穩定的平面）。
     *
     * 縮放與平移留著：它們不會把平面轉歪。
     */
    const controls = graph?.controls() as { enableRotate?: boolean } | undefined;
    if (controls !== undefined) controls.enableRotate = !flat;

    if (flat) {
      const camera = graph?.camera().position;
      const distance =
        camera === undefined
          ? 400
          : Math.sqrt(camera.x * camera.x + camera.y * camera.y + camera.z * camera.z);
      graph?.cameraPosition({ x: 0, y: 0, z: distance }, { x: 0, y: 0, z: 0 }, 600);
    }
    fitPending = true;
  },
);

watch(
  () => [props.showDerived, props.showRejected],
  () => graph?.refresh(),
);
</script>

<template>
  <div ref="host" class="canvas">
    <!-- 量測用，`?fps=1` 才出現。數字而已 —— i18n 不需要進來。 -->
    <p v-if="fpsOn" class="fps">{{ fps }} fps &middot; {{ nodes.length }}</p>
  </div>
</template>

<style scoped>
.canvas {
  width: 100%;
  height: 100%;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.fps {
  position: absolute;
  top: var(--gap);
  left: var(--gap);
  margin: 0;
  padding: 4px 8px;
  border-radius: var(--radius);
  background: var(--bg-raised);
  color: var(--text-tertiary);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  z-index: 2;
}
</style>
