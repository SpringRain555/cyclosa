/**
 * 圖上那些 three.js 物件的工廠。
 *
 * **顏色一律從 `tokens.css` 讀，這裡不寫任何色碼**（ADR-0018 規則：
 * 顏色的唯一來源是那一份）。這一份決定的是**形狀**：
 * 方形／空心／漸細／等寬／點線／方塊／環。
 *
 * ## 一條線就是一根圓柱
 *
 * 四種畫法全部用同一套做法：**沿 +Y、長度 1、半徑 1 的幾何**，
 * 每一條線只是把它旋轉到方向上再縮放。差別只在幾何本身：
 *
 * | 畫法 | 幾何 |
 * |---|---|
 * | 漸細（具名）| 一段圓柱，上細下粗 |
 * | 漸細虛線（待查證的具名）| 五段，半徑跟著遞減 |
 * | 等寬（共同提及）| 一段等徑圓柱 ＋ 線中點一個方塊 |
 * | 點線（相似度）| 九段短的等徑圓柱 |
 *
 * 這樣做的好處是**幾何只建一次**，幾百條線共用同一份 buffer，
 * 每條線各自只有一個矩陣與一個材質。
 */
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  EdgesGeometry,
  Group,
  LatheGeometry,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { REFERENCE_FILL_OPACITY, referenceStyle } from './reference-style.js';

/** 一個節點的邊長。實體稍大一點，因為空心看起來比實心小。 */
export const NODE_SIZE = 7;
export const ENTITY_SIZE = 8.5;

/**
 * 顏色從 CSS 變數讀。
 *
 * **元件裡不寫顏色字面值** —— 這一支是那條規則在 3D 這一側的出口。
 * 讀不到就回一個中性灰而不是丟例外：一張灰色的圖仍然看得懂，
 * 一個沒有畫面的錯誤畫面不行。
 */
const cssCache = new Map<string, string>();

export function token(name: string): string {
  const cached = cssCache.get(name);
  if (cached !== undefined) return cached;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const resolved = value.length > 0 ? value : '#8b93a3';
  cssCache.set(name, resolved);
  return resolved;
}

// ── 線 ──────────────────────────────────────────────────────

/** 沿 +Y 從 0 到 1 的一段圓柱。 */
function segment(rTop: number, rBottom: number, from: number, to: number): BufferGeometry {
  const height = to - from;
  const geometry = new CylinderGeometry(rTop, rBottom, height, 8, 1, true);
  geometry.translate(0, from + height / 2, 0);
  return geometry;
}

/**
 * 由多段組成的一根線。
 *
 * `dashes` 是段數，`duty` 是每一格裡實心佔多少（0.6 ＝ 六成實心、四成空）。
 * `rTop`／`rBottom` 是整根線兩端的半徑，中間**線性內插** ——
 * 所以虛線版本仍然看得出漸細，方向感不會因為斷開而消失。
 */
function tube(dashes: number, duty: number, rTop: number, rBottom: number): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (let i = 0; i < dashes; i += 1) {
    const from = i / dashes;
    const to = from + duty / dashes;
    const lerp = (t: number): number => rBottom + (rTop - rBottom) * t;
    parts.push(segment(lerp(to), lerp(from), from, to));
  }
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged ?? parts[0] ?? new CylinderGeometry(1, 1, 1, 8);
}

/** 漸細 ＝ 有方向。上細下粗，粗的那端是起點。 */
const TAPERED = tube(1, 1, 0.18, 1);
/** 待查證的具名關係：漸細**而且**斷開 —— 顏色之外的第二重編碼。 */
const TAPERED_DASHED = tube(5, 0.62, 0.18, 1);
/** 等寬 ＝ 沒有方向。 */
const UNIFORM = tube(1, 1, 1, 1);
/** 等寬點線：段數多、每段短。 */
const DOTTED = tube(11, 0.42, 1, 1);

const materials = new Map<string, MeshBasicMaterial>();

/**
 * 線的材質**依（顏色, 不透明度）共用**。
 *
 * 這樣「一跳鄰域提亮」就只是把某幾條線的材質換成另一個既有的實例 ——
 * **不必重建物件，也不會動到別條線**（改共用材質的 opacity 會一次改到全部）。
 */
export function lineMaterial(color: string, opacity: number): MeshBasicMaterial {
  const key = `${color}|${opacity.toFixed(2)}`;
  const cached = materials.get(key);
  if (cached !== undefined) return cached;
  const material = new MeshBasicMaterial({
    color: new Color(color),
    transparent: opacity < 1,
    opacity,
  });
  materials.set(key, material);
  return material;
}

