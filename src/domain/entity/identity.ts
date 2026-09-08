/**
 * 「這兩個名字是不是同一個東西」（Stage 10.5）。
 *
 * ## 這件事為什麼非做不可
 *
 * `entity-repo.ts` 開頭那段註解寫著：比對只看名字，不做同義詞，
 * 而代價是**同一個東西的兩種寫法會變成兩個節點**。
 * 當時的判斷是「多一個節點比錯一個節點好 —— 前者看得見，後者看不見」。
 *
 * **那個判斷有一個沒被算到的後果**：投影三段的門檻是
 * 「被 ≥3 份文件提到才展開成節點，被 1 份提到根本不畫」。
 * 所以一個被 9 份文件提到、但拆成三種叫法的實體，
 * **三個都低於門檻，一個都不會出現在圖上** ——
 * 那不是「多一個節點」，那是**少了唯一那一個**。
 *
 * ## 所以合併要做，而且必須做得回來
 *
 * 同一段註解的另一句話是這件事的設計限制：
 * **「合錯了沒有工具可以拆開」**（`edge` 已經指過去了，`edge_evidence` 也是）。
 *
 * 解法跟 ADR-0016 的墓碑同一個形狀：**不刪任何一列**。
 * 被吸收的那個實體留著，只是多一個 `merged_into` 指標，
 * 而圖在讀的時候順著指標走。**取消合併 ＝ 把那個指標清掉。**
 *
 * ## 這裡只提候選，不做決定
 *
 * 每一條合併建議都要人按。理由跟關聯要人裁決一樣，
 * 而且更強：**一條錯的關聯是一條看得到的線，一次錯的合併
 * 會把兩個人的事蹟混成一個人，而且混進去之後每一條線看起來都正常。**
 *
 * ⚠️ 純函式，零依賴。
 */

/** 全形英數與空白 → 半形。**中文來源裡混全形英文很常見。** */
function toHalfWidth(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else out += ch;
  }
  return out;
}

/**
 * 比對用的鍵。**只抹掉「不可能帶意義」的差異。**
 *
 * 大小寫、全半形、空白、以及包在名字外面的標點 —— 這幾樣改了不會變成別的東西。
 * **刻意不做的**：簡繁轉換（「台」與「臺」是同一個字，但「余」與「餘」不是）、
 * 去掉「公司」「大學」這種後綴（「台大」與「台大醫院」是兩個東西）。
 */
export function identityKey(name: string): string {
  return toHalfWidth(name)
    .toLowerCase()
    .replace(/[\s\u00a0\u3000]+/g, '')
    .replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
}

/**
 * 把「中文名（英文名）」這種寫法拆開。
 *
 * 抽出來的實體名很常長這樣：`台灣積體電路製造（TSMC）`、`Cyclosa ginnaga（銀腹蛛）`。
 * **括號裡的那個本身就是一個別名**，而它同時是最好用的比對依據 ——
 * 一份文件寫全名附註簡稱，另一份只寫簡稱。
 */
export function splitParenthetical(name: string): {
  readonly head: string;
  readonly inside: string | null;
} {
  const m = /^(.*?)[（(]([^（()）]{1,60})[)）]\s*$/u.exec(name.trim());
  if (m === null) return { head: name.trim(), inside: null };
  const head = (m[1] ?? '').trim();
  const inside = (m[2] ?? '').trim();
  if (head.length === 0 || inside.length === 0) return { head: name.trim(), inside: null };
  return { head, inside };
}

/** 一個實體用來比對的所有寫法：本名 ＋ 別名 ＋ 括號拆出來的。 */
export function surfaceFormsOf(name: string, aliases: readonly string[] = []): readonly string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed.length > 0) out.add(trimmed);
  };
  add(name);
  for (const alias of aliases) add(alias);
  const split = splitParenthetical(name);
  if (split.inside !== null) {
    add(split.head);
    add(split.inside);
  }
  return [...out];
}

/** 為什麼覺得這兩個是同一個。**畫面上要顯示它** —— 沒有理由的建議不該按。 */
export type MatchReason =
  /** 正規化之後完全一樣（大小寫／全半形／空白／外圍標點）*/
  | 'same-key'
  /** 一邊的別名等於另一邊的某個寫法 */
  | 'alias'
  /** 「甲（乙）」與「乙」 */
  | 'parenthetical';

export interface MatchCandidate {
  readonly reason: MatchReason;
  /** 高的排前面。**這不是機率，是排序用的** —— 畫面上不顯示數字。 */
  readonly strength: number;
}

const STRENGTH: Readonly<Record<MatchReason, number>> = {
  'same-key': 3,
  alias: 2,
  parenthetical: 2,
};

