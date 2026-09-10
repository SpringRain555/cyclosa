/**
 * **規模驗收用的合成資料** —— 5 萬資料節點／20 萬關聯（Stage 13）。
 *
 * `graph-fixture.ts` 是「小到看得完、四層與三段都齊全」的那一份，給人工驗收用。
 * 這一份的目的完全相反：**大到會壞**，用來量六項效能預算。
 *
 * ## 三個為了「量得準」而不是「產得快」的決定
 *
 * **一 · 索引與切段走的是產品那一支，不是這裡自己寫一份。**
 * `indexText` 與 `chunkText` 都是 import 進來的。ADR-0026 已經為切段付過這個學費：
 * 量測與出貨各有一份實作的話，**量出來的數字不再描述出貨的那個東西，
 * 而且不會有任何地方報錯**。
 *
 * **二 · 分布是偏的，不是平均的。** 平均分布的圖每個節點度數都是 8，
 * 而真實語料裡有樞紐 —— 一個被幾百份文件提到的實體，它的 2 跳鄰域大得多。
 * **只量平均的那個節點等於只量最好走的那條路。**
 * 所以端點抽樣用 Zipf，量測時焦點也要挑高度數的那幾個（見 `measure-scale.ts`）。
 *
 * **三 · 亂數是有種子的。** 「沒有量測條件的數字不算數」（roadmap）——
 * 而語料本身就是量測條件的一部分。同一個 `--seed` 產生同一份語料，
 * 所以下一個人重跑得到的是可以比較的數字，不是另一份語料上的另一個數字。
 *
 * ## 這份資料**不能**拿來看檢索品質
 *
 * 詞是從字池裡抽出來組的，**沒有語意**；向量是亂數。
 * 它量得到的是「掃 N 條向量要多久」，量不到「找得準不準」——
 * 後者要真的模型跑真的語料，那是 `docs/research/embedding-choice.md` 那一輪的事。
 *
 * ⚠️ 開發工具。**產品程式碼不 import 它**，一鍵啟動也碰不到。
 */
import type { DatabaseSync } from 'node:sqlite';

import { chunkText } from '../../src/domain/search/chunk.js';
import { normalized } from '../../src/domain/search/similarity.js';
import { indexText } from '../../src/infrastructure/index/writer.js';
import { writeDerived } from '../../src/infrastructure/fs/case-files.js';

// ── 亂數 ────────────────────────────────────────────────────
//
// mulberry32。**要的是可重現，不是密碼學強度。**

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zipf 抽樣：第 r 名的機率正比於 `1 / r^exponent`。回傳累積分布。 */
export function zipfCdf(n: number, exponent: number): Float64Array {
  const cdf = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    total += 1 / Math.pow(i + 1, exponent);
    cdf[i] = total;
  }
  for (let i = 0; i < n; i += 1) cdf[i] = (cdf[i] as number) / total;
  return cdf;
}

