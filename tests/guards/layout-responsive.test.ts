/**
 * 守門：**版面要能適應各種視窗長寬。**
 *
 * ## 這一條在修什麼
 *
 * 2026-09-11 使用者回報「有些地方沒有自適應長寬」。用無頭瀏覽器量過
 * 五種寬度 × 四個分頁之後找到一個根因，而它不是一個手滑：
 *
 * ```css
 * .settings {
 *   overflow-y: auto;     /* 我是捲動容器 *\/
 *   max-width: 760px;     /* 我也是行長限制 *\/
 *   margin-inline: auto;  /* 我還負責置中 *\/
 * }
 * ```
 *
 * 三件事寫在同一個元素上，有兩個量得到的後果：
 *
 * 1. **`margin-inline: auto` 會把 flex 子項的 `stretch` 取消掉** ——
 *    於是它變成「由內容決定寬度」。實測模型分頁 760px、來源網站分頁 785px，
 *    **同一頁的寬度跟著內容跳**
 * 2. **捲軸跟著內容跑到畫面中間**，右邊留一大片空白 ——
 *    在 3440px 的螢幕上那看起來就是壞的
 *
 * 修法是把它拆成兩層：外層填滿並負責捲動（捲軸在視窗邊緣），
 * 內層負責行長與置中。
 *
 * ## 為什麼是靜態檢查而不是真的量
 *
 * 真的量要一顆瀏覽器，而這個專案**連原生模組都不引**（ADR 的那條界線）——
 * 為了一條版面測試裝一個 Playwright 不划算。
 *
 * 所以這裡守的是**那個寫法**，而不是那個後果。量測本身留給
 * `operations/release-checklist.md` 的人工項目。
 *
 * > **這條規則寫下來的時候對整個 `web/src` 是零命中**，
 * > 而零命中跟規則壞掉長得一模一樣（CONVENTIONS §14）——
 * > 所以底下有一條測試**把修掉的那個寫法餵回去**，確認它真的會紅。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_SRC = join(REPO_ROOT, 'web', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.vue') || p.endsWith('.css')) out.push(p);
  }
  return out;
}

/** 一個 CSS 規則區塊：選擇器 ＋ 大括號裡的宣告。**不處理巢狀**，夠用。 */
interface Rule {
  readonly file: string;
  readonly selector: string;
  readonly body: string;
}

