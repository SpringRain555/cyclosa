/**
 * `domain/research` —— 一次研究（或整理）走到哪裡了（ADR-0033 D2／D3／D4）。
 *
 * ## 研究的狀態與作業的狀態是兩件事
 *
 * 真正做事的仍然是 `run`：蒐集是一筆作業、建圖是另一筆。研究只記**工作流停在哪**。
 * 分開的理由很具體：「等你上傳」可以等好幾天，而一個好幾天都標著「執行中」的作業，
 * 下次打開專題時會被掃成「上次停在半路」（`run-sweep`）。
 * **研究停在 `awaiting-user` 的時候，沒有任何作業在跑。**
 *
 * ## 這一層沒有 I/O
 *
 * 它只回答三個問題：**現在可以做什麼、下一個狀態是什麼、哪些狀態算「還沒結束」。**
 * 資料表在 `infrastructure/db`，用例編排在 `application/research-service.ts`。
 */

/** 研究 ＝ 一個主題走一遍；整理 ＝ 同一個殼，對象是整個專題（ADR-0033 D13）。 */
export const RESEARCH_KINDS = ['research', 'consolidate'] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

/**
 * 五步三閘門對應的狀態（ADR-0033 D3）。
 *
 * | 狀態 | 畫面上叫什麼 | 誰在動 |
 * |---|---|---|
 * | `planning` | 規劃中 | 人跟模型來回談 |
 * | `collecting` | 蒐集中 | 機器（一筆作業）|
 * | `awaiting-user` | 等你 | **人**，沒有作業在跑 |
 * | `reviewing` | 確認中 | 人 |
 * | `building` | 建圖中 | 機器（另一筆作業）|
 * | `done` | 已完成 | —— |
 * | `abandoned` | 放棄了 | —— |
 */
export const RESEARCH_STATUSES = [
  'planning',
  'collecting',
  'awaiting-user',
  'reviewing',
  'building',
  'done',
  'abandoned',
] as const;
export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

/** 終態。**只有這兩個**，其餘都算「這個專題還有一次研究沒結束」（D4）。 */
const FINAL: readonly ResearchStatus[] = ['done', 'abandoned'];

export function isFinal(status: ResearchStatus): boolean {
  return FINAL.includes(status);
}

/** 還沒結束。**同一個專題同時只有一列是這樣**（D4，資料表用部分唯一索引守）。 */
export function isOpen(status: ResearchStatus): boolean {
  return !isFinal(status);
}

/**
 * 狀態怎麼走。**每一步都是人按的按鈕或機器做完一段**，沒有自動跳的。
 *
 * `abandoned` 不在這張表裡 —— 它從任何沒結束的狀態都到得了（`mayAbandon`），
 * 寫進表裡的話每一列都要重複一次。
 */
const NEXT: Readonly<Record<ResearchStatus, ResearchStatus | null>> = {
  planning: 'collecting', // 閘門一「照這份規劃開始」
  collecting: 'awaiting-user', // 能抓的都抓完了
  'awaiting-user': 'reviewing', // 閘門二「完成蒐集」
  reviewing: 'building', // 閘門三「開始建圖」
  building: 'done',
  done: null,
  abandoned: null,
};

/** 主線上的下一個狀態；終態回 `null`。 */
export function nextStatus(status: ResearchStatus): ResearchStatus | null {
  return NEXT[status];
}

/**
 * **主線以外的兩條路**（Stage 20 補上的，`state-machines.md` 有整張表）：
 *
 * | 從 | 到 | 什麼時候 |
 * |---|---|---|
 * | `awaiting-user` | `collecting` | 「繼續蒐集」：你按過取消，或有幾條方向搜失敗了 |
 * | `collecting` | `reviewing` | 閘門二：蒐集停在半路（程式關掉了），而你決定不要剩下的 |
 *
 * 「停在半路之後繼續」是 `collecting → collecting`：狀態不變，換一筆新的作業。
 */
const DETOURS: readonly (readonly [ResearchStatus, ResearchStatus])[] = [
  ['awaiting-user', 'collecting'],
  ['collecting', 'reviewing'],
];

/** 這一步合不合法（主線、兩條岔路、或放棄）。 */
export function mayMove(from: ResearchStatus, to: ResearchStatus): boolean {
  if (to === 'abandoned') return mayAbandon(from);
  if (NEXT[from] === to) return true;
  return DETOURS.some(([a, b]) => a === from && b === to);
}

/**
 * 可以再談一輪嗎。**只有規劃中可以**。
 *
 * 閘門一按下去之後方向就落成一張表了（D5），這時候再讓模型改方向，
 * 會讓「蒐集照的是哪一份規劃」說不清楚 —— 而那正是這個閘門要釘住的東西。
 */
export function mayConverse(status: ResearchStatus): boolean {
  return status === 'planning';
}

/** 可以改方向嗎（人自己改、加、刪，R4）。**跟談一輪同一個時機**。 */
export function mayEditDirections(status: ResearchStatus): boolean {
  return status === 'planning';
}

/** 閘門一按得下去嗎。**規劃中，而且至少有一條方向**（R5、R6：下限是 1 不是 0）。 */
export function mayStartCollecting(status: ResearchStatus, directions: number): boolean {
  return status === 'planning' && directions > 0;
}

/** 放棄。**任何還沒結束的狀態都可以**，結束了的不行（那會把一筆完成的紀錄改掉）。 */
export function mayAbandon(status: ResearchStatus): boolean {
  return isOpen(status);
}

/**
 * 刪得掉嗎（「刪除這次研究」，ADR-0033 D15／Q7）。
 *
 * **只有終態刪得掉。** 進行中的先放棄再刪 —— 一筆正在跑的研究被刪掉的話，
 * 跑完的那筆作業會指向一個不存在的研究，而作業紀錄是「圖上這些東西來自哪裡」的唯一紀錄。
 */
export function mayDelete(status: ResearchStatus): boolean {
  return isFinal(status);
}

/** 字串 → 狀態。**認不得的一律當 `planning`**（資料庫的 CHECK 擋過一次了）。 */
export function statusOf(value: unknown): ResearchStatus {
  return RESEARCH_STATUSES.includes(value as ResearchStatus)
    ? (value as ResearchStatus)
    : 'planning';
}

export function kindOf(value: unknown): ResearchKind {
  return value === 'consolidate' ? 'consolidate' : 'research';
}

export * from './collect.js';
