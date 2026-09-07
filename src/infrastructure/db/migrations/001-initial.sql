-- Cyclosa schema v1
--
-- 欄位與值域的權威是 docs/architecture/data-model.md。**改這裡就要改那一份。**
--
-- 資料庫存英文識別字，UI 顯示中文；對映只有一處：web/src/i18n/zh-TW.ts。
-- 命名一律 snake_case，TS 端是 camelCase，**轉換只在 repository 層做一次**。

-- ── 專題本身 ──────────────────────────────────────────────
-- 一個專題一個 SQLite 檔，所以這張表在檔內只有一列。
CREATE TABLE "case" (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  seed          TEXT,
  status        TEXT NOT NULL CHECK (status IN ('new','collecting','ready','archived')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- 單列約束：只允許 id='self' 這一列。
  CHECK (id = 'self')
);

-- ── 資料節點 ──────────────────────────────────────────────
CREATE TABLE item (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('web','pdf','image','text','paper','note')),
  title         TEXT NOT NULL DEFAULT '',
  -- node:sqlite 沒有 createCollation，所以中文排序要自己維護這一欄，
  -- 內容變動後用 Intl.Collator('zh-Hant') 重排。
  title_rank    TEXT NOT NULL DEFAULT '',
  source_url    TEXT,
  -- 偵測不出來記 'und'，不猜。und 的內容兩條索引都建。
  lang          TEXT NOT NULL DEFAULT 'und',
  -- 對應 sources/ 底下不可變的快照。
  sha256        TEXT,
  fetched_at    INTEGER,
  status        TEXT NOT NULL
                CHECK (status IN ('pending','fetched','parsed','included','excluded','failed')),
  -- 抽取信心低的標記。第一版是布林（REQ-0003），不是 0-1 的分數。
  low_confidence INTEGER NOT NULL DEFAULT 0 CHECK (low_confidence IN (0,1)),
  -- 「已讀」是**正交旗標，不是狀態**。存時間戳而不是布林，因為「什麼時候讀的」之後有用。
  read_at       INTEGER,
  run_id        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_item_status     ON item(status);
CREATE INDEX idx_item_title_rank ON item(title_rank);
CREATE INDEX idx_item_lang       ON item(lang);
CREATE UNIQUE INDEX idx_item_sha256 ON item(sha256) WHERE sha256 IS NOT NULL;

-- ── 實體節點 ──────────────────────────────────────────────
CREATE TABLE entity (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL
                CHECK (type IN ('person','org','place','event','work','concept')),
  name_zh       TEXT NOT NULL,
  title_rank    TEXT NOT NULL DEFAULT '',
  -- [{name, lang, script}] —— 跨語言對齊靠它與選填的 QID，不自建對照表。
  aliases_json  TEXT NOT NULL DEFAULT '[]',
  wikidata_qid  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_entity_type ON entity(type);
CREATE INDEX idx_entity_qid  ON entity(wikidata_qid) WHERE wikidata_qid IS NOT NULL;

-- ── 關聯 ──────────────────────────────────────────────────
CREATE TABLE edge (
  id            TEXT PRIMARY KEY,
  -- 四層（ADR-0015）。**只有 named 進人工裁決佇列**，其餘三層可重算。
  layer         TEXT NOT NULL CHECK (layer IN ('derived','named','comention','similarity')),
  rel           TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('item','entity')),
  target_id     TEXT NOT NULL,
  target_kind   TEXT NOT NULL CHECK (target_kind IN ('item','entity')),
  -- origin 與 status **分開存**。機器永遠不得覆寫人工判定。
  origin        TEXT NOT NULL CHECK (origin IN ('machine','human')),
  status        TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected')),
  -- 連續分數。**只用於排序與線寬，永遠不顯示成小數。**
  confidence    REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  -- 曾被否決過又帶著新出處回來（ADR-0016 的墓碑例外）。
  previously_rejected INTEGER NOT NULL DEFAULT 0 CHECK (previously_rejected IN (0,1)),
  run_id        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (NOT (source_id = target_id AND source_kind = target_kind))
);
-- 墓碑查詢的索引：擴展寫入路徑上每一條候選邊都要查一次。
CREATE INDEX idx_edge_triple ON edge(source_id, target_id, rel);
CREATE INDEX idx_edge_layer_status ON edge(layer, status);
CREATE INDEX idx_edge_source ON edge(source_id);
CREATE INDEX idx_edge_target ON edge(target_id);

-- ── 出處 ──────────────────────────────────────────────────
CREATE TABLE edge_evidence (
  id            TEXT PRIMARY KEY,
  edge_id       TEXT NOT NULL REFERENCES edge(id) ON DELETE CASCADE,
  -- 引文出自哪個 item。**獨立來源數是靠這個欄位分群的。**
  item_id       TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  quote         TEXT NOT NULL,
  char_start    INTEGER NOT NULL,
  char_end      INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  CHECK (char_end >= char_start)
);
CREATE INDEX idx_evidence_edge ON edge_evidence(edge_id);
CREATE INDEX idx_evidence_item ON edge_evidence(item_id);

-- ── 稽核紀錄（ADR-0016）──────────────────────────────────
-- **只增不刪。** 校準比例只採計每條邊的最新判定。
CREATE TABLE edge_audit (
  id            TEXT PRIMARY KEY,
  edge_id       TEXT NOT NULL REFERENCES edge(id) ON DELETE CASCADE,
  from_status   TEXT NOT NULL,
  to_status     TEXT NOT NULL,
  action        TEXT NOT NULL,
  actor         TEXT NOT NULL CHECK (actor IN ('human','machine')),
  run_id        TEXT,
  at            INTEGER NOT NULL
);
CREATE INDEX idx_audit_edge_at ON edge_audit(edge_id, at DESC);

-- ── 筆記與點註 ────────────────────────────────────────────
CREATE TABLE note (
  id            TEXT PRIMARY KEY,
  item_id       TEXT REFERENCES item(id) ON DELETE SET NULL,
  body          TEXT NOT NULL DEFAULT '',
  -- W3C Web Annotation 的選擇器陣列（ADR-0019）。
  -- 三種來源共用這一個欄位 —— 不為它們開三張表。
  selector_json TEXT NOT NULL DEFAULT '[]',
  -- 錨點解析失敗時標起來，**註記內容保留**，不靜默丟掉也不錨到錯的地方。
  anchor_ok     INTEGER NOT NULL DEFAULT 1 CHECK (anchor_ok IN (0,1)),
  md_path       TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_note_item ON note(item_id);

-- ── 擴展作業 ──────────────────────────────────────────────
CREATE TABLE run (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('import','expand')),
  status        TEXT NOT NULL
                CHECK (status IN ('queued','running','done','partial','cancelled','failed')),
  succeeded     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_run_created ON run(created_at DESC);

-- ── 向量 ──────────────────────────────────────────────────
-- **model 與 dim 是硬約束，不是中繼資料。**
-- 換了嵌入模型之後舊向量全部作廢，而餘弦相似度**照樣算得出一個數字** ——
-- 那是靜默失效。查詢時模型不符要拒絕比對（PROVIDER_EMBED_MODEL_MISMATCH）。
CREATE TABLE vector (
  id            TEXT PRIMARY KEY,
  owner_kind    TEXT NOT NULL CHECK (owner_kind IN ('item','entity','note')),
  owner_id      TEXT NOT NULL,
  model         TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  embedding     BLOB NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_vector_owner ON vector(owner_kind, owner_id);
CREATE INDEX idx_vector_model ON vector(model, dim);

-- ── 中文檢索：應用層自建的 bigram 索引 ────────────────────
-- FTS5 的 trigram 對 2 個字的查詢**命中 0 列**（2026-09-05 實測），
-- 而中文查詢多半是 2 字詞。拉丁走 FTS5 unicode61，見下面。
CREATE TABLE bigram (
  gram          TEXT NOT NULL,
  owner_kind    TEXT NOT NULL CHECK (owner_kind IN ('item','entity','note')),
  owner_id      TEXT NOT NULL,
  freq          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (gram, owner_kind, owner_id)
) WITHOUT ROWID;
CREATE INDEX idx_bigram_owner ON bigram(owner_kind, owner_id);

-- 拉丁／西里爾等走 FTS5。und 的內容兩條路都建索引。
CREATE VIRTUAL TABLE fts_text USING fts5(
  owner_id UNINDEXED,
  owner_kind UNINDEXED,
  content,
  tokenize = 'unicode61'
);

-- ══ 兩條由資料庫層守著的約束 ══════════════════════════════
-- data-model.md 明寫「由資料庫層守，不是靠 UI 記得」。
-- 寫成 trigger 而不是應用層檢查，是因為應用層有很多寫入點，而 trigger 只有一個。

-- 1. status='confirmed' 需要至少一筆 edge_evidence，除非 origin='human'
CREATE TRIGGER trg_edge_confirm_requires_evidence_ins
BEFORE INSERT ON edge
WHEN NEW.status = 'confirmed' AND NEW.origin = 'machine'
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_EVIDENCE_REQUIRED');
END;

CREATE TRIGGER trg_edge_confirm_requires_evidence_upd
BEFORE UPDATE OF status ON edge
WHEN NEW.status = 'confirmed' AND NEW.origin = 'machine'
     AND (SELECT COUNT(*) FROM edge_evidence WHERE edge_id = NEW.id) < 1
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_EVIDENCE_REQUIRED');
END;

-- 2. origin='human' 的列只能新增不能改
--    **機器永遠不得覆寫人工判定。**
--    例外：status 與 updated_at 可以被人改（那是裁決本身），
--    但 layer／rel／兩端／origin／confidence 一律不准動。
CREATE TRIGGER trg_edge_human_row_immutable
BEFORE UPDATE ON edge
WHEN OLD.origin = 'human'
     AND (NEW.layer      IS NOT OLD.layer
       OR NEW.rel        IS NOT OLD.rel
       OR NEW.source_id  IS NOT OLD.source_id
       OR NEW.target_id  IS NOT OLD.target_id
       OR NEW.origin     IS NOT OLD.origin
       OR NEW.confidence IS NOT OLD.confidence)
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_HUMAN_ROW_IMMUTABLE');
END;
