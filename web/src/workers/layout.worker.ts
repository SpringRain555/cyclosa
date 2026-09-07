/**
 * 力導向佈局 —— **跑在 Web Worker 裡**（`overview.md`、`graph-view.md`）。
 *
 * ## 為什麼要搬出主執行緒
 *
 * 力導向每一幀都要對所有節點兩兩算斥力（Barnes–Hut 之後仍是 O(n log n)）。
 * 放在主執行緒上，那份計算跟渲染、跟使用者的拖曳搶同一條執行緒 ——
 * **圖不是變慢，是變得拖不動**。
 *
 * ## 這裡不畫任何東西
 *
 * Worker 只回位置。**它不知道有 three.js，也不知道有顏色。**
 * 主執行緒那邊的 `GraphView` 把 `3d-force-graph` 自己的力全部拿掉，
 * 改成把這裡算出來的位置寫進節點 —— 那一段的說明在 `GraphView.vue`。
 *
 * ## 佈局是可重現的
 *
 * `d3-force-3d` 的初始位置是黃金角排列（確定性），亂數用的是自帶的
 * **LCG（種子固定）而不是 `Math.random()`** —— 所以同一批節點、同樣的順序
 * 兩次跑出來會一樣。**呼叫端要負責節點順序穩定**，這也是為什麼
 * `GraphView` 送進來之前會先照 id 排序。
 *
 * 「佈局要穩定可預期比好看重要 —— 同一批資料兩次打開應該長得差不多」（graph-view.md）。
 */
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNode,
} from 'd3-force-3d';

export interface LayoutStart {
  readonly type: 'start';
  readonly ids: readonly string[];
  /** 以 `ids` 的索引表示的兩端 —— **不傳字串**，一次佈局要傳好幾百次 */
  readonly edges: readonly (readonly [number, number])[];
  readonly dimensions: 2 | 3;
}

export type LayoutRequest =
  | LayoutStart
  | { readonly type: 'stop' }
  | { readonly type: 'reheat' }
  | { readonly type: 'dimensions'; readonly dimensions: 2 | 3 };

export interface LayoutTick {
  readonly type: 'tick';
  /** `[x0, y0, z0, x1, y1, z1, …]`，順序同 `ids`。**用 transfer 送，不複製** */
  readonly positions: Float32Array;
  readonly alpha: number;
}

export type LayoutMessage = LayoutTick | { readonly type: 'settled' };

/**
 * 每秒送幾次位置。
 *
 * **不是每一次 tick 都送** —— 模擬跑得比畫面更新快，而多送的那些
 * 在主執行緒那邊只會變成被覆蓋掉的寫入。30 次夠了，因為
 * REQ-0005 的驗收條件就是 30 fps。
 */
const TICKS_PER_SECOND = 30;

/**
 * 每次送位置之前多跑幾步。
 *
 * 力導向的前幾十步是最劇烈的，一步一步送出去只會看到抖動。
 * **跑 2 步送 1 次**，收斂看起來比較像「攤開」而不是「彈跳」。
 */
const STEPS_PER_FRAME = 2;

/**
 * Worker 的全域。
 *
 * **不能直接用 `self`** —— 前端這一套的 `lib` 是 `DOM`，所以 `self` 被推成
 * `Window`，而 `Window.postMessage` 的第二個參數是 `targetOrigin` 字串，
 * 不是 transfer 陣列。`DedicatedWorkerGlobalScope` 在 `lib.webworker` 裡，
 * 而那一份跟 `lib.dom` 不能同時載入（兩邊有幾十個同名不同義的宣告）。
 *
 * 所以這裡只宣告我們用到的兩件事，**不是為了繞過型別，是為了不引入
 * 一整份會跟 DOM 打架的宣告**。
 */
const ctx = self as unknown as {
  postMessage(message: LayoutMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
};

let simulation: Simulation | null = null;
let nodes: SimulationNode[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let dimensions: 2 | 3 = 3;
let edgePairs: readonly (readonly [number, number])[] = [];

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function post(message: LayoutMessage, transfer?: Transferable[]): void {
  if (transfer === undefined) ctx.postMessage(message);
  else ctx.postMessage(message, transfer);
}

function emitPositions(alpha: number): void {
  const positions = new Float32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i] as SimulationNode;
    positions[i * 3] = node.x ?? 0;
    positions[i * 3 + 1] = node.y ?? 0;
    // 2D 的時候 d3 根本不會產生 z，**不要猜一個數字**，就是 0
    positions[i * 3 + 2] = node.z ?? 0;
  }
  post({ type: 'tick', positions, alpha }, [positions.buffer]);
}

function build(): void {
  stopTimer();

  simulation = forceSimulation(nodes, dimensions)
    // 自己驅動，不用 d3 的 timer —— worker 裡沒有 requestAnimationFrame，
    // 而 d3-timer 會退回 setTimeout(17ms)。自己來比較看得懂也停得掉。
    .stop()
    .alphaDecay(0.0228)
    .velocityDecay(0.4);

  simulation.force(
    'link',
    forceLink(edgePairs.map(([a, b]) => ({ source: a, target: b }) as never))
      .distance(48)
      .strength(0.35),
  );
  // 3D 的斥力要比 2D 大 —— 空間多一個維度，同樣的斥力散得比較開
  simulation.force(
    'charge',
    forceManyBody()
      .strength(dimensions > 2 ? -70 : -40)
      .distanceMax(600),
  );
  simulation.force('center', forceCenter().strength(0.06));

  simulation.alpha(1);

  timer = setInterval(() => {
    const sim = simulation;
    if (sim === null) return;
    sim.tick(STEPS_PER_FRAME);
    const alpha = sim.alpha();
    emitPositions(alpha);
    if (alpha < sim.alphaMin()) {
      stopTimer();
      post({ type: 'settled' });
    }
  }, 1000 / TICKS_PER_SECOND);
}

ctx.onmessage = (event: MessageEvent<LayoutRequest>): void => {
  const message = event.data;

  if (message.type === 'start') {
    // **索引當 id** —— forceLink 預設用 node.index，而我們送進來的兩端就是索引
    nodes = message.ids.map((id) => ({ id }));
    edgePairs = message.edges;
    dimensions = message.dimensions;
    build();
    return;
  }

  if (message.type === 'dimensions') {
    if (message.dimensions === dimensions) return;
    dimensions = message.dimensions;
    // 換維度要重建模擬（力的強度不同，而且 2D 不該再有 z）——
    // **位置保留**，所以它是「攤平」不是「重新開始」
    if (dimensions === 2) for (const node of nodes) delete node.z;
    build();
    return;
  }

  if (message.type === 'reheat') {
    simulation?.alpha(1);
    if (timer === null) build();
    return;
  }

  stopTimer();
  simulation?.stop();
};