/**
 * 名字太短就不比。
 *
 * 兩個字的實體名（「中研院」「台大」）正規化之後很容易撞在一起，
 * 而**一個看起來有道理的錯誤合併，比沒有建議糟得多**。
 */
export const MIN_MATCH_CHARS = 2;

/**
 * 兩個實體像不像同一個。**不像就回 `null`，不回一個很低的分數。**
 *
 * 回 `null` 與回 `0.1` 在畫面上是兩件事：前者不會出現在待合併清單上，
 * 後者會 —— 而一份塞滿雜訊的待辦清單等於沒有清單。
 *
 * **刻意沒有做模糊比對**（編輯距離、子字串包含）。
 * 「台大」與「台大醫院」的編輯距離很近而它們是兩個東西；
 * 而真正需要模糊比對的情況（音譯人名的不同寫法）靠的應該是
 * `wikidata_qid`，不是字串距離。
 */
export function matchOf(
  left: { readonly name: string; readonly aliases?: readonly string[] },
  right: { readonly name: string; readonly aliases?: readonly string[] },
): MatchCandidate | null {
  if (identityKey(left.name).length < MIN_MATCH_CHARS) return null;
  if (identityKey(right.name).length < MIN_MATCH_CHARS) return null;

  const leftKey = identityKey(left.name);
  const rightKey = identityKey(right.name);
  if (leftKey === rightKey) return { reason: 'same-key', strength: STRENGTH['same-key'] };

  const leftForms = new Set(surfaceFormsOf(left.name, left.aliases ?? []).map(identityKey));
  const rightForms = new Set(surfaceFormsOf(right.name, right.aliases ?? []).map(identityKey));

  const declaredLeft = new Set((left.aliases ?? []).map(identityKey));
  const declaredRight = new Set((right.aliases ?? []).map(identityKey));
  if (declaredLeft.has(rightKey) || declaredRight.has(leftKey)) {
    return { reason: 'alias', strength: STRENGTH.alias };
  }

  for (const form of leftForms) {
    if (form.length >= MIN_MATCH_CHARS && rightForms.has(form)) {
      return { reason: 'parenthetical', strength: STRENGTH.parenthetical };
    }
  }
  return null;
}

export interface EntityLike {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly aliases?: readonly string[];
  /** 已經被合併掉的不再參與比對。 */
  readonly mergedInto?: string | null;
}

export interface MergeSuggestion {
  /** 留下來的那一個。**被提到比較多次的贏** —— 見下面。 */
  readonly keepId: string;
  readonly mergeId: string;
  readonly reason: MatchReason;
  readonly strength: number;
}

/**
 * 找出所有值得問人的配對。
 *
 * **型別不同就不比。** 一個 `person` 與一個 `org` 名字一樣是巧合，
 * 不是同一個東西（「王建民」可以同時是人與公司名）。
 *
 * 留哪一個：**被提到比較多次的那個**。理由是實際的 ——
 * 合併之後圖上會顯示留下來的那個名字，而出現得多的那個
 * 比較可能是使用者認得的寫法。次數一樣時留先建立的（id 字典序穩定）。
 */
export function suggestMerges(
  entities: readonly EntityLike[],
  mentionCount: (id: string) => number,
): readonly MergeSuggestion[] {
  const live = entities.filter((e) => e.mergedInto === null || e.mergedInto === undefined);
  const out: MergeSuggestion[] = [];

  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i] as EntityLike;
      const b = live[j] as EntityLike;
      if (a.type !== b.type) continue;

      const match = matchOf(a, b);
      if (match === null) continue;

      const countA = mentionCount(a.id);
      const countB = mentionCount(b.id);
      const aWins = countA > countB || (countA === countB && a.id <= b.id);
      out.push({
        keepId: aWins ? a.id : b.id,
        mergeId: aWins ? b.id : a.id,
        reason: match.reason,
        strength: match.strength,
      });
    }
  }
  return out.sort((x, y) => y.strength - x.strength || x.keepId.localeCompare(y.keepId));
}

/**
 * 順著 `merged_into` 走到最後那一個。
 *
 * **有防迴圈**：資料理論上不會有環（合併時會擋），但這支在讀取路徑上，
 * 而**一個讀取路徑上的無窮迴圈會讓整個畫面掛掉**，
 * 那比顯示一個沒被解開的實體嚴重得多。
 */
export function resolveMerged(id: string, mergedInto: ReadonlyMap<string, string>): string {
  let current = id;
  for (let hops = 0; hops < 8; hops++) {
    const next = mergedInto.get(current);
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
}
