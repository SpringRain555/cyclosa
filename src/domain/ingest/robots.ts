/**
 * `robots.txt` 的解析與比對（RFC 9309）。**純函式，零 I/O。**
 *
 * 抓 `robots.txt` 這件事本身在 `infrastructure/fetch/`，
 * 這裡只回答「這份文字加上這個路徑，准不准」。
 *
 * **這一份是規則，不是禮貌。** 不允許的不抓，而且**記錄原因**
 * （REQ-0003 的驗收條件之一是「不是靜默跳過」）。
 */

/** 我們的產品識別（送出去的 `User-Agent` 也用它開頭）。 */
export const USER_AGENT_TOKEN = 'cyclosa';

interface Rule {
  readonly allow: boolean;
  /** 規則裡寫的路徑樣式（未展開），長度就是「specificity」。 */
  readonly pattern: string;
}

export interface RobotsPolicy {
  readonly rules: readonly Rule[];
  /**
   * `crawl-delay` 秒數。**RFC 9309 沒有這個欄位**，但它普遍存在，
   * 而且它表達的是對方的意願 —— 比我們自己的間隔長就聽它的。
   */
  readonly crawlDelaySeconds: number | null;
}

/** 什麼都不擋的政策。`robots.txt` 回 4xx 時用它（RFC 9309 §2.3.1.3）。 */
export const ALLOW_ALL: RobotsPolicy = { rules: [], crawlDelaySeconds: null };

/**
 * 全部擋掉的政策。
 *
 * **`robots.txt` 拿不到（5xx、連不上）時用它。** RFC 9309 §2.3.1.4 說
 * 「unreachable 時 SHOULD 假設完全不允許」—— 這跟「4xx＝沒有規則＝可以抓」
 * 是**方向相反的兩條**，而它們很容易被寫成同一條。
 */
export const DISALLOW_ALL: RobotsPolicy = {
  rules: [{ allow: false, pattern: '/' }],
  crawlDelaySeconds: null,
};

function unquote(value: string): string {
  return value.trim();
}

/**
 * 解析成「給我們這一個 user-agent 的政策」。
 *
 * **群組挑選**：先找 token 完全相符的（不分大小寫），沒有才用 `*`。
 * 找到專屬群組之後 `*` 群組**整組作廢** —— RFC 9309 §2.2.1，
 * 而「兩組合併」是這裡最容易寫錯的方向。
 */
export function parseRobots(text: string, token: string = USER_AGENT_TOKEN): RobotsPolicy {
  const want = token.toLowerCase();

  // 一個群組 = 連續的 user-agent 行 + 它們後面的規則
  let currentAgents: string[] = [];
  let startingGroup = true;
  const groups = new Map<string, { rules: Rule[]; crawlDelay: number | null }>();

  const ensure = (agent: string): { rules: Rule[]; crawlDelay: number | null } => {
    const existing = groups.get(agent);
    if (existing !== undefined) return existing;
    const fresh = { rules: [] as Rule[], crawlDelay: null as number | null };
    groups.set(agent, fresh);
    return fresh;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0] ?? '';
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = unquote(line.slice(colon + 1));

    if (field === 'user-agent') {
      if (!startingGroup) {
        currentAgents = [];
        startingGroup = true;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }

    if (currentAgents.length === 0) continue;
    startingGroup = false;

    if (field === 'allow' || field === 'disallow') {
      // **空的 disallow 是「什麼都不擋」**，不是「擋掉空路徑」。
      if (field === 'disallow' && value.length === 0) continue;
      if (value.length === 0) continue;
      for (const agent of currentAgents)
        ensure(agent).rules.push({ allow: field === 'allow', pattern: value });
      continue;
    }

    if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        for (const agent of currentAgents) ensure(agent).crawlDelay = seconds;
      }
    }
  }

  const chosen = groups.get(want) ?? groups.get('*');
  if (chosen === undefined) return ALLOW_ALL;
  return { rules: chosen.rules, crawlDelaySeconds: chosen.crawlDelay };
}

/**
 * 樣式比對。支援 `*`（任意長度）與 `$`（結尾錨定），其餘字元逐字比。
 *
 * **不用 RegExp 是刻意的** —— 樣式來自對方的伺服器，
 * 把它轉成 RegExp 要處理跳脫，而漏跳脫一個字元就是一個由外部輸入控制的
 * regex（ReDoS）。逐字比對慢一點，但它的最壞情況是可預期的。
 */
export function matchesPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const pat = anchored ? pattern.slice(0, -1) : pattern;
  const parts = pat.split('*');

  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (part.length === 0) continue;

    if (i === 0) {
      if (!path.startsWith(part)) return false;
      cursor = part.length;
      continue;
    }

    const found = path.indexOf(part, cursor);
    if (found < 0) return false;
    cursor = found + part.length;
  }

  if (anchored) {
    const last = parts[parts.length - 1] ?? '';
    // 最後一段必須貼齊結尾；`*` 結尾的樣式加 `$` 等於「任意結尾」
    if (last.length === 0) return true;
    return path.endsWith(last) && path.length >= cursor;
  }
  return true;
}

export interface RobotsDecision {
  readonly allowed: boolean;
  /** 命中的那一條規則（記錄用 —— 「不是靜默跳過」）。 */
  readonly rule: string | null;
}

/**
 * 准不准抓這個路徑。
 *
 * **最長的樣式贏**（RFC 9309 §2.2.2 的 "most specific match"），
 * 長度一樣時 **`Allow` 贏**。沒有任何規則命中就是准。
 */
export function isAllowed(policy: RobotsPolicy, pathWithQuery: string): RobotsDecision {
  let best: Rule | null = null;
  for (const rule of policy.rules) {
    if (!matchesPattern(rule.pattern, pathWithQuery)) continue;
    if (best === null) {
      best = rule;
      continue;
    }
    if (rule.pattern.length > best.pattern.length) best = rule;
    else if (rule.pattern.length === best.pattern.length && rule.allow) best = rule;
  }
  if (best === null) return { allowed: true, rule: null };
  return { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` };
}

/** 從一個完整 URL 取出比對用的「路徑＋查詢字串」。 */
export function robotsPathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return '/';
  }
}