export type LineDrawing = 'tapered' | 'uniform' | 'dotted' | 'boxed';

export interface LineSpec {
  readonly drawing: LineDrawing;
  readonly dashed: boolean;
  readonly color: string;
  readonly opacity: number;
  /** 線的粗細。**它是排序線索，讀不出數字**（ADR-0015）*/
  readonly radius: number;
  /** 共同提及線中點那個方塊的顏色。其餘畫法用不到 */
  readonly boxColor?: string | undefined;
  /**
   * 已否決 —— **線中點打一個叉**（ADR-0018 規則 2：每個狀態都有第二重編碼）。
   *
   * 少了它，已否決的線跟已確認的線只差在灰色深了一階
   * （`#6b7280` 對 `#8b93a3`）—— 那既是「只靠顏色說話」，
   * 而且用的還是**明暗**，而明暗在這張圖上的意思是遠近。
   *
   * v0.3.0 沒做，因為那時**沒有任何路徑可以否決一條邊**：
   * 合成資料裡一條已否決的都沒有，圖例上那一行是空頭支票。
   * v0.4.0 一把裁決接上去，第一次按下「否決」就看得見了。
   */
  readonly crossed?: boolean | undefined;
}

function geometryFor(spec: LineSpec): BufferGeometry {
  if (spec.drawing === 'dotted') return DOTTED;
  if (spec.drawing === 'tapered') return spec.dashed ? TAPERED_DASHED : TAPERED;
  return UNIFORM;
}

/**
 * 一條線的物件。
 *
 * 回的是一個 `Group`：**管子是縮放的，方塊不是** ——
 * 直接縮放整個 Group 的話，線中點那個方塊會被拉成一根麵條。
 */
export function buildLine(spec: LineSpec): Group {
  const group = new Group();
  const material = lineMaterial(spec.color, spec.opacity);

  const shaft = new Mesh(geometryFor(spec), material);
  shaft.name = 'shaft';
  group.add(shaft);

  // 方塊與叉**互斥**：方塊只出現在共同提及線上，叉只出現在具名關係上
  // （`edgeLineFor` 保證 `crossed` 只給 `named`）。共用 `midpoint` 這個名字，
  // 因為 `placeLine` 對兩者要做的事完全一樣 —— 擺到線的中點。
  if (spec.drawing === 'boxed') {
    // **方塊就是那個實體** —— 它不是裝飾，是被攤平的那個節點本人
    const box = new Mesh(
      new BoxGeometry(4, 4, 4),
      new MeshBasicMaterial({ color: new Color(spec.boxColor ?? spec.color), wireframe: true }),
    );
    box.name = 'midpoint';
    group.add(box);
  } else if (spec.crossed === true) {
    const cross = sprite(
      texture('cross-edge', () => crossTexture(token('--edge-rejected'))),
      // 節點上的叉是 1.2；線上的叉略小一點，但**不能小到要瞇眼找** ——
      // 它是這條線唯一不靠顏色的辨識依據
      NODE_SIZE * 1.1,
    );
    cross.name = 'midpoint';
    group.add(cross);
  }
  return group;
}

const UP = new Vector3(0, 1, 0);
const direction = new Vector3();
const rotation = new Quaternion();

/** 把一條線擺到兩點之間。**每一幀都會呼叫，所以不要在裡面配置物件。** */
export function placeLine(
  group: Object3D,
  start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
  radius: number,
): void {
  direction.set(end.x - start.x, end.y - start.y, end.z - start.z);
  const length = direction.length();
  group.position.set(start.x, start.y, start.z);
  if (length < 1e-6) {
    group.visible = false;
    return;
  }
  group.visible = true;
  rotation.setFromUnitVectors(UP, direction.divideScalar(length));
  group.quaternion.copy(rotation);

  const shaft = group.children.find((child) => child.name === 'shaft');
  if (shaft !== undefined) shaft.scale.set(radius, length, radius);

  const midpoint = group.children.find((child) => child.name === 'midpoint');
  if (midpoint !== undefined) midpoint.position.set(0, length / 2, 0);
}

// ── 節點 ────────────────────────────────────────────────────

