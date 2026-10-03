/**
 * 研究各狀態的合成資料（B4，v0.26.0）—— 給 D10 截研究的中間狀態用。
 *
 * 研究的畫面依狀態換（規劃、蒐集、等你、確認、建圖、完成），而真的走一次要花錢、要好幾分鐘，
 * 中間狀態又一閃即過。這裡把**一條遞進的故事**寫進一個空專題，停在要截的那一步：
 *
 * | 狀態 | 畫面上看得到 |
 * |---|---|
 * | `planning` | 對話兩輪、目前的規劃（四條方向，其中一條是人提的）、刻意不查的範圍 |
 * | `collecting` | 兩條方向搜完、兩份抓到；**蒐集作業停在半路**（程式重開時掃成「停在半路」，給「繼續蒐集」）|
 * | `awaiting-user` | 八份候選：抓到並初讀過（有關／沒關／說不準）、要你拿、拿不到（付費牆）、你上傳的 |
 * | `reviewing` | 同上，加兩列人改過的決定、一列書目引用、缺口評估的意見 |
 * | `building` | 建圖作業停在半路：第一份抽完、其餘還沒（給「繼續建圖」）|
 * | `done` | 抽完的關聯（待查證）、書目節點與人建的引用、丟掉的那一份排除 |
 * | `abandoned` | 規劃到一半放棄 |
 *
 * **寫入走真的路**：資料節點走 `ingestBytes`（快照、正文、索引都有，閱讀器打得開），
 * 抽取走 `applyExtraction`（引文取自那一份自己的正文，對得回原文）。沒有呼叫任何模型。
 * 標題、主題、方向都以「合成」開頭，看得出來是編的。
 *
 * ⚠️ 這是開發工具。**產品程式碼不 import 它**。
 */
import type { DatabaseSync } from 'node:sqlite';

import { applyExtraction } from '../../src/application/extraction-service.js';
import { ingestBytes } from '../../src/application/ingest-service.js';
import { normalizeExtraction } from '../../src/domain/provider/index.js';
import { effectiveDecision } from '../../src/domain/research/index.js';
import * as edges from '../../src/infrastructure/db/repositories/edge-repo.js';
import * as items from '../../src/infrastructure/db/repositories/item-repo.js';
import * as research from '../../src/infrastructure/db/repositories/research-repo.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import { readDerived } from '../../src/infrastructure/fs/case-files.js';
import { indexText, reindexTitleRank } from '../../src/infrastructure/index/writer.js';
import { newId } from '../../src/shared/id.js';

export const SEED_STATES = [
  'planning',
  'collecting',
  'awaiting-user',
  'reviewing',
  'building',
  'done',
  'abandoned',
] as const;
export type SeedState = (typeof SEED_STATES)[number];

const TOPIC = '合成研究：深度學習的正則化方法';
const MODEL = '合成模型';

interface DirectionSeed {
  readonly key: string;
  readonly title: string;
  readonly what: string;
  readonly expect: string;
  readonly keywords: readonly string[];
  readonly origin: 'model' | 'human';
}

const DIRECTIONS: readonly DirectionSeed[] = [
  {
    key: 'penalty',
    title: '合成方向：參數範數懲罰',
    what: 'L1、L2 與權重衰減怎麼限制模型容量',
    expect: '教科書章節與綜述',
    keywords: ['L2 regularization', 'weight decay'],
    origin: 'model',
  },
  {
    key: 'augment',
    title: '合成方向：資料增強',
    what: '用不改變標籤的變換擴大訓練資料',
    expect: '論文',
    keywords: ['data augmentation'],
    origin: 'model',
  },
  {
    key: 'stop',
    title: '合成方向：提早停止',
    what: '用驗證集的誤差決定什麼時候停止訓練',
    expect: '教科書章節',
    keywords: ['early stopping'],
    origin: 'model',
  },
  {
    key: 'dropout',
    title: '合成方向：dropout 與集成',
    what: 'dropout 作為大量子網路集成的近似',
    expect: '原始論文與後續分析',
    keywords: ['dropout', 'bagging'],
    origin: 'human',
  },
];