function rulesOf(text: string, file: string): Rule[] {
  const out: Rule[] = [];
  for (const m of text.matchAll(/([.#&][\w\-.>\s,:()[\]"'=]*)\{([^{}]*)\}/g)) {
    out.push({ file, selector: (m[1] ?? '').trim().slice(0, 60), body: m[2] ?? '' });
  }
  return out;
}

/** 捲動容器 ＋ 行長限制 ＋ 置中，三件事寫在同一個規則上。 */
function isScrollerThatAlsoCentres(body: string): boolean {
  const scrolls = /overflow(-y)?\s*:\s*(auto|scroll)/.test(body);
  const centres = /margin(-inline)?\s*:\s*[^;]*\bauto\b/.test(body);
  const caps = /max-width\s*:/.test(body);
  return scrolls && centres && caps;
}

const files = walk(WEB_SRC);
const allRules = files.flatMap((f) =>
  rulesOf(readFileSync(f, 'utf8'), f.slice(REPO_ROOT.length + 1)),
);

describe('版面：捲動與行長是兩件事', () => {
  it('掃得到東西 —— 一個掃不到檔案的檢查永遠會過', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(allRules.length).toBeGreaterThan(100);
  });

  /**
   * **一個會捲動的面板不要同時負責內容的行長。**
   *
   * 兩個理由：捲軸會跟著內容跑到畫面中間；而它如果是 flex 子項，
   * `margin: auto` 還會把 `stretch` 取消掉，寬度就變成跟著內容跳。
   *
   * 做法是拆兩層 —— 外層填滿並捲動，內層 `max-width` ＋ `margin-inline: auto`。
   */
  it('沒有任何規則同時是捲動容器、行長限制與置中', () => {
    const bad = allRules
      .filter((r) => isScrollerThatAlsoCentres(r.body))
      .map((r) => `${r.file} → ${r.selector}`);
    expect(bad).toEqual([]);
  });

  /**
   * **注入一次真違規。**
   *
   * 上面那一條現在對整個 `web/src` 是零命中，而零命中跟規則壞掉
   * 在測試報告上長得一模一樣。這一條把 2026-09-11 修掉的那個寫法
   * 原封不動餵回去，確認判準真的認得出來。
   */
  it('判準認得出被修掉的那個寫法', () => {
    const before = `
.settings {
  padding: 20px 24px 60px;
  overflow-y: auto;
  height: 100%;
  max-width: 760px;
  margin-inline: auto;
}`;
    const parsed = rulesOf(before, 'x.vue');
    expect(parsed).toHaveLength(1);
    expect(isScrollerThatAlsoCentres(parsed[0]!.body)).toBe(true);

    // 而拆成兩層之後不該再被認成違規。
    const after = `
.settings {
  overflow-y: auto;
  height: 100%;
  width: 100%;
}
.inner {
  padding: 20px 24px 60px;
  max-width: 760px;
  margin-inline: auto;
}`;
    for (const r of rulesOf(after, 'x.vue')) {
      expect(isScrollerThatAlsoCentres(r.body), r.selector).toBe(false);
    }
  });

  /**
   * **頂列上除了專題名稱以外，每一格都不准被壓縮。**
   *
   * flex 子項預設 `min-width: auto`，所以它們不會縮到比內容窄 ——
   * 一個長專題名會把「設定」與「結束 Cyclosa」整個推出畫面，
   * 而那兩顆是這一列上最不能不見的東西（一個是出口，一個是關機）。
   *
   * 實測（768px 寬、40 個字的專題名）：修之前結束鍵的右緣在畫面外。
   */
  it('頂列有 flex: none 的預設，而專題名稱是唯一可縮的那一格', () => {
    const app = readFileSync(join(WEB_SRC, 'App.vue'), 'utf8');
    // 每一格預設不縮。
    expect(app).toMatch(/\.topbar\s*>\s*\*\s*\{[^}]*flex:\s*none/);
    // 專題名稱可縮，而且縮到放不下就變刪節號。
    const crumb = rulesOf(app, 'App.vue').find((r) => r.selector === '.crumb.current');
    expect(crumb, '.crumb.current 不見了').toBeDefined();
    expect(crumb!.body).toMatch(/flex:\s*0\s+1/);
    expect(crumb!.body).toMatch(/text-overflow:\s*ellipsis/);
    // 結束鍵不換行 —— 換兩行會比 44px 的頂列高。
    const quit = rulesOf(app, 'App.vue').find((r) => r.selector === '.quit');
    expect(quit!.body).toMatch(/white-space:\s*nowrap/);
  });

  /**
   * **寬表格要有自己的捲動容器。**
   *
   * 各任務模型那張表四欄的最小寬度加起來比設定頁的行長還寬，
   * 也就是說它在**任何**視窗寬度下都塞不進去 ——
   * 修之前的症狀是整個設定頁固定橫向溢出 31px。
   */
  it('各任務模型那張表包在一個會橫捲的容器裡', () => {
    const settings = readFileSync(join(WEB_SRC, 'views', 'SettingsView.vue'), 'utf8');
    expect(settings).toContain('<div class="table-scroll">');
    // v0.24.0 起 `.table-scroll` 只在 base.css 定義一次（`no-element-restyle`）。
    const base = readFileSync(join(WEB_SRC, 'styles', 'base.css'), 'utf8');
    const scroll = rulesOf(base, 'base.css').find((r) => r.selector === '.table-scroll');
    expect(scroll, '.table-scroll 沒有樣式').toBeDefined();
    expect(scroll!.body).toMatch(/overflow-x:\s*auto/);
  });
});
