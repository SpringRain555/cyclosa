-- schema v14 —— 整理殼的操作清單（ADR-0033 C1，Stage 24 issue #4）
--
-- 每個提案獨立保存勾選、執行狀態與復原資訊；未勾選的也保留。
CREATE TABLE consolidate_op (
  id            TEXT PRIMARY KEY,
  research_id   TEXT NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL CHECK (ord >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('merge','extract','add-edge','retype','digest')),
  payload_json  TEXT NOT NULL,
  why           TEXT NOT NULL,
  checked       INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0,1)),
  state         TEXT NOT NULL DEFAULT 'proposed'
                CHECK (state IN ('proposed','done','failed','stale','skipped')),
  code          TEXT,
  run_id        TEXT REFERENCES run(id) ON DELETE SET NULL,
  undo_json     TEXT,
  executed_at   INTEGER,
  UNIQUE (research_id, ord)
);
CREATE INDEX idx_consolidate_op_research ON consolidate_op(research_id, ord);