type Final = 'fetched' | 'uploaded' | 'needs-user' | 'unavailable';

interface CandidateSeed {
  readonly key: string;
  readonly direction: string;
  readonly title: string;
  readonly why: string;
  readonly access: 'open' | 'login' | 'blocked' | 'unknown';
  readonly final: Final;
  /** 停在半路的那一次蒐集裡就已經抓到了。 */
  readonly early: boolean;
  readonly relevance?: 'yes' | 'no' | 'unsure';
  /** 確認階段人改的那一格（沒寫 ＝ 照預設）。 */
  readonly decision?: 'include' | 'reference' | 'discard';
  readonly citedBy?: readonly string[];
}

const CANDIDATES: readonly CandidateSeed[] = [
  {
    key: 'c1',
    direction: 'penalty',
    title: '合成來源：權重衰減與 L2 懲罰的等價',
    why: '直接比較兩種寫法',
    access: 'open',
    final: 'fetched',
    early: true,
    relevance: 'yes',
  },
  {
    key: 'c2',
    direction: 'penalty',
    title: '合成來源：L1 懲罰與稀疏表示',
    why: '補 L1 那一半',
    access: 'open',
    final: 'fetched',
    early: true,
    relevance: 'unsure',
    decision: 'reference',
  },
  {
    key: 'c3',
    direction: 'augment',
    title: '合成來源：影像資料增強的實驗比較',
    why: '列了常見變換的效果',
    access: 'open',
    final: 'fetched',
    early: false,
    relevance: 'no',
  },
  {
    key: 'c4',
    direction: 'augment',
    title: '合成來源：需要登入的期刊論文',
    why: '常被引用的原始提案',
    access: 'login',
    final: 'needs-user',
    early: false,
    citedBy: ['c1'],
  },
  {
    key: 'c5',
    direction: 'stop',
    title: '合成來源：付費牆後面的綜述',
    why: '提早停止的理論分析',
    access: 'unknown',
    final: 'unavailable',
    early: false,
  },
  {
    key: 'c6',
    direction: 'stop',
    title: '合成來源：提早停止作為隱式正則化',
    why: '把提早停止跟 L2 連起來',
    access: 'open',
    final: 'fetched',
    early: false,
    relevance: 'yes',
  },
  {
    key: 'c7',
    direction: 'dropout',
    title: '合成來源：你上傳的 dropout 筆記',
    why: '人工補上的那一份',
    access: 'login',
    final: 'uploaded',
    early: false,
    relevance: 'yes',
  },
  {
    key: 'c8',
    direction: 'dropout',
    title: '合成來源：dropout 與貝氏近似',
    why: '另一種解釋',
    access: 'open',
    final: 'fetched',
    early: false,
    relevance: 'no',
    decision: 'include',
  },
];

/** 建圖時的兩條關聯。引文是 `bodyOf` 裡一字不差的片段 —— `locateQuote` 找得到，才寫得進去。 */
const QUOTES = [
  {
    subject: '權重衰減',
    object: 'L2 懲罰',
    rel: '等價於',
    quote: 'Weight decay adds a penalty proportional to the squared norm of the parameters',
  },
  {
    subject: 'dropout',
    object: '集成',
    rel: '近似',
    quote: 'Dropout trains an ensemble of subnetworks formed by removing units',
  },
] as const;

function urlOf(key: string): string {
  return `https://synthetic.example/regularization/${key}`;
}

/** 一份合成正文。**要夠長**：抽取的引文取自這裡，至少要有兩段可以對回原文的句子。 */
function bodyOf(seed: CandidateSeed): string {
  return [
    `# ${seed.title}`,
    '',
    '這是一份合成的測試資料，內容是編的，只用來把研究的畫面撐起來。',
    `正則化的目的是降低泛化誤差而不只是訓練誤差，${seed.why}。`,
    'Weight decay adds a penalty proportional to the squared norm of the parameters to the training objective.',
    '提早停止在驗證集的誤差開始上升時停下訓練，效果類似把參數限制在初始值附近的一個範圍內。',
    'Dropout trains an ensemble of subnetworks formed by removing units from an underlying base network.',
    '資料增強用不改變標籤的變換產生更多訓練樣本，在影像辨識上特別有效。',
  ].join('\n');
}

