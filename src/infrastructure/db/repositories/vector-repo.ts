/**
 * 向量的讀寫。**`vector` 表從 migration 001 就在，而到 v0.11.0 才第一次有東西寫進去。**
 *
 * ## 存的是「已經單位化的 Float32」
 *
 * `embedding` 是一個 BLOB，內容是 `Float32Array` 的原始位元組。
 * 寫進去之前一定經過 `normalized()`（`embed-ollama` 那一支的出口就是），
 * 所以比對時的點積**就是**餘弦。
 *
 * **正規化放在寫入那一側**，因為它只做一次，而比對每次查詢要跑幾萬遍。
 * 代價是：一個繞過那條路徑寫進來的向量不會報錯，只會讓分數普遍偏移。
 * 所以寫入只有這一支函式，而它自己不做正規化 —— **它要求上游已經做過**，
 * 兩層都做等於沒有人負責。
 *
 * ## `model` 與 `dim` 是每一列都帶的，不是全域設定
 *
 * 換模型要把全部重算（ADR-0009 的硬約束），而重算不是瞬間的事 ——
 * 中間一定會有兩個模型的向量同時在表裡。**那不是壞狀態，是過程。**
 * 要擋的是「混著比」，所以每一次查詢都帶著 `(model, dim)` 過濾，
 * 而 `idx_vector_model` 就是為這件事建的。
 *
 * ## 位元組序
 *
 * `Float32Array` 的位元組序跟著平台走，而這個工具的資料根**明文承諾
 * 「整個複製走，在另一台機器上打得開」**（REQ-0001）。
 * 目前每一個支援的平台都是 little-endian（x64 與 ARM64 在實務上都是），
 * 所以直接存原始位元組。**這一條寫在這裡，是因為它是一個假設而不是一個事實** ——
 * 哪天要支援 big-endian，這裡是要改的地方。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { OwnerKind } from '../../index/writer.js';

type Raw = Record<string, unknown>;

export interface VectorRow {
  readonly id: string;
  readonly ownerKind: OwnerKind;
  readonly ownerId: string;
  readonly embedding: Float32Array;
}

export interface VectorInput {
  readonly id: string;
  readonly ownerKind: OwnerKind;
  readonly ownerId: string;
  /** **已經單位化過的。** 這一層不再做一次 —— 見檔頭 */
  readonly embedding: Float32Array;
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * BLOB → `Float32Array`。
 *
 * **要複製，不能直接掛在 `buffer` 上**：`node:sqlite` 回來的 `Uint8Array`
 * 的 `byteOffset` 不保證是 4 的倍數，而 `new Float32Array(buffer, offset)`
 * 在沒有對齊的時候會丟 `RangeError`。複製一份 5 萬次是 500 MB 的搬運，
 * 所以呼叫端要自己控制一次讀幾筆（`listVectors` 有 `limit`）。
 */
