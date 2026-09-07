/**
 * `d3-force-3d` 沒有附型別，DefinitelyTyped 上也沒有它的（`@types/d3-force` 是
 * 2D 版的，形狀不一樣 —— 用它會得到一份看起來對但少一個維度的型別）。
 *
 * **所以這一份只宣告我們真的用到的那幾支。**
 * 不要為了完整去補其他的：一份手寫的完整型別遲早會跟上游分岔，
 * 而分岔的那部分不會報錯，只會安靜地允許一個不存在的呼叫。
 *
 * 上游：https://github.com/vasturiano/d3-force-3d（MIT）
 */
declare module 'd3-force-3d' {
  export interface SimulationNode {
    id: string;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationEdge {
    source: string | SimulationNode;
    target: string | SimulationNode;
  }

  export interface Force {
    (alpha: number): void;
  }

  export interface LinkForce extends Force {
    links(links: SimulationEdge[]): LinkForce;
    id(accessor: (node: SimulationNode) => string): LinkForce;
    distance(value: number | ((edge: SimulationEdge) => number)): LinkForce;
    strength(value: number | ((edge: SimulationEdge) => number)): LinkForce;
  }

  export interface ManyBodyForce extends Force {
    strength(value: number): ManyBodyForce;
    distanceMax(value: number): ManyBodyForce;
    theta(value: number): ManyBodyForce;
  }

  export interface CenterForce extends Force {
    strength(value: number): CenterForce;
  }

  export interface Simulation {
    nodes(): SimulationNode[];
    nodes(nodes: SimulationNode[]): Simulation;
    force(name: string, force: Force | null): Simulation;
    force(name: string): Force | undefined;
    alpha(): number;
    alpha(value: number): Simulation;
    alphaMin(): number;
    alphaMin(value: number): Simulation;
    alphaDecay(value: number): Simulation;
    velocityDecay(value: number): Simulation;
    tick(iterations?: number): Simulation;
    stop(): Simulation;
    restart(): Simulation;
  }

  /** 第二個參數就是維度 —— **一鍵切 2D 靠的是它，不是把 z 壓成 0**。 */
  export function forceSimulation(nodes?: SimulationNode[], numDimensions?: 1 | 2 | 3): Simulation;
  export function forceLink(links?: SimulationEdge[]): LinkForce;
  export function forceManyBody(): ManyBodyForce;
  export function forceCenter(x?: number, y?: number, z?: number): CenterForce;
}