export interface SeedSummary {
  readonly researchId: string;
  readonly state: SeedState;
  readonly candidates: number;
  readonly items: number;
  readonly edges: number;
}

/**
 * 把研究寫到 `state` 那一步。**呼叫端負責「這是一個空專題」**（`seed-research.ts` 會檢查）。
 */
export async function writeResearchState(
  db: DatabaseSync,
  folder: string,
  state: SeedState,
): Promise<SeedSummary> {
  const now = Date.now();
  const researchId = newId();
  research.insertResearch(db, {
    id: researchId,
    kind: 'research',
    topic: TOPIC,
    hitsJson: '[]',
    correlationId: 'synthetic',
    now,
  });
  writePlanning(db, researchId, now);
  const summary = (candidates: number, written: number): Promise<SeedSummary> =>
    Promise.resolve({
      researchId,
      state,
      candidates,
      items: Number((db.prepare('SELECT COUNT(*) AS n FROM item').get() as { n: number }).n),
      edges: written,
    });
  if (state === 'planning') return summary(0, 0);
  if (state === 'abandoned') {
    research.updateResearchStatus(db, researchId, 'abandoned', now);
    return summary(0, 0);
  }

  // ── 閘門一：方向落成表，開蒐集作業 ──────────────────────
  const directionIdOf = new Map<string, string>();
  for (const [ord, d] of DIRECTIONS.entries()) {
    const id = newId();
    directionIdOf.set(d.key, id);
    research.insertDirection(db, {
      id,
      researchId,
      ord,
      title: d.title,
      what: d.what,
      expect: d.expect,
      keywords: d.keywords,
      origin: d.origin,
      adopted: true,
      now,
    });
  }
  const collectRunId = newId();
  runs.insertRun(db, {
    id: collectRunId,
    kind: 'research',
    label: TOPIC,
    total: DIRECTIONS.length,
    correlationId: 'synthetic',
    now,
    researchId,
    topic: TOPIC,
    providers: JSON.stringify({ agent: MODEL, digest: MODEL }),
  });
  research.setCollectRun(db, researchId, collectRunId, now);
  research.updateResearchStatus(db, researchId, 'collecting', now);
  runs.startRun(db, collectRunId, now);

  const partial = state === 'collecting';
  const searched = partial ? ['penalty', 'augment'] : DIRECTIONS.map((d) => d.key);
  for (const key of searched) {
    research.markDirectionSearched(db, {
      id: directionIdOf.get(key)!,
      state: 'done',
      code: null,
      now,
    });
  }

  const candidateIdOf = new Map<string, string>();
  const itemIdOf = new Map<string, string>();
  let uploadRunId: string | null = null;
  for (const seed of CANDIDATES.filter((c) => searched.includes(c.direction))) {
    const id = newId();
    candidateIdOf.set(seed.key, id);
    research.addCandidate(db, {
      id,
      researchId,
      directionId: directionIdOf.get(seed.direction)!,
      url: urlOf(seed.key),
      title: seed.title,
      why: seed.why,
      bib: { authors: '合成作者', year: '2026', venue: '合成期刊' },
      expectedAccess: seed.access,
      acquisition: 'found',
      now,
    });
    if (partial && !seed.early) continue;

    if (seed.final === 'needs-user') {
      research.setAcquisition(db, {
        id,
        acquisition: 'needs-user',
        code: 'FETCH_LOGIN_REQUIRED',
        now,
      });
      continue;
    }
    if (seed.final === 'unavailable') {
      research.markUnavailable(db, { id, reason: 'paywall', note: '', now });
      continue;
    }
    // 抓到的走蒐集作業；上傳的走它自己那一筆匯入（真的流程也是兩筆）。
    if (seed.final === 'uploaded' && uploadRunId === null) {
      uploadRunId = newId();
      runs.insertRun(db, {
        id: uploadRunId,
        kind: 'import',
        label: '合成上傳 · 1 個檔案',
        total: 1,
        correlationId: 'synthetic',
        now,
      });
      runs.startRun(db, uploadRunId, now);
    }
    const runId = seed.final === 'uploaded' ? uploadRunId! : collectRunId;
    const runItemId = newId();
    const itemId = newId();
    runs.insertRunItem(db, {
      id: runItemId,
      runId,
      requested: urlOf(seed.key),
      host: 'synthetic.example',
    });
    items.insertPendingItem(db, {
      id: itemId,
      kind: 'text',
      requestedUrl: urlOf(seed.key),
      title: seed.title,
      runId,
      now,
    });
    const outcome = await ingestBytes(db, folder, {
      runItemId,
      itemId,
      requestedUrl: urlOf(seed.key),
      finalUrl: urlOf(seed.key),
      bytes: new TextEncoder().encode(bodyOf(seed)),
      contentType: null,
      fileName: `${seed.key}.md`,
      hops: [],
      providers: null,
    });
    if (outcome.itemId === null) throw new Error(`合成資料匯入失敗：${seed.key}`);
    itemIdOf.set(seed.key, outcome.itemId);
    research.setAcquisition(db, {
      id,
      acquisition: seed.final,
      code: null,
      itemId: outcome.itemId,
      now,
    });
    if (seed.relevance !== undefined) {
      research.setCandidateDigest(db, {
        id,
        relevance: seed.relevance,
        why: `合成初讀：${seed.why}`,
        code: null,
        now,
      });
      items.setItemDigest(db, {
        id: outcome.itemId,
        titleZh: seed.title,
        summaryZh: `合成摘要：${seed.why}。這一段是編的。`,
        digestedBy: MODEL,
        now,
      });
    }
  }
  if (uploadRunId !== null)
    runs.settleRunRow(db, { id: uploadRunId, status: 'done', succeeded: 1, failed: 0, now });
  reindexTitleRank(db);
  // 停在半路：作業留在「執行中」。程式下一次打開這個專題時 `run-sweep` 會把它掃成「停在半路」。
  if (partial) return summary(candidateIdOf.size, 0);

  runs.settleRunRow(db, {
    id: collectRunId,
    status: 'done',
    succeeded: DIRECTIONS.length,
    failed: 0,
    now,
  });
  research.updateResearchStatus(db, researchId, 'awaiting-user', now);
  if (state === 'awaiting-user') return summary(candidateIdOf.size, 0);

  // ── 閘門二：確認。兩列人改過、一列書目引用、缺口評估 ────────
  for (const seed of CANDIDATES) {
    const id = candidateIdOf.get(seed.key)!;
    if (seed.decision !== undefined) research.setCandidateDecision(db, id, seed.decision, now);
    if (seed.citedBy !== undefined)
      research.setCandidateCitedBy(
        db,
        id,
        seed.citedBy.map((key) => candidateIdOf.get(key)!),
        now,
      );
  }
  research.setGap(
    db,
    researchId,
    JSON.stringify({
      opinion:
        '合成意見：資料增強那一條的兩份都被初讀判成沒關或拿不到，這一條的證據偏少。\n\n提早停止只有一份有正文，另一份在付費牆後面。',
      model: MODEL,
      costUsd: null,
      at: now,
    }),
    now,
  );
  research.updateResearchStatus(db, researchId, 'reviewing', now);
  if (state === 'reviewing') return summary(candidateIdOf.size, 0);

  // ── 閘門三：建圖 ────────────────────────────────────────
  const buildRunId = newId();
  const rows = research.listCandidates(db, researchId);
  runs.insertRun(db, {
    id: buildRunId,
    kind: 'research',
    label: '建圖',
    total: rows.length,
    correlationId: 'synthetic',
    now,
    researchId,
    topic: TOPIC,
    providers: JSON.stringify({ extract: MODEL, json: { extract: 'schema' } }),
  });
  research.setBuildRun(db, researchId, buildRunId, now);
  research.updateResearchStatus(db, researchId, 'building', now);
  runs.startRun(db, buildRunId, now);

  let written = 0;
  // 停在半路的那一次只做完第一份。
  const todo = state === 'building' ? rows.slice(0, 1) : rows;
  for (const row of todo) {
    const runItemId = newId();
    runs.insertRunItem(db, { id: runItemId, runId: buildRunId, requested: row.url, host: null });
    const decision = effectiveDecision(row);
    const derived = row.itemId === null ? null : await readDerived(folder, row.itemId);
    const hasBody = derived !== null && derived.text.trim().length > 0;
    let newEdges = 0;
    let itemId = row.itemId;
    if (decision === 'include' && row.itemId !== null && derived !== null && hasBody) {
      // 引文用正文裡固定的那兩段英文：匯入時正文可能被重排成段落，按行切會對不上。
      const quotes = QUOTES.filter((entry) => derived.text.includes(entry.quote));
      const extraction = normalizeExtraction({
        entities: [
          { name: '權重衰減', type: 'concept' },
          { name: 'L2 懲罰', type: 'concept' },
          { name: 'dropout', type: 'concept' },
          { name: '集成', type: 'concept' },
        ],
        relations: quotes,
      });
      newEdges = applyExtraction(db, row.itemId, buildRunId, derived.text, extraction).newEdges;
      items.setItemExtracted(db, { id: row.itemId, extractedBy: MODEL, now });
    } else if (decision === 'discard' && row.itemId !== null) {
      items.setStatus(db, row.itemId, 'excluded', now);
    } else if (decision === 'reference' && !hasBody) {
      itemId = newId();
      items.insertReference(db, {
        id: itemId,
        title: row.title,
        url: row.url,
        runId: buildRunId,
        now,
        bibJson: JSON.stringify({
          ...row.bib,
          why: row.why,
          unavailableReason: row.unavailableReason,
        }),
      });
      research.setCandidateItem(db, row.id, itemId, now);
      indexText(db, {
        ownerKind: 'item',
        ownerId: itemId,
        lang: 'und',
        title: row.title,
        text: '',
      });
      for (const citingId of row.citedBy) {
        const source = research.getCandidate(db, citingId)?.itemId ?? null;
        if (source === null) continue;
        edges.insertEdge(
          db,
          {
            source,
            target: itemId,
            rel: '引用',
            layer: 'named',
            sourceKind: 'item',
            targetKind: 'item',
            origin: 'human',
            confidence: 1,
            runId: buildRunId,
          },
          now,
        );
        newEdges += 1;
      }
    }
    written += newEdges;
    research.setCandidateBuild(db, { id: row.id, state: 'done', code: null, now });
    runs.updateRunItem(db, { id: runItemId, outcome: 'ok', itemId, now });
    runs.setRunItemEdges(db, runItemId, newEdges);
  }
  reindexTitleRank(db);
  if (state === 'building') return summary(rows.length, written);

  runs.settleRunRow(db, { id: buildRunId, status: 'done', succeeded: rows.length, failed: 0, now });
  research.updateResearchStatus(db, researchId, 'done', now);
  return summary(rows.length, written);
}