const nodeGeometry = new BoxGeometry(NODE_SIZE, NODE_SIZE, NODE_SIZE);
const entityGeometry = new BoxGeometry(ENTITY_SIZE, ENTITY_SIZE, ENTITY_SIZE);

export interface NodeSpec {
  readonly color: string;
  readonly dashed: boolean;
  /** 實體是空心的 —— **靠實心／空心分，不靠顏色** */
  readonly hollow: boolean;
  readonly opacity: number;
  readonly selected: boolean;
  readonly isFocus: boolean;
  readonly crossed: boolean;
}

/** 環用貼圖做的 sprite —— **它永遠面向鏡頭**，所以從任何角度都看得到。 */
function ringTexture(color: string, thickness: number): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - thickness, 0, Math.PI * 2);
    ctx.stroke();
  }
  return new CanvasTexture(canvas);
}

/** 打叉 —— **已排除與已否決都用它，因為色相已經用完了**。 */
function crossTexture(color: string): CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(10, 10);
    ctx.lineTo(size - 10, size - 10);
    ctx.moveTo(size - 10, 10);
    ctx.lineTo(10, size - 10);
    ctx.stroke();
  }
  return new CanvasTexture(canvas);
}

const textures = new Map<string, CanvasTexture>();

function texture(key: string, make: () => CanvasTexture): CanvasTexture {
  const cached = textures.get(key);
  if (cached !== undefined) return cached;
  const made = make();
  textures.set(key, made);
  return made;
}

function sprite(map: CanvasTexture, scale: number): Sprite {
  const item = new Sprite(new SpriteMaterial({ map, transparent: true, depthWrite: false }));
  item.scale.set(scale, scale, 1);
  return item;
}

// 焦點環是**一條緞帶圍成的圈**，不是一根圓管。
//
// 那個差別是為了跟選取環分開，而且分開的方式不是顏色：
// 選取環是一個永遠正對鏡頭的 sprite（一圈細線，從哪個角度看都是正圓），
// 焦點環是真的躺在 XZ 平面上的幾何。**方形截面把那件事講得更清楚** ——
// 轉動的時候你看得到那條帶子從正面收成側面，而一根圓管轉到哪都是同一根管子。
//
// **緞帶是站著繞的，不是躺著繞的** —— 像纏在一個圓筒外面那一圈，
// 不是躺在桌上的那一圈。躺著繞的時候，正對它看是一片很寬的實心圓環
// （2.9 寬），而它蓋住的正好是節點四周你要讀的東西。
//
// 站著繞之後兩個方向都是 1.1 到 2.2 之間：正對看是一圈 1.1 寬的細環，
// 側看是一條 2.2 高的帶子。**沒有一個角度它會胖到擋路，也沒有一個角度它會消失。**
//
// 半徑 1.6 倍、截面 1.1（沿半徑）× 2.2（沿環的軸）
// → 內緣 1.52 倍、外緣 1.68 倍，而標籤在 2.2 倍，兩者不重疊。
const RIBBON_RADIUS = NODE_SIZE * 1.6;
/** 沿半徑的厚度 —— 正對著環看的時候看到的就是這個寬度。 */
const RIBBON_DEPTH = 1.1;
/** 沿環的軸（Y）的高度 —— 側看時看到的是這條帶子的這一邊。 */
const RIBBON_HEIGHT = 2.2;

/**
 * 長方形截面繞 Y 軸轉一圈。
 *
 * `LatheGeometry` 的軸就是 Y，所以**它一出生就躺在 XZ 平面上** ——
 * 圓環（`TorusGeometry`）是建在 XY 平面上的、要再轉 90° 才躺平，這一個不用。
 *
 * 四個點是截面的四個角，第五個點回到起點把它封起來：
 * 下緣、外側、上緣、內側各一圈，四個面都是真的面（沒有退化的那一排）。
 * **外側那一圈就是緞帶的正面** —— 它朝外，所以側看時看到的是它。
 */
function ribbonGeometry(): LatheGeometry {
  const inner = RIBBON_RADIUS - RIBBON_DEPTH / 2;
  const outer = RIBBON_RADIUS + RIBBON_DEPTH / 2;
  const half = RIBBON_HEIGHT / 2;
  return new LatheGeometry(
    [
      new Vector2(inner, -half),
      new Vector2(outer, -half),
      new Vector2(outer, half),
      new Vector2(inner, half),
      new Vector2(inner, -half),
    ],
    64,
  );
}

const horizonGeometry = ribbonGeometry();
let sharedHorizonMaterial: MeshBasicMaterial | null = null;