function fromBlob(blob: unknown): Float32Array | null {
  if (!(blob instanceof Uint8Array)) return null;
  if (blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/**
 * 替一個節點寫一批向量。**先刪再寫。**
 *
 * 理由跟 `indexText` 一樣：重新抽取會產生不同的正文，只新增的話
 * 舊的段落會留下來 —— 而使用者會在語意檢索裡命中一段已經不存在的文字，
 * 然後點過去發現正文裡沒有。**那比查不到更糟。**
 */
export function replaceVectors(
  db: DatabaseSync,
  input: {
    readonly ownerKind: OwnerKind;
    readonly ownerId: string;
    readonly model: string;
    readonly dim: number;
    readonly rows: readonly VectorInput[];
    readonly now: number;
  },
): number {
  db.prepare('DELETE FROM vector WHERE owner_kind = ? AND owner_id = ?').run(
    input.ownerKind,
    input.ownerId,
  );
  const insert = db.prepare(
    'INSERT INTO vector (id, owner_kind, owner_id, model, dim, embedding, created_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let written = 0;
  for (const row of input.rows) {
    // **維度對不上的不寫。** 混進去的話它會在比對時被 `dot` 回 0 分，
    // 而那看起來像「這一段就是不相關」——一個安靜的假答案。
    if (row.embedding.length !== input.dim) continue;
    insert.run(
      row.id,
      row.ownerKind,
      row.ownerId,
      input.model,
      input.dim,
      toBlob(row.embedding),
      input.now,
    );
    written++;
  }
  return written;
}

/** 一個節點的向量全部刪掉。**節點被刪或正文沒了的時候用。** */
export function dropVectorsFor(db: DatabaseSync, ownerKind: OwnerKind, ownerId: string): void {
  db.prepare('DELETE FROM vector WHERE owner_kind = ? AND owner_id = ?').run(ownerKind, ownerId);
}

/** 這個模型有幾條向量、涵蓋幾個節點。**畫面上要說得出「建到哪了」。** */
export function vectorStats(
  db: DatabaseSync,
  model: string,
): { readonly rows: number; readonly owners: number } {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS rows, COUNT(DISTINCT owner_kind || owner_id) AS owners' +
        ' FROM vector WHERE model = ?',
    )
    .get(model) as Raw | undefined;
  return { rows: Number(row?.['rows'] ?? 0), owners: Number(row?.['owners'] ?? 0) };
}

/**
 * 這個模型底下的全部向量。**一次讀 `limit` 筆，用 `cursor` 往前走。**
 *
 * 5 萬筆 × 2560 維 ＝ 500 MB，**一次全部進記憶體是不行的**。
 * 所以比對那一支（`index/vector-reader.ts`）是逐批讀、逐批比，
 * 而它一路只留「每份文件最像的那一段」—— **記憶體用量與資料量無關。**
 */
export function listVectors(
  db: DatabaseSync,
  input: {
    readonly model: string;
    readonly dim: number;
    readonly limit: number;
    readonly after?: string;
  },
): readonly VectorRow[] {
  const rows = db
    .prepare(
      'SELECT id, owner_kind, owner_id, embedding FROM vector' +
        ' WHERE model = ? AND dim = ? AND id > ? ORDER BY id LIMIT ?',
    )
    .all(input.model, input.dim, input.after ?? '', input.limit) as Raw[];
  const out: VectorRow[] = [];
  for (const row of rows) {
    const embedding = fromBlob(row['embedding']);
    // **壞掉的一列不會讓整次查詢失敗。** 它只是不參與比對 ——
    // 而 `vectorStats` 的數字仍然算得到它，所以「有幾條」與「比得動幾條」
    // 對不起來的時候看得出來。
    if (embedding === null) continue;
    out.push({
      id: String(row['id'] ?? ''),
      ownerKind: String(row['owner_kind'] ?? 'item') as OwnerKind,
      ownerId: String(row['owner_id'] ?? ''),
      embedding,
    });
  }
  return out;
}

/**
 * 還沒有這個模型的向量的 `item`。**回填要靠它。**
 *
 * 只回有正文的（`status` 不是 `pending`／`failed`）—— 沒有正文的節點
 * 嵌不出東西，而把它們算進「還差幾筆」會讓進度永遠到不了 100%。
 */
export function itemsMissingVectors(
  db: DatabaseSync,
  model: string,
  limit: number,
): readonly { readonly id: string; readonly lang: string; readonly kind: string }[] {
  const rows = db
    .prepare(
      'SELECT i.id AS id, i.lang AS lang, i.kind AS kind FROM item i' +
        " WHERE i.status IN ('included','excluded')" +
        ' AND NOT EXISTS (' +
        "   SELECT 1 FROM vector v WHERE v.owner_kind = 'item' AND v.owner_id = i.id" +
        '     AND v.model = ?' +
        ' ) ORDER BY i.created_at LIMIT ?',
    )
    .all(model, limit) as Raw[];
  return rows.map((r) => ({
    id: String(r['id'] ?? ''),
    lang: String(r['lang'] ?? 'und'),
    kind: String(r['kind'] ?? 'web'),
  }));
}

/** 還差幾筆。**跟 `itemsMissingVectors` 用同一個條件**，不然進度條會說謊。 */
export function countItemsMissingVectors(db: DatabaseSync, model: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM item i' +
        " WHERE i.status IN ('included','excluded')" +
        ' AND NOT EXISTS (' +
        "   SELECT 1 FROM vector v WHERE v.owner_kind = 'item' AND v.owner_id = i.id" +
        '     AND v.model = ?' +
        ' )',
    )
    .get(model) as Raw | undefined;
  return Number(row?.['n'] ?? 0);
}

/** 這個專題裡出現過哪些模型的向量。**換模型之後要說得出「舊的還在」。** */
export function vectorModels(db: DatabaseSync): readonly { model: string; rows: number }[] {
  const rows = db
    .prepare('SELECT model, COUNT(*) AS n FROM vector GROUP BY model ORDER BY n DESC')
    .all() as Raw[];
  return rows.map((r) => ({ model: String(r['model'] ?? ''), rows: Number(r['n'] ?? 0) }));
}