function writePlanning(db: DatabaseSync, researchId: string, now: number): void {
  const plan = {
    relation: '合成：專題裡還沒有正則化的資料，這是一個新的方向。',
    directions: DIRECTIONS.map((d) => ({
      title: d.title,
      what: d.what,
      expect: d.expect,
      keywords: d.keywords,
      origin: d.origin,
    })),
    outOfScope: ['合成：不查硬體加速', '合成：不查 2015 年以前的綜述'],
    overflow: false,
  };
  research.insertMessage(db, {
    id: newId(),
    researchId,
    ord: research.nextOrd(db, researchId),
    role: 'user',
    content: '合成：我想知道深度學習的正則化有哪幾類方法、各自解決什麼問題。',
    now,
  });
  research.insertMessage(db, {
    id: newId(),
    researchId,
    ord: research.nextOrd(db, researchId),
    role: 'model',
    content:
      '合成回覆：先分成參數懲罰、資料增強、提早停止三條；dropout 你另外加了一條，我把它跟集成放在一起看。',
    planJson: JSON.stringify(plan),
    model: MODEL,
    via: 'ollama',
    costUsd: null,
    elapsedMs: 1200,
    code: null,
    now,
  });
  research.updateResearchPlan(db, researchId, JSON.stringify(plan), now);
}
