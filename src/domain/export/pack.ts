/**
 * 證據包的形狀，與它的 Markdown ／ JSONL 版本（Stage 11）。
 *
 * ## 這一層不知道資料庫，也不知道檔案系統
 *
 * 它拿到的是一份已經組好、已經驗過的資料，吐出三份文字。
 * 好處是**這一份的每一條規則都測得起來**，不用先有一個專題。
 *
 * ## 為什麼中文寫在這裡而不是 `i18n/zh-TW.ts`
 *
 * 那張字串表是**前端**的（守門測試也只掃 `web/src/`）。
 * 而這三份檔案是伺服器產生、拿去給別人看的東西 ——
 * 它們在使用者的瀏覽器關掉之後還存在，所以它們的字不能從前端來。
 *
 * ## 三份檔案，三個工作
 *
 * | 檔 | 給誰看 | 它回答什麼 |
 * |---|---|---|
 * | `evidence-pack.md` | 人 | 這一塊裡有哪些主張，每一條的引文是什麼、出自哪裡 |
 * | `sources.md` | 人 | 那些引文來自哪幾份東西，各自是什麼時候抓的 |
 * | `evidence.jsonl` | 程式 | **每條引文一列**，可以拿去逐條核對 |
 *
 * 第三份存在的理由是驗收條件本身：「每條引文都能回溯到 `item` 與字元區間」
 * 是一句**可以被程式檢查的話**，而只有 Markdown 的話它就只能靠人讀。
 *
 * ## 這份是紀錄，不是報告
 *
 * REQ-0005 的「刻意不做」：**一個會生成散文的工具，使用者就不會回去看出處了。**
 * 所以這裡沒有任何一句是我們替使用者下的結論 ——
 * 每一段都是「誰說了什麼、在哪一份的哪一段字」。
 */
import type { Rect } from '../annotation/index.js';
import type { ConfidenceTier, EdgeLayer, EdgeOrigin, EdgeStatus } from '../graph/index.js';
import type { QuoteStatus } from './verify.js';

// ── 形狀 ──────────────────────────────────────────────────

export interface PackQuote {
  readonly itemId: string;
  readonly itemTitle: string;
  readonly quote: string;
  readonly status: QuoteStatus;
  /** 驗過之後的位置。 */
  readonly start: number;
  readonly end: number;
  /** 資料庫裡記著的位置。**跟上面不一樣就是它搬過家。** */
  readonly recordedStart: number;
  readonly recordedEnd: number;
  /** 那一份的快照雜湊。**回溯的終點是它，不是 `item` 的 id。** */
  readonly snapshotSha256: string | null;
  /** PDF 才有。 */
  readonly page: number | null;
  /** 圖片上的矩形才有。 */
  readonly rect: Rect | null;
}

export interface PackEdge {
  readonly id: string;
  readonly rel: string;
  readonly sourceTitle: string;
  readonly targetTitle: string;
  /** 有方向的層才畫箭頭。**共同提及沒有主詞與受詞。** */
  readonly directional: boolean;
  readonly layer: EdgeLayer;
  readonly status: EdgeStatus;
  readonly origin: EdgeOrigin;
  readonly tier: ConfidenceTier;
  readonly evidenceCount: number;
  readonly independentSourceCount: number;
  readonly previouslyRejected: boolean;
  readonly quotes: readonly PackQuote[];
}

export interface PackNote {
  readonly id: string;
  readonly body: string;
  readonly createdAt: number;
  /** 標在哪一份上。**那一份不在了就是 `null`。** */
  readonly quote: PackQuote | null;
}

export interface PackSource {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly lang: string;
  readonly sourceUrl: string | null;
  readonly fetchedAt: number | null;
  readonly sha256: string | null;
  readonly sourceExt: string | null;
  readonly lowConfidence: boolean;
  readonly lowConfidenceReasons: readonly string[];
}

