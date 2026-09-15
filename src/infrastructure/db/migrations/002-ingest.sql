-- Cyclosa schema v2 —— 匯入與閱讀器
--
-- 欄位與值域的權威是 docs/architecture/data-model.md。**改這裡就要改那一份。**

-- ── item：擷取與抽取的結果 ────────────────────────────────
--
-- v1 只有「這個節點是什麼」，v2 補的是「它是怎麼來的、抽得好不好」。
-- 這些欄位**每一個都有一個畫面在讀它**，不是為了完整而存的中繼資料。

-- 使用者實際貼進來的那個 URL。**與 source_url 分開存**：
-- source_url 是轉址跟完之後真正抓到的位址，而使用者下次再貼一次的是這一個。
-- 只留一個的話，短網址與轉址會讓同一份東西進來兩次。
ALTER TABLE item ADD COLUMN requested_url TEXT;

-- 快照的媒體型別與副檔名。sources/<sha256>.<ext> 要靠 ext 才找得到檔案。
ALTER TABLE item ADD COLUMN mime TEXT;
ALTER TABLE item ADD COLUMN source_ext TEXT;
ALTER TABLE item ADD COLUMN byte_size INTEGER;

-- 抽取信心低的**理由**（JSON 陣列）。
-- v1 只有 low_confidence 布林 —— 而「為什麼低」是使用者唯一能據以判斷的東西。
ALTER TABLE item ADD COLUMN low_confidence_reasons TEXT NOT NULL DEFAULT '[]';

-- 閱讀器與清單的摘要。抽取產生，可重算。
ALTER TABLE item ADD COLUMN excerpt TEXT NOT NULL DEFAULT '';

-- 這一份的 derived/ 是哪一版抽取器產生的。整批重算時靠它認出過期的。
ALTER TABLE item ADD COLUMN extractor_version INTEGER;

-- PDF 的頁數。**頁碼是 1-based**（ADR-0019）。
ALTER TABLE item ADD COLUMN page_count INTEGER;

-- 圖片的原始尺寸。**矩形註記的座標系就是它**（#xywh=pixel:）——
-- 讀不出來就是 NULL，不要猜一個數字。
ALTER TABLE item ADD COLUMN image_width INTEGER;
ALTER TABLE item ADD COLUMN image_height INTEGER;

-- 失敗的那一項自己的錯誤碼。**不是一個「匯入失敗」**（ui-workflows）。
ALTER TABLE item ADD COLUMN error_code TEXT;

-- 同一個 URL 不重複建節點（REQ-0003：重試不產生第二個節點）。
CREATE UNIQUE INDEX idx_item_requested_url ON item(requested_url) WHERE requested_url IS NOT NULL;
CREATE INDEX idx_item_run ON item(run_id);
CREATE INDEX idx_item_read_at ON item(read_at) WHERE read_at IS NOT NULL;

-- ── run：一次作業 ─────────────────────────────────────────
ALTER TABLE run ADD COLUMN label TEXT NOT NULL DEFAULT '';
-- 這一批總共幾項。進度條與「成功 37、失敗 3」要靠它。
ALTER TABLE run ADD COLUMN total INTEGER NOT NULL DEFAULT 0;
-- 整批失敗時的碼（例如 provider 配不上）。單項失敗不寫這裡，寫 run_item。
ALTER TABLE run ADD COLUMN error_code TEXT;

-- ── run_item：一次作業裡的一個輸入 ────────────────────────
--
-- **為什麼不是直接用 item。** 一個輸入不一定會變成一個 item：
-- robots 不准的、404 的、內容已經在專題裡的，全部都沒有 item ——
-- 而作業紀錄那一頁**必須看得到它們**，否則「40 個 URL 有 3 個失敗」
-- 這句話裡的 3 就沒有地方顯示原因。
--
-- 這張表對應 ui-workflows 的「狀態／來源／網域／新增節點／新增關聯／備註」。
CREATE TABLE run_item (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  -- 使用者給的東西：URL 或檔名。**原樣保留**，因為錯誤訊息要指回它。
  requested     TEXT NOT NULL,
  host          TEXT,
  item_id       TEXT REFERENCES item(id) ON DELETE SET NULL,
  outcome       TEXT NOT NULL
                CHECK (outcome IN ('queued','running','ok','duplicate','failed','skipped','cancelled')),
  -- 這一項自己的錯誤碼。**duplicate 與 skipped 不是失敗**，但它們也有碼。
  code          TEXT,
  new_nodes     INTEGER NOT NULL DEFAULT 0,
  new_edges     INTEGER NOT NULL DEFAULT 0,
  -- 為了節流實際等了多久。REQ-0003 的「可量測」就是它。
  waited_ms     INTEGER,
  at            INTEGER
);
CREATE INDEX idx_run_item_run ON run_item(run_id, id);
CREATE INDEX idx_run_item_outcome ON run_item(run_id, outcome);