function horizonMaterial(): MeshBasicMaterial {
  sharedHorizonMaterial ??= new MeshBasicMaterial({
    color: new Color(token('--focus-marker')),
    transparent: true,
    // **兩面都要畫。** 旋轉面的正反由點的順序決定，而這條帶子從上面看是一面、
    // 從下面看是另一面 —— 只畫單面的話，鏡頭移到另一側它會整條消失。
    side: DoubleSide,
    // 白色的時候要壓到 0.55 才不刺眼；紫色本來就沒那麼響，所以反而調高。
    // 帶子比圓管寬，正面遮住的東西也多一點 —— 這個 0.85 是讓底下的線
    // **看得出有東西**、但不會跟帶子搶讀。
    opacity: 0.85,
  });
  return sharedHorizonMaterial;
}

/**
 * 描邊。
 *
 * **不是為了跟背景分開**（背景本來就接近黑，描邊在那裡看不出來）——
 * 是為了讓方塊的**稜線**讀得出來：沒有它的時候，一個單色的立方體
 * 只有靠光照的明暗差在分面，而這張圖的燈很平。
 *
 * `EdgesGeometry` 只取真正的稜（夾角超過門檻的那些），
 * 所以一個立方體是 12 條線，不是三角網格的每一條邊。
 * **幾何與材質都共用**，幾百個節點加起來只多兩個物件。
 */
const nodeEdges = new EdgesGeometry(new BoxGeometry(NODE_SIZE, NODE_SIZE, NODE_SIZE));
let sharedOutlineMaterial: LineBasicMaterial | null = null;

function outlineMaterial(): LineBasicMaterial {
  sharedOutlineMaterial ??= new LineBasicMaterial({ color: new Color(token('--node-outline')) });
  return sharedOutlineMaterial;
}

export function buildNode(spec: NodeSpec): Group {
  const group = new Group();

  const body = new Mesh(
    spec.hollow ? entityGeometry : nodeGeometry,
    spec.hollow
      ? new MeshBasicMaterial({
          color: new Color(spec.color),
          wireframe: true,
          transparent: true,
          opacity: spec.opacity,
        })
      : new MeshLambertMaterial({
          color: new Color(spec.color),
          transparent: spec.opacity < 1,
          opacity: spec.opacity,
        }),
  );
  body.name = 'body';
  if (spec.dashed) {
    // A（不填）也留著本體、只是全透明 —— 設成 `visible = false` 的話，點選靠的那一塊不見了，
    // 只剩細細的虛線點得到。
    const fillScale = referenceStyle() === 'b' ? REFERENCE_FILL_OPACITY : 0;
    body.material.transparent = true;
    body.material.opacity = spec.opacity * fillScale;
    body.material.depthWrite = false;
    body.userData['opacityScale'] = fillScale;
    const outline = new LineSegments(
      nodeEdges,
      new LineDashedMaterial({
        color: new Color(token('--node-item')),
        dashSize: 1.4,
        gapSize: 0.9,
        transparent: true,
        opacity: spec.opacity,
      }),
    );
    outline.computeLineDistances();
    outline.name = 'reference-outline';
    group.add(outline);
  }
  group.add(body);

  // **只有實心的要描邊。** 空心實體本來就是線框 —— 它的稜線已經是線了，
  // 再描一次只會讓那個方塊在遠處糊成一團。
  if (!spec.hollow && !spec.dashed) {
    const outline = new LineSegments(nodeEdges, outlineMaterial());
    outline.name = 'outline';
    group.add(outline);
  }

  // **環一律建出來，用 visible 開關。**
  // 選取每換一次就重建幾百個節點物件是看得出來的卡頓，
  // 而兩個共用貼圖的 sprite 幾乎不花東西。

  // **外環＝你在哪。**
  //
  // 這裡以前還有一個「已讀」的灰色內環，2026-09-09 拿掉了（ADR-0024）：
  // 它畫在半徑 4.76 的地方，而方塊的側影邊緣在 4.95（正對面）到 5.71（角對著你）之間
  // —— 所以方塊永遠吃掉它一部分，**吃掉多少還隨著轉動在變**。
  // 已讀改標在標籤的字重上：未讀粗體、已讀正常。
  const selectedRing = sprite(
    texture('selected', () => ringTexture(token('--ring-selected'), 9)),
    NODE_SIZE * 2.6,
  );
  selectedRing.name = 'ring-selected';
  selectedRing.visible = spec.selected;
  group.add(selectedRing);

  if (spec.crossed) {
    const cross = sprite(
      texture('cross', () => crossTexture(token('--edge-rejected'))),
      NODE_SIZE * 1.2,
    );
    cross.name = 'cross';
    group.add(cross);
  }

  // 焦點：**一條躺平的緞帶，不是兩個記號。**
  //
  // 第一版是「平面準星 ＋ 傾斜環」，而那兩個講的是同一件事
  // （這裡是轉動中心）—— 於是它們一起把標籤壓在中間，
  // 而標籤是這張圖上你真正要讀的東西。
  //
  // 留下來的是躺在 XZ 平面上的那一條，所以**它跟著透視傾斜** ——
  // 轉動時最先看到的就是它在轉，那正是「轉動中心」這個資訊本身。
  // 平面準星是永遠正對鏡頭的，它給不出那個資訊。
  //
  // **這裡不轉 90°** —— `ribbonGeometry` 是繞 Y 軸旋轉出來的，已經躺平了。
  const horizon = new Mesh(horizonGeometry, horizonMaterial());
  horizon.name = 'focus-horizon';
  horizon.visible = spec.isFocus;
  group.add(horizon);

  return group;
}

