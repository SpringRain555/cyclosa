/**
 * 中文標題的排序鍵。**純函式，零 I/O。**
 *
 * `node:sqlite` **沒有 `createCollation`**，而 JS 也產不出可以存進 SQL 的
 * collation sort key —— `Intl.Collator` 只給得出「兩個字串誰前誰後」。
 * 所以排序鍵只能是**名次**：整批排好之後，把序號寫進 `item.title_rank`。
 *
 * **代價是它會過期**：插入一筆新資料之後，它後面每一筆的名次都該 +1。
 * 我們不那樣做（那是一次全表更新），而是**每次 run 收尾時重排一次**。
 * 兩次 run 之間新進來的資料，排序位置可能不精確 —— 這是明知的取捨，
 * 不是 bug。要精確就要換成「用 collation 排序」，而那條路在 `node:sqlite` 上不存在。
 */

/** 名次的字串寬度。8 位數擋得住 5 萬筆（Stage 13 的規模預算）再乘上千倍。 */
const WIDTH = 8;

export function rankKey(position: number): string {
  return String(Math.max(0, Math.floor(position))).padStart(WIDTH, '0');
}

export interface Titled {
  readonly id: string;
  readonly title: string;
}

export interface Ranked {
  readonly id: string;
  readonly rank: string;
}

/**
 * 整批排名次。
 *
 * `numeric: true` 讓「第 2 章」排在「第 10 章」前面 ——
 * 那是使用者對「排序」的預期，而純碼點比對會給相反的答案。
 */
export function rankTitles(entries: readonly Titled[]): readonly Ranked[] {
  const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'variant' });
  const sorted = [...entries].sort((a, b) => {
    const byTitle = collator.compare(a.title, b.title);
    // **同名時用 id 決勝**，否則兩次重排會給出不同的名次，
    // 而那會讓 cursor 分頁在同名處跳過或重複一列。
    return byTitle !== 0 ? byTitle : a.id.localeCompare(b.id);
  });
  return sorted.map((e, i) => ({ id: e.id, rank: rankKey(i) }));
}
