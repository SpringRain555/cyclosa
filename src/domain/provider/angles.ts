/**
 * 多視角子問題（「切入角度」）。
 *
 * ## 視角是歸納出來的，不是想出來的
 *
 * STORM 的 Perspective-Guided Question Asking **是從相似主題的既有文章歸納視角**，
 * 不是叫模型憑空想幾個角度（`market-scan.md` 發現 ⑥）。
 * 對應到這裡：視角的素材是**這個專題裡已經有的 `item`**。
 * 一個從空白開始想角度的擴展，跟「叫 LLM 隨便發散」沒有差別。
 *
 * 所以每條子問題帶著 `seeds` —— **它是從你已有的哪幾份長出來的**。
 * 模型回的是編號（我們給它一份編過號的清單），
 * 而**編號一律驗證**：對不上的丟掉，不留一個指向不存在東西的引用。
 *
 * ## 設計稿的「預估會找到幾個」沒有做，那是刻意的
 *
 * 2026-09-05 的設計稿在每條子問題上寫「問題 · 立場標籤 · **預估會找到幾個**」。
 * 那個數字只可能有一個來源 —— **叫模型猜一個** ——
 * 而它會以一個精確的樣子出現在一個要人做決定的畫面上。
 * 這跟「可信度不給小數」（ADR-0017）擋的是同一件事。
 *
 * 換成 `seeds`：**「依據你已有的 3 份」是我們查得到、也驗得了的**。
 * 而且它對「要不要勾這一條」更有用 —— 它說的是這條角度憑什麼被提出來。
 *
 * ## 這裡處理的是**模型輸出**，也就是外部輸入
 *
 * 抓回來的東西是資料不是指令，模型吐出來的也是。
 * 這一支的每一行都在假設對面會回垃圾：少欄位、多欄位、重複、空字串、
 * 超長、編號亂指。**回一份乾淨的清單，或者回空的。**
 */

/** 一次最多提幾條角度。太多的話勾選本身就變成負擔。 */
export const MAX_ANGLES = 6;

/**
 * 一次最多勾幾條。**跟 `DEFAULT_BUDGET.maxRequests` 是綁在一起的** ——
 * 每條角度要花 2 次呼叫（找來源、抽關聯），加上產生角度那 1 次。
 */
export const MAX_SELECTED_ANGLES = 5;

/**
 * 子問題與立場的長度上限。**匯出的理由與 `MAX_ENTITIES` 那一組相同：它們要進 schema。**
 *
 * 超過 `MAX_QUESTION_CHARS` 的下場是 `text()` 回空字串，
 * 而空字串在下面那個迴圈裡是 `continue` —— **整條角度被丟掉**。
 * 模型提了六條、使用者看到五條，而畫面上沒有任何地方說少的那條去哪了。
 */
export const MAX_QUESTION_CHARS = 160;
export const MAX_STANCE_CHARS = 24;

export interface AngleDraft {
  readonly question: string;
  /** 立場標籤，例如「時間線」「反對意見」。**沒有就是空字串**，不是 `null` */
  readonly stance: string;
  /** 這條角度是從第幾份長出來的（0 起算，對應我們給模型的那份編號清單）*/
  readonly seeds: readonly number[];
}

type Raw = Record<string, unknown>;

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * 比對用的鍵。**去掉標點與空白之後比** ——
 * 模型很容易吐出「X 是誰？」與「X 是誰」兩條，
 * 而它們在畫面上就是同一條，使用者會覺得工具在灌水。
 */
function dedupeKey(question: string): string {
  return question.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

/**
 * 把模型回的東西整理成一份可以顯示的清單。
 *
 * `seedCount` 是我們給模型的那份清單有幾筆 —— **超出範圍的編號直接丟掉**，
 * 不去猜它想指哪一個。
 */
export function normalizeAngles(raw: unknown, seedCount: number): readonly AngleDraft[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: AngleDraft[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    if (out.length >= MAX_ANGLES) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Raw;

    const question = text(row['question'], MAX_QUESTION_CHARS);
    if (question.length === 0) continue;

    const key = dedupeKey(question);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);

    const rawSeeds = Array.isArray(row['seeds']) ? (row['seeds'] as unknown[]) : [];
    const seeds: number[] = [];
    for (const s of rawSeeds) {
      const n = typeof s === 'number' ? s : Number.NaN;
      if (!Number.isInteger(n) || n < 0 || n >= seedCount) continue;
      if (!seeds.includes(n)) seeds.push(n);
    }

    out.push({ question, stance: text(row['stance'], MAX_STANCE_CHARS), seeds });
  }
  return out;
}

// ── 候選來源 ──────────────────────────────────────────────

export interface SourceCandidate {
  readonly url: string;
  /** 模型說它為什麼相關。**只給人看，不進資料庫的任何規則** */
  readonly why: string;
}

/** 一條角度最多帶幾個網址回來。**同網域間隔 3 秒**，所以這個數字就是等待時間。 */
export const MAX_URLS_PER_ANGLE = 6;

/** 候選 URL 與它的理由各自的長度上限。**同樣要進 schema。** */
export const MAX_URL_CHARS = 2048;
export const MAX_WHY_CHARS = 200;

/**
 * 整理模型回的候選 URL。
 *
 * **只留 http／https，而且不在這裡抓** —— 這裡連 URL 合不合法都只做最粗的判斷，
 * 真正的正規化與去重在擷取管線裡（`domain/ingest/url.ts`），
 * 因為那是**唯一**一條路（ADR-0006 第 5 條）。在這裡多做一套就是第二條路的開始。
 */
export function normalizeCandidates(raw: unknown): readonly SourceCandidate[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: SourceCandidate[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    if (out.length >= MAX_URLS_PER_ANGLE) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Raw;

    const url = text(row['url'], MAX_URL_CHARS);
    if (!/^https?:\/\/\S+$/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    out.push({ url, why: text(row['why'], MAX_WHY_CHARS) });
  }
  return out;
}
