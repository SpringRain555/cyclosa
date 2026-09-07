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
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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

  if (spec.drawing === 'boxed') {
    // **方塊就是那個實體** —— 它不是裝飾，是被攤平的那個節點本人
    const box = new Mesh(
      new BoxGeometry(4, 4, 4),
      new MeshBasicMaterial({ color: new Color(spec.boxColor ?? spec.color), wireframe: true }),
    );
    box.name = 'midpoint';
    group.add(box);
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
  /** 實體是空心的 —— **靠實心／空心分，不靠顏色** */
  readonly hollow: boolean;
  readonly opacity: number;
  readonly selected: boolean;
  readonly read: boolean;
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

const horizonGeometry = new TorusGeometry(NODE_SIZE * 2.4, 0.35, 6, 48);
let sharedHorizonMaterial: MeshBasicMaterial | null = null;

function horizonMaterial(): MeshBasicMaterial {
  sharedHorizonMaterial ??= new MeshBasicMaterial({
    color: new Color(token('--focus-marker')),
    transparent: true,
    opacity: 0.55,
  });
  return sharedHorizonMaterial;
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
  group.add(body);

  // **環一律建出來，用 visible 開關。**
  // 選取每換一次就重建幾百個節點物件是看得出來的卡頓，
  // 而兩個共用貼圖的 sprite 幾乎不花東西。

  // **內環＝讀過了**，長期狀態。貼著節點，不搶外環的位置
  const readRing = sprite(
    texture('read', () => ringTexture(token('--ring-read'), 6)),
    NODE_SIZE * 1.5,
  );
  readRing.name = 'ring-read';
  readRing.visible = spec.read;
  group.add(readRing);

  // **外環＝你在哪。** 比內環大一圈，所以兩個可以同時看得見
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

  // 焦點：白色準星 ＋ **傾斜環疊在上面，不取代節點自己的畫法**。
  // 環躺在 XZ 平面上，所以它跟著透視傾斜 —— **它同時是地平線**，
  // 轉動時最先看到的就是它在轉。
  const crosshair = sprite(
    texture('focus', () => ringTexture(token('--focus-marker'), 3)),
    NODE_SIZE * 3.4,
  );
  crosshair.name = 'focus-crosshair';
  crosshair.visible = spec.isFocus;
  group.add(crosshair);

  const horizon = new Mesh(horizonGeometry, horizonMaterial());
  horizon.rotation.x = -Math.PI / 2;
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

const LABEL_FONT = '500 30px "Noto Sans TC", "Microsoft JhengHei", sans-serif';

export function buildLabel(text: string, color: string): Sprite | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const shown = trimmed.length > 18 ? `${trimmed.slice(0, 18)}…` : trimmed;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  ctx.font = LABEL_FONT;
  const width = Math.ceil(ctx.measureText(shown).width) + 16;
  canvas.width = width;
  canvas.height = 44;

  // 設過 canvas 尺寸之後 context 會重置，字型要再設一次
  ctx.font = LABEL_FONT;
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
  item.position.set(0, NODE_SIZE * 1.1, 0);
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
      if (child.name === 'label' || child.name === 'midpoint' || child.name === 'body') {
        material.dispose();
      }
    }
  });
}