export function pickZipf(cdf: Float64Array, r: () => number): number {
  const x = r();
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cdf[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ── 語料 ────────────────────────────────────────────────────

/**
 * 字池。常用繁體字，**只用來組詞**，組出來的詞沒有意義。
 *
 * 用字池而不是真的詞表，是因為真的詞表要嘛太小（bigram 的貼文串短得不真實），
 * 要嘛得從外部抓一份進 repo（授權與體積都是問題）。
 */
const CHAR_POOL =
  '一二三四五六七八九十百千萬億人大小上下中內外前後左右東西南北天地日月年時分秒' +
  '國家政治經濟社會文化教育科學技術資訊網路系統資料程式設計開發研究分析報告調查' +
  '公司企業產業市場價格成本利潤投資股票金融銀行保險基金貿易出口進口關稅法律規定' +
  '條例合約權利義務責任違反處罰訴訟法院判決證據證人律師檢察官警察局部門機關委員' +
  '新聞媒體記者採訪報導評論輿論公開透明隱私安全風險危機管理控制監督審查稽核紀錄' +
  '學校大學教授學生課程學習考試成績論文期刊出版書籍圖書館知識理論方法實驗結果' +
  '醫院醫師病人治療診斷藥物手術護理健康疾病預防疫苗流行傳染檢測隔離康復死亡' +
  '交通運輸鐵路公路航空港口車輛駕駛乘客票價路線班次誤點事故傷亡救援消防警報' +
  '環境污染空氣水質土壤廢棄回收再生能源電力太陽風力核能碳排放溫室氣候變遷' +
  '農業漁業林業礦業製造加工品質檢驗標準認證供應鏈物流倉儲配送零售批發消費' +
  '人口城市鄉村住宅房屋租金土地建設工程施工建築師結構材料水泥鋼筋估價仲介' +
  '軍事國防武器演習衝突和平談判協議條約邊界領土主權外交使館簽證移民難民' +
  '運動比賽選手教練球隊冠軍訓練場館觀眾轉播贊助獎金退休傷勢復出裁判規則' +
  '藝術音樂電影戲劇展覽博物館收藏創作導演演員劇本票房獎項節慶傳統儀式';

/** 詞表。**Zipf 抽樣的第 1 名最常出現，最後一名幾乎不出現。** */
export function buildVocab(size: number, seed: number): readonly string[] {
  const r = rng(seed);
  const chars = [...CHAR_POOL];
  const seen = new Set<string>();
  const out: string[] = [];
  while (out.length < size) {
    const len = r() < 0.82 ? 2 : 3;
    let w = '';
    for (let i = 0; i < len; i += 1) w += chars[Math.floor(r() * chars.length)] as string;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

const PUNCT = ['，', '，', '，', '。', '。', '；', '、'];

/**
 * 一份文件的正文。
 *
 * **分段是真的分段**（空行）—— 切段器是段落級的（ADR-0026），
 * 一整塊沒有換行的文字會走到它的退路而不是它的正路，
 * 那樣量到的「每份幾段」是錯的。
 */
export function makeText(
  vocab: readonly string[],
  cdf: Float64Array,
  topic: readonly string[],
  chars: number,
  r: () => number,
): string {
  const paras: string[] = [];
  let produced = 0;
  while (produced < chars) {
    const sentences: string[] = [];
    const n = 3 + Math.floor(r() * 6);
    for (let s = 0; s < n; s += 1) {
      let sentence = '';
      const words = 4 + Math.floor(r() * 8);
      for (let w = 0; w < words; w += 1) {
        // 主題詞佔三成 —— 沒有它的話每份文件的詞都來自同一個全域分布，
        // 而那表示**任何一個查詢詞的貼文串都是全體的固定比例**，不真實。
        const word =
          r() < 0.3
            ? (topic[Math.floor(r() * topic.length)] as string)
            : (vocab[pickZipf(cdf, r)] as string);
        sentence += word;
        if (r() < 0.22) sentence += PUNCT[Math.floor(r() * PUNCT.length)] as string;
      }
      sentences.push(sentence + '。');
    }
    const para = sentences.join('');
    paras.push(para);
    produced += para.length;
  }
  return paras.join('\n\n');
}

/** 正文長度。**對數常態** —— 大多數是一般長度的文章，尾巴上有幾份很長的。 */
export function textLength(r: () => number): number {
  const u = Math.max(1e-9, r());
  const v = Math.max(1e-9, r());
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(24_000, Math.max(180, Math.round(Math.exp(6.9 + 0.75 * z))));
}

// ── 寫入 ────────────────────────────────────────────────────

export interface ScaleSpec {
  readonly items: number;
  readonly entities: number;
  readonly edges: number;
  readonly seed: number;
  readonly vocabSize: number;
  /** 每份文件最多幾段向量。`0` ＝ 不寫向量。 */
  readonly maxChunks: number;
  readonly embedModel: string;
  readonly embedDim: number;
}

export interface ScaleStats {
  readonly items: number;
  readonly entities: number;
  readonly edges: number;
  readonly evidence: number;
  readonly bigramRows: number;
  readonly ftsRows: number;
  readonly vectors: number;
  readonly totalChars: number;
  readonly elapsedMs: Readonly<Record<string, number>>;
}

const ITEM_KINDS = ['web', 'web', 'web', 'pdf', 'text', 'paper'] as const;
const ENTITY_TYPES = ['person', 'org', 'place', 'event', 'work', 'concept'] as const;
const NAMED_RELS = ['收購', '任職於', '出資', '控告', '引用', '反駁', '合作', '監管'] as const;

/**
 * 寫進去。**每一段結束時 print 一行進度** ——
 * 這支要跑好幾分鐘，沒有進度的話分不出「在跑」與「卡住」。
 */
export async function writeScaleFixture(
  db: DatabaseSync,
  caseFolder: string,
  spec: ScaleSpec,
  log: (line: string) => void,
): Promise<ScaleStats> {
  const r = rng(spec.seed);
  const vocab = buildVocab(spec.vocabSize, spec.seed ^ 0x5bf03635);
  const cdf = zipfCdf(vocab.length, 0.9);
  const now = Date.now();
  const elapsed: Record<string, number> = {};

  // 主題：每份文件屬於一個，同主題的文件共用一小組詞。
  const TOPICS = 240;
  const topics: string[][] = [];
  for (let t = 0; t < TOPICS; t += 1) {
    const words: string[] = [];
    for (let i = 0; i < 10; i += 1) words.push(vocab[pickZipf(cdf, r)] as string);
    topics.push(words);
  }

  // ── 實體 ──────────────────────────────────────────────
  let t0 = Date.now();
  db.exec('BEGIN');
  const insEntity = db.prepare(
    'INSERT INTO entity (id, type, name_zh, title_rank, aliases_json, created_at, updated_at)' +
      " VALUES (?, ?, ?, '', '[]', ?, ?)",
  );
  for (let i = 0; i < spec.entities; i += 1) {
    const name = '合成' + (vocab[pickZipf(cdf, r)] as string) + String(i).padStart(5, '0');
    insEntity.run('ent-' + i, ENTITY_TYPES[i % ENTITY_TYPES.length] as string, name, now, now);
  }
  db.exec('COMMIT');
  elapsed['entities'] = Date.now() - t0;
  log('實體 ' + spec.entities + ' 個（' + elapsed['entities'] + ' ms）');

  // ── 資料節點 ＋ derived ＋ 索引 ＋ 向量 ────────────────
  //
  // 四件事在同一個迴圈裡，因為正文只產生一次 ——
  // 它是這支最貴的東西（總共幾千萬個字）。
  t0 = Date.now();
  const insItem = db.prepare(
    'INSERT INTO item (id, kind, title, title_rank, source_url, lang, sha256, fetched_at,' +
      ' status, low_confidence, excerpt, extractor_version, created_at, updated_at)' +
      " VALUES (?, ?, ?, ?, ?, 'zh', ?, ?, 'included', ?, ?, 1, ?, ?)",
  );
  const insVector = db.prepare(
    'INSERT INTO vector (id, owner_kind, owner_id, model, dim, embedding, created_at)' +
      " VALUES (?, 'item', ?, ?, ?, ?, ?)",
  );

  let bigramRows = 0;
  let ftsRows = 0;
  let vectors = 0;
  let totalChars = 0;
  const BATCH = 500;

  for (let start = 0; start < spec.items; start += BATCH) {
    const end = Math.min(start + BATCH, spec.items);
    // derived 是檔案 I/O，**在交易外面做** —— 一個開著的寫入交易不該等磁碟。
    const pending: { id: string; kind: string; title: string; text: string; excerpt: string }[] =
      [];

    for (let i = start; i < end; i += 1) {
      const topic = topics[i % TOPICS] as string[];
      const kind = ITEM_KINDS[Math.floor(r() * ITEM_KINDS.length)] as string;
      const title = '合成' + (topic[0] as string) + (topic[1] as string) + '的一份紀錄 ' + i;
      const text = makeText(vocab, cdf, topic, textLength(r), r);
      pending.push({ id: 'itm-' + i, kind, title, text, excerpt: text.slice(0, 180) });
      totalChars += text.length;
    }

    await Promise.all(
      pending.map((p) =>
        writeDerived(caseFolder, p.id, {
          extractorVersion: 1,
          kind: (p.kind === 'paper' ? 'web' : p.kind) as 'web' | 'pdf' | 'image' | 'text',
          title: p.title,
          text: p.text,
          html: null,
          pages: null,
          excerpt: p.excerpt,
          lowConfidence: false,
          reasons: [],
        }),
      ),
    );

    db.exec('BEGIN');
    for (const p of pending) {
      const idx = Number(p.id.slice(4));
      insItem.run(
        p.id,
        p.kind,
        p.title,
        p.title,
        'https://example.invalid/synthetic/' + idx,
        ('synthetic' + idx.toString(16).padStart(55, '0')).slice(0, 64),
        now - idx * 1000,
        idx % 17 === 0 ? 1 : 0,
        p.excerpt,
        now,
        now,
      );
      const written = indexText(db, {
        ownerKind: 'item',
        ownerId: p.id,
        lang: 'zh',
        title: p.title,
        text: p.text,
      });
      bigramRows += written.bigramRows;
      ftsRows += written.ftsRows;

      if (spec.maxChunks > 0) {
        for (const c of chunkText(p.title + '\n' + p.text, spec.maxChunks)) {
          const v = new Float32Array(spec.embedDim);
          for (let d = 0; d < spec.embedDim; d += 1) v[d] = r() * 2 - 1;
          const unit = normalized(v);
          insVector.run(
            p.id + '#' + c.ord,
            p.id,
            spec.embedModel,
            spec.embedDim,
            Buffer.from(unit.buffer, unit.byteOffset, unit.byteLength),
            now,
          );
          vectors += 1;
        }
      }
    }
    db.exec('COMMIT');

    if (end % 5000 === 0 || end === spec.items) {
      log(
        '資料節點 ' +
          end +
          '/' +
          spec.items +
          '　bigram ' +
          bigramRows +
          ' 列　向量 ' +
          vectors +
          ' 條　（' +
          Math.round((Date.now() - t0) / 1000) +
          ' s）',
      );
    }
  }
  elapsed['items'] = Date.now() - t0;

  // ── 關聯 ──────────────────────────────────────────────
  //
  // 端點用 Zipf 抽 —— **平均分布的圖沒有樞紐，而樞紐才是會爆的那個**。
  t0 = Date.now();
  const itemCdf = zipfCdf(spec.items, 0.65);
  const entCdf = zipfCdf(spec.entities, 0.75);

  const comention = Math.round(spec.edges * 0.6);
  const named = Math.round(spec.edges * 0.15);
  const similarity = Math.round(spec.edges * 0.15);
  const derived = spec.edges - comention - named - similarity;

  const insEdge = db.prepare(
    'INSERT OR IGNORE INTO edge' +
      ' (id, layer, rel, source_id, source_kind, target_id, target_kind,' +
      '  origin, status, confidence, run_id, created_at, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
  );
  const insEvidence = db.prepare(
    'INSERT INTO edge_evidence (id, edge_id, item_id, quote, char_start, char_end, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insAudit = db.prepare(
    'INSERT INTO edge_audit (id, edge_id, from_status, to_status, action, actor, run_id, at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
  );
  const setStatus = db.prepare('UPDATE edge SET status = ? WHERE id = ?');

  let edgeNo = 0;
  let evidence = 0;

  // 提及。**投影三段靠它** —— Zipf 讓少數實體被幾百份提到、多數只被 1–2 份提到。
  db.exec('BEGIN');
  for (let i = 0; i < comention; i += 1) {
    insEdge.run(
      'edg-' + edgeNo++,
      'comention',
      '提到',
      'itm-' + pickZipf(itemCdf, r),
      'item',
      'ent-' + pickZipf(entCdf, r),
      'entity',
      'machine',
      'pending',
      0.3,
      now,
      now,
    );
  }
  db.exec('COMMIT');
  log('提及 ' + comention + ' 條');

  db.exec('BEGIN');
  for (let i = 0; i < similarity; i += 1) {
    const a = pickZipf(itemCdf, r);
    let b = pickZipf(itemCdf, r);
    if (a === b) b = (b + 1) % spec.items;
    insEdge.run(
      'edg-' + edgeNo++,
      'similarity',
      '相似',
      'itm-' + a,
      'item',
      'itm-' + b,
      'item',
      'machine',
      'pending',
      0.4 + r() * 0.5,
      now,
      now,
    );
  }
  for (let i = 0; i < derived; i += 1) {
    const a = pickZipf(itemCdf, r);
    let b = pickZipf(itemCdf, r);
    if (a === b) b = (b + 1) % spec.items;
    insEdge.run(
      'edg-' + edgeNo++,
      'derived',
      r() < 0.6 ? '轉載' : '翻譯',
      'itm-' + a,
      'item',
      'itm-' + b,
      'item',
      'machine',
      'pending',
      0.9,
      now,
      now,
    );
  }
  db.exec('COMMIT');
  log('相似度 ' + similarity + ' ＋ 衍生 ' + derived + ' 條');

  // 具名關係。**三種狀態都要有** —— 待查證的佇列、已確認的（要出處）、
  // 已否決的墓碑。只產生待查證的話，裁決佇列與墓碑查詢都量不到。
  db.exec('BEGIN');
  for (let i = 0; i < named; i += 1) {
    const a = pickZipf(itemCdf, r);
    let b = pickZipf(itemCdf, r);
    if (a === b) b = (b + 1) % spec.items;
    const id = 'edg-' + edgeNo++;
    const roll = r();
    // 已確認的邊要先有出處才過得了 trigger，所以先插 pending、補出處、再改狀態。
    const status = roll < 0.34 ? 'confirmed' : roll < 0.55 ? 'rejected' : 'pending';
    insEdge.run(
      id,
      'named',
      NAMED_RELS[Math.floor(r() * NAMED_RELS.length)] as string,
      'itm-' + a,
      'item',
      'itm-' + b,
      'item',
      'machine',
      'pending',
      0.2 + r() * 0.6,
      now,
      now,
    );
    if (status === 'confirmed') {
      const n = 1 + Math.floor(r() * 4);
      for (let e = 0; e < n; e += 1) {
        insEvidence.run(
          'evd-' + i + '-' + e,
          id,
          'itm-' + pickZipf(itemCdf, r),
          '合成引文' + (vocab[pickZipf(cdf, r)] as string),
          0,
          12,
          now,
        );
        evidence += 1;
      }
    }
    if (status !== 'pending') {
      setStatus.run(status, id);
      insAudit.run(
        'aud-' + i,
        id,
        'pending',
        status,
        status === 'confirmed' ? 'confirm' : 'reject',
        'human',
        now,
      );
    }
  }
  db.exec('COMMIT');
  elapsed['edges'] = Date.now() - t0;
  log(
    '具名 ' +
      named +
      ' 條（出處 ' +
      evidence +
      ' 筆）　關聯總計 ' +
      edgeNo +
      ' 條（' +
      elapsed['edges'] +
      ' ms）',
  );

  const edges = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n ?? 0,
  );

  return {
    items: spec.items,
    entities: spec.entities,
    edges,
    evidence,
    bigramRows,
    ftsRows,
    vectors,
    totalChars,
    elapsedMs: elapsed,
  };
}
