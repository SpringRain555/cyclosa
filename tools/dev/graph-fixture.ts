/**
 * 合成的圖 —— **四層關聯 ＋ 投影三段各一個實例**。
 *
 * ## 為什麼需要這個
 *
 * v0.3.0 交付的是關聯圖，但 **v0.2.0 的匯入不產生任何關聯**
 * （關聯是 v0.4.0 與 v0.5.0 的事）。所以在真實資料上，
 * 這一階段的圖是一團沒有線的點 —— **四種畫法一種都驗不到**。
 *
 * 這一份補的就是那個洞：一個小到看得完、但四層與三段都齊全的圖，
 * 讓端對端測試與人工驗收各自跑得起來。
 *
 * ⚠️ **它寫的是合成資料，不是任何真實來源。**
 * 標題與實體名都看得出來是編的（`發布-…`、`合成`），
 * 這是 release-checklist A5 的要求：測試固定資料要看得出來是合成的。
 *
 * ⚠️ **只在測試與 `tools/dev/seed-graph.ts` 用。** 產品程式碼不 import 它。
 */
import type { DatabaseSync } from 'node:sqlite';

import { recomputeConfidence } from '../../src/infrastructure/db/repositories/edge-repo.js';

/**
 * 節點與關聯的形狀。
 *
 * ```
 *                    ┌─ 具名（已確認，出處 4 筆／2 個獨立來源）→ itm-target
 *   itm-focus ───────┼─ 具名（待查證，出處 1 筆）              → itm-claim
 *      │             ├─ 相似度（等寬點線）                     → itm-similar
 *      │             └─ 共同提及（實體 ent-hub 展開成空心節點）
 *      │
 *      └─ ent-pair（只被 2 份提到 → 攤平成一條線）─ itm-partner
 *
 *   ent-hub ── itm-mirror-a ══ 轉載 ══ itm-mirror-b ／ itm-mirror-c
 *              （這三份互為轉載，所以出處 3 筆只算 1 個獨立來源）
 * ```
 */
export const FIXTURE = {
  focus: 'itm-focus',
  /** 展開成空心節點（被 4 份提到 ≥ 3）*/
  hub: 'ent-hub',
  /** 攤平成一條線（被 2 份提到）*/
  pair: 'ent-pair',
  /** 純屬性，**根本不畫**（只被 1 份提到）*/
  lone: 'ent-lone',
} as const;

const ITEMS: readonly { id: string; kind: string; title: string }[] = [
  { id: 'itm-focus', kind: 'web', title: '合成起點：一則關於某次收購的報導' },
  { id: 'itm-target', kind: 'web', title: '合成：被收購的那一方的公告' },
  { id: 'itm-claim', kind: 'web', title: '合成：一則還沒查證的人事說法' },
  { id: 'itm-similar', kind: 'text', title: '合成：內容相近但沒有直接關係的一份' },
  { id: 'itm-partner', kind: 'pdf', title: '合成：跟起點共同提到同一個人的一份' },
  { id: 'itm-mirror-a', kind: 'web', title: '合成：原始通稿' },
  { id: 'itm-mirror-b', kind: 'web', title: '合成：通稿的轉載（甲媒體）' },
  { id: 'itm-mirror-c', kind: 'web', title: '合成：通稿的轉載（乙媒體）' },
  { id: 'itm-quiet', kind: 'text', title: '合成：只提到一個沒有別人提過的實體' },
  { id: 'itm-reference', kind: 'reference', title: '合成：只有書目的參考資料' },
];

const ENTITIES: readonly { id: string; type: string; name: string }[] = [
  { id: 'ent-hub', type: 'org', name: '合成公司（被四份提到）' },
  { id: 'ent-pair', type: 'person', name: '合成人物（被兩份提到）' },
  { id: 'ent-lone', type: 'place', name: '合成地點（只被一份提到）' },
];

/** 誰提到誰。**這些是二分邊，`layer='comention'`** —— 投影決定它們畫成什麼。 */
const MENTIONS: readonly [string, string][] = [
  ['itm-focus', 'ent-hub'],
  ['itm-mirror-a', 'ent-hub'],
  ['itm-mirror-b', 'ent-hub'],
  ['itm-mirror-c', 'ent-hub'],
  ['itm-focus', 'ent-pair'],
  ['itm-partner', 'ent-pair'],
  ['itm-quiet', 'ent-lone'],
];

interface EdgeSpec {
  readonly id: string;
  readonly layer: 'derived' | 'named' | 'comention' | 'similarity';
  readonly rel: string;
  readonly source: string;
  readonly sourceKind: 'item' | 'entity';
  readonly target: string;
  readonly targetKind: 'item' | 'entity';
  /**
   * **具名關係不用這一欄** —— 它們的可信度是寫完出處之後
   * 用 `recomputeConfidence` 從出處數出來的（見這個檔案結尾）。
   * 這裡填的只是 INSERT 當下的佔位值。
   *
   * 理由：手寫一個「4 筆出處、2 個獨立來源、可信度 0.85」的合成邊，
   * **描述的是一個真實路徑產生不出來的狀態** ——
   * 而這份資料存在的全部理由就是拿來當真實資料看。
   */
  readonly confidence: number;
  /** 出處出自哪幾份。**空的就留在待查證** */
  readonly evidenceFrom: readonly string[];
}

