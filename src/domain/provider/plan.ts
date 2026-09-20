/**
 * 規劃：一次研究要往哪幾個方向蒐集（ADR-0033 D5、REQ-0009 R3/R4/R6）。
 *
 * ## 方向不是切入角度
 *
 * 舊的「切入角度」是模型**從專題裡已有的資料歸納**出來的子問題，每條帶一個新聞調查式的
 * 立場標籤（時間線、反對意見、資金流向）。2026-09-18 使用者第一次真的用：
 * 「強迫我選角度，選項不是我要的、也不夠多」。
 *
 * 方向是**談出來的**：人說要什麼、模型提、人改。所以這裡沒有立場標籤（`stance`），
 * 每條方向要說清楚三件可以被檢查的事 —— **要找什麼、預期哪一類來源、關鍵詞**。
 * 而「切分明不明確、窮不窮舉」是人看得出來的，不是模型自稱的，所以每一輪
 * 還要交出 **`outOfScope`（刻意不查的範圍）** —— 邊界寫出來，才看得見有沒有漏。
 *
 * ## 這裡處理的是模型輸出，也就是外部輸入
 *
 * 跟 `angles.ts` 同一條規則：每一行都假設對面會回垃圾（少欄位、空字串、超長、重複、
 * 一次給三十條）。**回一份乾淨的規劃，或者回一份空的。**
 *
 * ## 超過上限要說，不靜默截掉（R6）
 *
 * `normalizePlan` 回 `overflow`，畫面照實說「模型提了 N 條，只留得下 12 條」。
 * 少掉的那幾條如果沒有人說，使用者永遠不會知道它們存在過 —— 而這一步的全部意義
 * 就是讓人看得見模型打算怎麼找。
 */

/**
 * 一次研究最多幾條方向（ADR-0033 D5、使用者 2026-09-20 定的 Q11）。
 *
 * 12 是**蒐集那一步的成本**決定的：每條方向各跑一次找來源，而那是會花錢的呼叫。
 * 上限本身不是規則的重點 —— **重點是超過了要說**（`overflow`）。
 */
export const MAX_DIRECTIONS = 12;

/** 一條方向的四個欄位各自的長度上限。**匯出的理由是它們要進 schema**（`research-prompts.ts`）。 */
export const MAX_DIRECTION_TITLE_CHARS = 60;
export const MAX_DIRECTION_WHAT_CHARS = 200;
export const MAX_DIRECTION_EXPECT_CHARS = 60;
export const MAX_KEYWORD_CHARS = 40;
export const MAX_KEYWORDS_PER_DIRECTION = 8;

/** 給人看的那一段、跟專題的關係、刻意不查的範圍。 */
export const MAX_REPLY_CHARS = 600;
export const MAX_RELATION_CHARS = 120;
export const MAX_OUT_OF_SCOPE = 6;
export const MAX_OUT_OF_SCOPE_CHARS = 80;

export interface DirectionDraft {
  readonly title: string;
  /** 要找什麼。**空字串是允許的** —— 標題有時候就說完了 */
  readonly what: string;
  /** 預期哪一類來源（「會議論文」「標準文件」「廠商白皮書」）。不是網域清單 */
  readonly expect: string;
  readonly keywords: readonly string[];
}

export interface PlanDraft {
  /** 給人看的一段話。**不進方向表**，它是對話的一輪 */
  readonly reply: string;
  /** 一句「這個主題跟這個專題的關係」 */
  readonly relation: string;
  readonly directions: readonly DirectionDraft[];
  readonly outOfScope: readonly string[];
  /** 模型提的方向超過 `MAX_DIRECTIONS`。**畫面要照實說**，不靜默截掉（R6）*/
  readonly overflow: boolean;
}

export const EMPTY_PLAN: PlanDraft = {
  reply: '',
  relation: '',
  directions: [],
  outOfScope: [],
  overflow: false,
};

type Raw = Record<string, unknown>;

/**
 * 一段字：**整段的空白壓成一個空格**，超長就切。
 *
 * 跟 `angles.ts` 的 `text()` 是同一支，刻意各留一份 —— 那一支是舊流程的，
 * Stage 22 會整個退場；共用會讓退場那一次動到這一邊。
 */
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * 比對用的鍵：去掉標點與空白。
 *
 * 「6G 的標準進度」與「6G 的標準進度？」在畫面上是同一條，而模型很容易兩條都給 ——
 * 使用者會覺得工具在灌水，而且兩條方向會各跑一次找來源（**各花一次錢**）。
 */
function dedupeKey(title: string): string {
  return title.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function keywordsOf(raw: unknown): readonly string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const entry of list) {
    if (out.length >= MAX_KEYWORDS_PER_DIRECTION) break;
    const word = text(entry, MAX_KEYWORD_CHARS);
    if (word.length === 0 || out.includes(word)) continue;
    out.push(word);
  }
  return out;
}

/** 一條方向。**標題是空的就不是一條方向** —— 回 `null`，呼叫端丟掉。 */
export function normalizeDirection(raw: unknown): DirectionDraft | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Raw;
  const title = text(row['title'], MAX_DIRECTION_TITLE_CHARS);
  if (title.length === 0) return null;
  return {
    title,
    what: text(row['what'], MAX_DIRECTION_WHAT_CHARS),
    expect: text(row['expect'], MAX_DIRECTION_EXPECT_CHARS),
    keywords: keywordsOf(row['keywords']),
  };
}

/**
 * 把模型回的一輪整理成一份規劃。
 *
 * **不會丟例外，也不會回 `null`** —— 對面回垃圾的時候回一份空的規劃，
 * 呼叫端照「這一輪沒有交出方向」處理（那是一個可以顯示的事實，不是一個錯誤）。
 */
export function normalizePlan(raw: unknown): PlanDraft {
  if (typeof raw !== 'object' || raw === null) return EMPTY_PLAN;
  const row = raw as Raw;

  const list = Array.isArray(row['directions']) ? (row['directions'] as unknown[]) : [];
  const directions: DirectionDraft[] = [];
  const seen = new Set<string>();
  let overflow = false;

  for (const entry of list) {
    const direction = normalizeDirection(entry);
    if (direction === null) continue;
    const key = dedupeKey(direction.title);
    if (key.length === 0 || seen.has(key)) continue;
    // **上限之後不是 break** —— 還要知道「多出來的那幾條是真的方向」才算 overflow：
    // 尾巴全是空物件的話，使用者看到的「提了 30 條」會是一句假話。
    if (directions.length >= MAX_DIRECTIONS) {
      overflow = true;
      continue;
    }
    seen.add(key);
    directions.push(direction);
  }

  const scope: string[] = [];
  const rawScope = Array.isArray(row['out_of_scope']) ? (row['out_of_scope'] as unknown[]) : [];
  for (const entry of rawScope) {
    if (scope.length >= MAX_OUT_OF_SCOPE) break;
    const line = text(entry, MAX_OUT_OF_SCOPE_CHARS);
    if (line.length === 0 || scope.includes(line)) continue;
    scope.push(line);
  }

  return {
    reply: text(row['reply'], MAX_REPLY_CHARS),
    relation: text(row['relation'], MAX_RELATION_CHARS),
    directions,
    outOfScope: scope,
    overflow,
  };
}