export interface EvidencePack {
  readonly caseName: string;
  readonly focusTitle: string;
  readonly hops: number;
  readonly exportedAt: number;
  readonly nodeCount: number;
  /** 選取範圍裡真的存在於資料庫的關聯數。**不含投影線。** */
  readonly edgeCount: number;
  /**
   * **只有具名關係進這三組。**
   *
   * ADR-0015：四層裡只有 `named` 進人工裁決，其餘三層是機器算出來的、可以重算的。
   * 把它們混進「待查證」會讓一個只有一條開放問題的專題，
   * 看起來像有九條 —— 而那八條**永遠不會被查證**，因為它們不是主張。
   */
  readonly confirmed: readonly PackEdge[];
  readonly pending: readonly PackEdge[];
  readonly rejected: readonly PackEdge[];
  /** 衍生／共同提及／相似度。**列成一張表，不附引文** —— 它們照設計就沒有出處。 */
  readonly structural: readonly PackEdge[];
  readonly notes: readonly PackNote[];
  readonly sources: readonly PackSource[];
  /**
   * 畫面上有、而匯出裡沒有的那幾條共同提及線。
   *
   * **它們不在資料庫裡**（`graph-service` 裡那個 `proj:` 前綴），
   * 所以沒有出處可以附。但使用者剛剛在畫面上看見它們 ——
   * **不說一聲就少掉，看起來會像資料掉了。**
   */
  readonly projectedOmitted: number;
}

// ── 中文標籤 ──────────────────────────────────────────────

const LAYER_ZH: Readonly<Record<EdgeLayer, string>> = {
  derived: '衍生',
  named: '具名關係',
  comention: '共同提及',
  similarity: '相似度',
};

const STATUS_ZH: Readonly<Record<EdgeStatus, string>> = {
  pending: '待查證',
  confirmed: '已確認',
  rejected: '已否決',
};

const ORIGIN_ZH: Readonly<Record<EdgeOrigin, string>> = {
  machine: '機器提出',
  human: '人建立的',
};

const TIER_ZH: Readonly<Record<ConfidenceTier, string>> = {
  weak: '弱',
  medium: '中',
  strong: '強',
};

const QUOTE_STATUS_ZH: Readonly<Record<QuoteStatus, string>> = {
  verified: '已核對',
  shifted: '位置已移動',
  missing: '回溯不到',
};

const ITEM_KIND_ZH: Readonly<Record<string, string>> = {
  web: '網頁',
  pdf: 'PDF',
  image: '圖片',
  text: '純文字',
  paper: '論文',
  note: '點註',
};

// ── 小工具 ────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 引用區塊。**每一行都要前綴**，空行是單獨一個 `>`。 */
function blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * 標題包在〈〉裡。
 *
 * 不只是排版：文件標題裡出現 `[` 或 `]` 的機率不低（「[更新] 某某事件」），
 * 而那兩個字元在 Markdown 裡會開始一個連結。**〈〉不會開始任何東西。**
 */
function name(title: string): string {
  const trimmed = title.trim();
  return trimmed.length === 0 ? '〈未命名〉' : `〈${trimmed}〉`;
}

function range(start: number, end: number): string {
  return `字元 ${String(start)}–${String(end)}`;
}

/** 雜湊只顯示前 12 碼。**完整的那一份在 `evidence.jsonl` 裡。** */
function shortHash(sha256: string): string {
  return `${sha256.slice(0, 12)}…`;
}

/**
 * 一條引文底下那一行 —— **回溯資訊本身**。
 *
 * 驗收條件是「每條引文都能回溯到 `item` 與字元區間」，
 * 而這一行就是那句話在檔案裡的樣子。
 */
function traceLine(q: PackQuote): string {
  const parts = [name(q.itemTitle), `\`${q.itemId}\``];
  if (q.page !== null) parts.push(`第 ${String(q.page)} 頁`);
  if (q.rect !== null) {
    parts.push(
      `矩形 ${String(q.rect.x)},${String(q.rect.y)} ${String(q.rect.w)}×${String(q.rect.h)}`,
    );
  } else {
    parts.push(range(q.start, q.end));
  }
  // 沒有快照的時候**不要印一個空的程式碼片段** —— 那看起來像一個壞掉的雜湊。
  parts.push(q.snapshotSha256 === null ? '沒有快照' : `快照 \`${shortHash(q.snapshotSha256)}\``);
  return parts.join(' · ');
}