const EDGES: readonly EdgeSpec[] = [
  {
    id: 'edg-acquire',
    layer: 'named',
    rel: '收購',
    source: 'itm-focus',
    sourceKind: 'item',
    target: 'itm-target',
    targetKind: 'item',
    confidence: 0,
    // 三份互為轉載（算 1 個）＋ 兩份獨立 → **出處 5 筆，獨立來源 3 個**
    // 三個獨立來源正好是「強」的門檻（`scoreFor` 的階梯）。
    evidenceFrom: ['itm-mirror-a', 'itm-mirror-b', 'itm-mirror-c', 'itm-partner', 'itm-target'],
  },
  {
    id: 'edg-employ',
    layer: 'named',
    rel: '任職於',
    source: 'itm-focus',
    sourceKind: 'item',
    target: 'itm-claim',
    targetKind: 'item',
    confidence: 0,
    // 沒有出處 → 連「有直接引文」都不成立，所以是弱
    evidenceFrom: [],
  },
  {
    id: 'edg-similar',
    layer: 'similarity',
    rel: 'similar',
    source: 'itm-focus',
    sourceKind: 'item',
    target: 'itm-similar',
    targetKind: 'item',
    confidence: 0.55,
    evidenceFrom: [],
  },
  {
    id: 'edg-mirror-b',
    layer: 'derived',
    rel: '轉載',
    source: 'itm-mirror-a',
    sourceKind: 'item',
    target: 'itm-mirror-b',
    targetKind: 'item',
    confidence: 0.99,
    evidenceFrom: [],
  },
  {
    id: 'edg-mirror-c',
    layer: 'derived',
    rel: '轉載',
    source: 'itm-mirror-a',
    sourceKind: 'item',
    target: 'itm-mirror-c',
    targetKind: 'item',
    confidence: 0.99,
    evidenceFrom: [],
  },
];

/**
 * 把合成的圖寫進一個已經開好的專題資料庫。
 *
 * **`named` 的邊一律先寫成 `pending`，補完出處才 UPDATE 成 `confirmed`。**
 * 那不是為了好看 —— `trg_edge_confirm_requires_evidence_ins` 對
 * 「機器 ＋ 已確認」的 INSERT **無條件擋下**，因為出處在邊還不存在的時候寫不進去。
 * 所以這個順序就是真實寫入路徑唯一走得通的順序。
 */
export function writeSyntheticGraph(db: DatabaseSync, now = Date.now()): void {
  const insertItem = db.prepare(
    `INSERT INTO item (id, kind, title, title_rank, lang, status, excerpt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'zh', 'included', ?, ?, ?)`,
  );
  ITEMS.forEach((item, i) => {
    insertItem.run(
      item.id,
      item.kind,
      item.title,
      String(i).padStart(8, '0'),
      item.kind === 'reference' ? '' : `這是合成資料，用來驗證關聯圖的四種畫法。（${item.id}）`,
      now + i,
      now + i,
    );
  });

  db.prepare('UPDATE item SET source_url = ? WHERE id = ?').run(
    'https://example.invalid/reference',
    'itm-reference',
  );

  const insertEntity = db.prepare(
    `INSERT INTO entity (id, type, name_zh, title_rank, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  ENTITIES.forEach((entity, i) => {
    insertEntity.run(entity.id, entity.type, entity.name, entity.name, now + i, now + i);
  });

  const insertEdge = db.prepare(
    `INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind,
                       origin, status, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'machine', 'pending', ?, ?, ?)`,
  );

  MENTIONS.forEach(([itemId, entityId], i) => {
    insertEdge.run(
      `edg-mention-${i}`,
      'comention',
      '提到',
      itemId,
      'item',
      entityId,
      'entity',
      0.9,
      now + i,
      now + i,
    );
  });

  const insertEvidence = db.prepare(
    `INSERT INTO edge_evidence (id, edge_id, item_id, quote, char_start, char_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const confirm = db.prepare("UPDATE edge SET status = 'confirmed', updated_at = ? WHERE id = ?");

  for (const spec of EDGES) {
    insertEdge.run(
      spec.id,
      spec.layer,
      spec.rel,
      spec.source,
      spec.sourceKind,
      spec.target,
      spec.targetKind,
      spec.confidence,
      now,
      now,
    );
    spec.evidenceFrom.forEach((itemId, i) => {
      insertEvidence.run(
        `evd-${spec.id}-${i}`,
        spec.id,
        itemId,
        `這是一段合成的引文，用來驗證出處與獨立來源數。（${spec.rel}）`,
        0,
        30,
        now,
      );
    });
    // 有出處的具名關係才升成已確認 —— 沒有出處的那一條留在待查證，
    // **圖上要看得到一條琥珀虛線**，那是這個工具真正在等人做的事
    if (spec.evidenceFrom.length > 0) confirm.run(now, spec.id);
  }

  // 書目節點靠**人建、已確認**的「引用」連上來（Stage 22 的「被哪幾份引用」，不需要引文）——
  // 所以它不進裁決佇列。寫成機器的待查證邊的話，這份資料就多出一條真實路徑產生不出來的待裁決。
  db.prepare(
    `INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind,
                       origin, status, confidence, created_at, updated_at)
     VALUES ('edg-reference', 'named', '引用', 'itm-focus', 'item', 'itm-reference', 'item',
             'human', 'confirmed', 0, ?, ?)`,
  ).run(now, now);

  // **具名關係的可信度走跟真實路徑一模一樣的那一支。**
  //
  // 手寫一個數字比較快，而且看起來一樣 —— 但那樣的合成資料會呈現
  // 一個真實寫入路徑產生不出來的狀態（例如「2 個獨立來源 ＋ 可信度 0.85」），
  // 而這份資料存在的全部理由就是拿來當真實資料看。
  // 這一步要放在最後：轉載邊（`derived`）要先在，獨立來源才數得對。
  for (const spec of EDGES) {
    recomputeConfidence(db, spec.id, spec.layer, now);
  }
}