// ── 標籤（語意縮放）──────────────────────────────────────────

/**
 * 標籤上限。
 *
 * 每個標籤是一張自己的貼圖，**幾千張小貼圖的記憶體不是零**。
 * 而且超過這個數量的時候，畫面上的字早就疊在一起看不清了 ——
 * 所以這個上限同時是效能界線與可讀性界線。
 */
export const MAX_LABELS = 300;

/**
 * 標籤的字型。**兩個字重是「未讀／已讀」**（ADR-0024）——
 * 700 與 400 都是實際存在的字重，不是合成出來的：中間值（500、600）在
 * 只有 Regular 與 Bold 的字型上會被捨進去，於是兩種狀態長得一模一樣。
 */
const LABEL_FONT_UNREAD = '700 30px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
const LABEL_FONT_READ = '400 30px "Noto Sans TC", "Microsoft JhengHei", sans-serif';

export function buildLabel(text: string, color: string, bold: boolean): Sprite | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const shown = trimmed.length > 18 ? `${trimmed.slice(0, 18)}…` : trimmed;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  const font = bold ? LABEL_FONT_UNREAD : LABEL_FONT_READ;
  ctx.font = font;
  // **粗體比較寬，所以量寬度一定要用同一個字重量。**
  // 量完才換字重的話，粗體的最後一兩個字會被裁掉。
  const width = Math.ceil(ctx.measureText(shown).width) + 16;
  canvas.width = width;
  canvas.height = 44;

  // 設過 canvas 尺寸之後 context 會重置，字型要再設一次
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(shown, 8, 24);

  const map = new CanvasTexture(canvas);
  const item = new Sprite(new SpriteMaterial({ map, transparent: true, depthWrite: false }));
  // **標籤高度要跟節點同一個量級。**
  // 第一次截圖時它是節點的三十倍寬 —— 一張圖上只看得到一行字。
  // 以「字高約等於節點邊長的 0.8」回推縮放，寬度照 canvas 比例走。
  const scale = (NODE_SIZE * 0.8) / canvas.height;
  item.scale.set(canvas.width * scale, canvas.height * scale, 1);
  // **1.1 倍會被焦點環壓住。** 那條緞帶的外緣在 1.68 倍，所以標籤要在它上面 ——
  // 這個數字不是排版偏好，它是被 `horizonGeometry` 的半徑決定的。
  item.position.set(0, NODE_SIZE * 2.2, 0);
  item.name = 'label';
  return item;
}

/** 換一張圖之前把上一張的東西丟掉 —— **貼圖不會自己消失**。 */
export function disposeTree(root: Object3D): void {
  root.traverse((child) => {
    const mesh = child as Mesh & { material?: Material | Material[] };
    if (mesh.material === undefined) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      const map = (material as unknown as { map?: { dispose?: () => void } }).map;
      // 共用的環／叉貼圖不能丟 —— 它們被快取起來給下一張圖用
      if (map?.dispose !== undefined && child.name === 'label') map.dispose();
      if (
        child.name === 'label' ||
        child.name === 'midpoint' ||
        child.name === 'body' ||
        child.name === 'reference-outline'
      ) {
        material.dispose();
      }
    }
  });
}