function quoteBlock(q: PackQuote): readonly string[] {
  const lines: string[] = [];

  if (q.status === 'missing') {
    // **照樣寫出來。** 省略它會讓這份證據包看起來比它實際上乾淨。
    lines.push('> （這一段在目前的正文裡找不到，以下是紀錄裡存的那一段）');
    lines.push('>');
  }
  lines.push(blockquote(q.quote));
  lines.push('');
  lines.push(traceLine(q));

  if (q.status === 'shifted') {
    lines.push('');
    lines.push(
      `**${QUOTE_STATUS_ZH.shifted}**：紀錄裡是${range(q.recordedStart, q.recordedEnd)}，` +
        `重算後的正文在${range(q.start, q.end)}。引文本身一字不差。`,
    );
  }
  if (q.status === 'missing') {
    lines.push('');
    lines.push(
      `**${QUOTE_STATUS_ZH.missing}**：紀錄裡是${range(q.recordedStart, q.recordedEnd)}，` +
        '而現在的正文裡找不到這一段。這一條不能當成已經驗過的出處。',
    );
  }
  return lines;
}

function edgeHeading(edge: PackEdge, index: number): string {
  const arrow = edge.directional ? '→' : '—';
  return `### ${String(index)} · ${name(edge.sourceTitle)} ${arrow} ${name(edge.targetTitle)}（${edge.rel}）`;
}

function edgeFacts(edge: PackEdge): string {
  const parts = [
    LAYER_ZH[edge.layer],
    STATUS_ZH[edge.status],
    ORIGIN_ZH[edge.origin],
    `出處 ${String(edge.evidenceCount)} 筆`,
    `獨立來源 ${String(edge.independentSourceCount)} 個`,
    `可信度 ${TIER_ZH[edge.tier]}`,
  ];
  if (edge.previouslyRejected) parts.push('**曾被否決過**');
  return parts.join(' · ');
}

function edgeSection(edge: PackEdge, index: number): readonly string[] {
  const lines = [edgeHeading(edge, index), '', edgeFacts(edge), '', `\`${edge.id}\``, ''];
  if (edge.quotes.length === 0) {
    // **「沒有引文」的原因有兩種，而它們的意思相反。**
    //
    // 人建的邊本來就沒有引文 —— 出處就是那個人（Stage 8）。
    // 而機器提出的具名關係沒有引文是一件**不對的事**：它確認不了，
    // 資料庫的觸發器擋著。第一版這裡兩種都印同一句「它是人直接建立的主張」，
    // 於是一條機器提出、沒有出處的邊，在證據包裡看起來像有人替它背書。
    lines.push(
      edge.origin === 'human'
        ? '這一條沒有引文 —— 它是人直接建立的主張，出處就是建立它的那個人。'
        : '這一條沒有引文，而它是機器提出的。**這樣的關聯確認不了** —— 資料庫要求機器提出的關聯至少有一筆出處才能被確認。',
      '',
    );
    return lines;
  }
  for (const q of edge.quotes) lines.push(...quoteBlock(q), '');
  return lines;
}

/**
 * 衍生／共同提及／相似度那三層。
 *
 * **一張表，不附引文** —— 它們照設計就沒有出處（ADR-0015），
 * 而把它們排在「待查證」裡會讓一個只有一條開放問題的專題看起來像有九條。
 */
function structuralSection(edges: readonly PackEdge[]): readonly string[] {
  if (edges.length === 0) return [];
  const lines = [
    `## 其餘三層（${String(edges.length)} 條）`,
    '',
    '這幾條**不是主張，是機器算出來的結構**：誰轉載了誰、哪兩份提到同一個實體、',
    '哪兩份內容相近。它們沒有引文，而那不是缺漏 —— 它們可以隨時重算，',
    '也不會進人工裁決。**列出來是為了讓這一塊的形狀完整。**',
    '',
    '| 關聯 | 關係 | 層 |',
    '|---|---|---|',
  ];
  for (const edge of edges) {
    const arrow = edge.directional ? '→' : '—';
    lines.push(
      `| ${name(edge.sourceTitle)} ${arrow} ${name(edge.targetTitle)} | ${edge.rel} | ${LAYER_ZH[edge.layer]} |`,
    );
  }
  lines.push('');
  return lines;
}

function edgeGroup(title: string, edges: readonly PackEdge[]): readonly string[] {
  if (edges.length === 0) return [];
  const lines = [`## ${title}（${String(edges.length)} 條）`, ''];
  edges.forEach((edge, i) => lines.push(...edgeSection(edge, i + 1)));
  return lines;
}

// ── evidence-pack.md ──────────────────────────────────────

export function countQuotes(pack: EvidencePack): Readonly<Record<QuoteStatus | 'total', number>> {
  const all: PackQuote[] = [];
  for (const edge of [...pack.confirmed, ...pack.pending]) all.push(...edge.quotes);
  for (const note of pack.notes) if (note.quote !== null) all.push(note.quote);
  return {
    total: all.length,
    verified: all.filter((q) => q.status === 'verified').length,
    shifted: all.filter((q) => q.status === 'shifted').length,
    missing: all.filter((q) => q.status === 'missing').length,
  };
}

export function renderPack(pack: EvidencePack): string {
  const counts = countQuotes(pack);
  const lines: string[] = [
    `# 證據包：${pack.caseName}`,
    '',
    `- 匯出時間：${iso(pack.exportedAt)}`,
    `- 範圍：焦點 ${name(pack.focusTitle)} 往外 ${String(pack.hops)} 跳 —— ` +
      `${String(pack.nodeCount)} 個節點、${String(pack.edgeCount)} 條關聯`,
    `- 引文 ${String(counts.total)} 條：已核對 ${String(counts.verified)}、` +
      `位置已移動 ${String(counts.shifted)}、回溯不到 ${String(counts.missing)}`,
    '',
    '> 這一份是紀錄，不是報告。每一條引文下面都寫著它出自哪一份、',
    '> 在那一份正文的哪一段字元 —— 拿著那兩個數字就能回到原文。',
    '> **回溯不到的那幾條留在文件裡並標明**，不會被省略。',
    '',
  ];

  lines.push(...edgeGroup('已確認的關聯', pack.confirmed));
  lines.push(...edgeGroup('待查證的關聯', pack.pending));

  if (pack.pending.length > 0) {
    // **「它們帶著引文」不能無條件印。** 第一版是無條件的，而人工驗收那一次
    // 八條待查證全都沒有引文 —— 那句話當場是假的。
    const withQuotes = pack.pending.some((edge) => edge.quotes.length > 0);
    lines.push(
      withQuotes
        ? '> 上面這一組**還沒有人裁決過**。它們帶著引文，但那只代表「有人這樣說」，不代表它成立。'
        : '> 上面這一組**還沒有人裁決過**，而且一條引文都沒有。',
      '',
    );
  }

  // 已否決的**只列不附引文**：你已經判斷過它們不成立，
  // 而把它們的引文一起印出來會讓這份文件看起來像在替它們說話。
  if (pack.rejected.length > 0) {
    lines.push(`## 已否決的關聯（${String(pack.rejected.length)} 條）`, '');
    lines.push(
      '這幾條被判定為不成立。**列出來是因為「看過而且否決了」也是紀錄的一部分** ——',
      '一份只列出成立的關聯的證據包，會讓人以為每一條都成立。',
      '',
      '| 關聯 | 關係 | 層 |',
      '|---|---|---|',
    );
    for (const edge of pack.rejected) {
      const arrow = edge.directional ? '→' : '—';
      lines.push(
        `| ${name(edge.sourceTitle)} ${arrow} ${name(edge.targetTitle)} | ${edge.rel} | ${LAYER_ZH[edge.layer]} |`,
      );
    }
    lines.push('');
  }

  lines.push(...structuralSection(pack.structural));

  if (pack.notes.length > 0) {
    lines.push(`## 點註（${String(pack.notes.length)} 則）`, '');
    lines.push('**這一組是你自己寫的**，不是抓回來的。它們的引文一樣可以回溯。', '');
    pack.notes.forEach((note, i) => {
      lines.push(`### ${String(i + 1)} · \`${note.id}\``, '');
      if (note.quote !== null) {
        lines.push(...quoteBlock(note.quote), '');
      } else {
        lines.push('這一則沒有錨在任何一份上。', '');
      }
      if (note.body.trim().length > 0) lines.push(note.body.trim(), '');
    });
  }

  if (pack.projectedOmitted > 0) {
    lines.push(
      '## 沒有匯出的',
      '',
      `畫面上有 ${String(pack.projectedOmitted)} 條**投影出來的共同提及線**，這裡沒有它們。`,
      '',
      '它們不是資料庫裡的關聯 —— 是「這兩份都提到同一個實體」在畫面上的畫法，',
      '每次打開都重算。**沒有出處可以附，所以不能放進證據包。**',
      '要看它們背後的實體，把那個實體本身放進選取範圍。',
      '',
    );
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

// ── sources.md ────────────────────────────────────────────

export function renderSources(pack: EvidencePack): string {
  const lines: string[] = [
    `# 來源清單：${pack.caseName}`,
    '',
    `- 匯出時間：${iso(pack.exportedAt)}`,
    `- 抓回來的 ${String(pack.sources.length)} 份 · 自己寫的 ${String(pack.notes.length)} 則`,
    '',
    '> **抓回來的與自己寫的分開列。** 兩者混在一起的話，',
    '> 一份證據包看起來會比它實際上更有來源。',
    '',
  ];

  if (pack.sources.length === 0) {
    lines.push('這個範圍裡沒有抓回來的資料。', '');
  } else {
    lines.push('## 抓回來的', '');
    pack.sources.forEach((source, i) => {
      lines.push(`### ${String(i + 1)} · ${name(source.title)}`, '');
      lines.push(
        `- \`${source.id}\` · ${ITEM_KIND_ZH[source.kind] ?? source.kind} · 語言 \`${source.lang}\``,
      );
      lines.push(
        source.sourceUrl === null
          ? '- 網址：（本機檔案，沒有網址）'
          : `- 網址：${source.sourceUrl}`,
      );
      lines.push(
        source.fetchedAt === null
          ? '- 抓取時間：（不適用）'
          : `- 抓取時間：${iso(source.fetchedAt)}`,
      );
      if (source.sha256 === null) {
        lines.push('- 快照：（沒有）');
      } else {
        const file =
          source.sourceExt === null
            ? source.sha256
            : `sources\\${source.sha256}.${source.sourceExt}`;
        lines.push(`- 快照：\`${source.sha256}\`（\`${file}\`）`);
      }
      if (source.lowConfidence) {
        const why =
          source.lowConfidenceReasons.length > 0
            ? `：${source.lowConfidenceReasons.join('、')}`
            : '';
        lines.push(`- **抽取信心低**${why} —— 這一份的正文可能不完整`);
      }
      lines.push('');
    });
  }

  if (pack.notes.length > 0) {
    lines.push('## 自己寫的', '');
    pack.notes.forEach((note, i) => {
      lines.push(`- ${String(i + 1)}. \`${note.id}\` · 建立於 ${iso(note.createdAt)}`);
    });
    lines.push('');
  }

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

// ── evidence.jsonl ────────────────────────────────────────

/**
 * 一條引文一列。**這一份才是驗收條件的可執行版本** ——
 * 「每條引文都能回溯到 `item` 與字元區間」是一句程式查得動的話，
 * 而 Markdown 只有人讀得動。
 */
export interface EvidenceRow {
  readonly kind: 'edge' | 'note';
  /** `edge.id` 或 `note.id`。 */
  readonly ownerId: string;
  readonly rel: string | null;
  readonly itemId: string;
  readonly quote: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly recordedStart: number;
  readonly recordedEnd: number;
  readonly status: QuoteStatus;
  readonly snapshotSha256: string | null;
  readonly page: number | null;
}

export function evidenceRows(pack: EvidencePack): readonly EvidenceRow[] {
  const rows: EvidenceRow[] = [];

  const push = (kind: 'edge' | 'note', ownerId: string, rel: string | null, q: PackQuote): void => {
    rows.push({
      kind,
      ownerId,
      rel,
      itemId: q.itemId,
      quote: q.quote,
      charStart: q.start,
      charEnd: q.end,
      recordedStart: q.recordedStart,
      recordedEnd: q.recordedEnd,
      status: q.status,
      snapshotSha256: q.snapshotSha256,
      page: q.page,
    });
  };

  // **已否決的不進這一份。** 它們在 Markdown 裡列出來是為了誠實，
  // 而這一份的每一列都是一條「拿去核對」的指令 —— 核對一條你已經否決的沒有意義。
  for (const edge of [...pack.confirmed, ...pack.pending]) {
    for (const q of edge.quotes) push('edge', edge.id, edge.rel, q);
  }
  for (const note of pack.notes) {
    if (note.quote !== null) push('note', note.id, null, note.quote);
  }
  return rows;
}

export function renderJsonl(rows: readonly EvidenceRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

// ── 資料夾名 ──────────────────────────────────────────────

/**
 * `20260908-023313Z` —— **帶 `Z`**。
 *
 * 一個沒有時區的時間戳在半年後看是一個猜謎，而這個資料夾名很可能
 * 是它裡面那份檔案唯一還看得出「什麼時候匯出的」的地方。
 */
export function packFolderName(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}
