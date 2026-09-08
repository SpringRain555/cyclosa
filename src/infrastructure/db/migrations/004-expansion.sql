-- schema v4 —— LLM 擴展（Stage 9）
--
-- 這一版加的東西全部繞著同一句話：**擴展不是黑箱**。
-- 「切入角度」要留下來（使用者勾了哪幾條、沒勾哪幾條），
-- 這一次花了幾次呼叫、多少錢也要留下來 —— 否則作業紀錄那一頁
-- 只說得出「跑完了」，而那正是這個工具在避免的東西。

-- ── run 補三欄 ────────────────────────────────────────────

-- 擴展的主題。**匯入沒有主題，所以可以是 NULL** —— 兩種 run 共用一張表。
ALTER TABLE run ADD COLUMN topic TEXT;

-- 這一次用了哪些模型，JSON：{"chat":"…","agent":"…"}。
--
-- **為什麼要存**：換一個模型重跑，結果會不一樣。
-- 沒有這一欄的話，兩次結果不同時沒有任何地方查得出「換了模型」這件事。
ALTER TABLE run ADD COLUMN providers_json TEXT;

-- 實際打了幾次模型。**請求數是主要上限**（ADR-0006 的補記，Q3 的答案）。
ALTER TABLE run ADD COLUMN requests INTEGER NOT NULL DEFAULT 0;

-- provider 回報的實際金額。
--
-- **NULL 與 0 是兩件事，而且這一欄是它們唯一分得開的地方：**
-- 本機模型的金額成本真的是 0；一個沒回報成本的雲端 provider 是「不知道」。
-- 兩者都寫成 0 的話，畫面上那句「已花費 $0.00」對前者是事實、對後者是謊。
-- **不估算** —— provider 沒給就是 NULL。
ALTER TABLE run ADD COLUMN cost_usd REAL;

-- ── 切入角度 ──────────────────────────────────────────────
--
-- 一次擴展分兩階段：`POST /runs` 產生角度（**還沒開始抓**），
-- 使用者勾選之後 `POST /runs/:id/angles` 才真的開始。
-- 這張表就是那兩階段之間的東西。
--
-- **沒被勾的那幾條也留著。** 「工具提了六條、你只要兩條」
-- 是這次作業發生過的事實的一部分 —— 只存勾到的，作業紀錄就變成
-- 一份看不出當時有哪些選項的紀錄。
CREATE TABLE run_angle (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  -- 顯示順序 ＝ 模型給的順序。**不重排** —— 重排會讓「第幾條」在兩個畫面上不一樣。
  ord           INTEGER NOT NULL,
  question      TEXT NOT NULL,
  -- 立場標籤（「時間線」「反對意見」…）。沒有就是空字串，不是 NULL。
  stance        TEXT NOT NULL DEFAULT '',
  -- 這條角度是從專題裡既有的哪幾份長出來的（item id 陣列）。
  --
  -- **設計稿在這裡寫的是「預估會找到幾個」，而那個數字只可能是模型猜的。**
  -- 一個精確的樣子出現在要人做決定的畫面上，跟「可信度不給小數」
  -- （ADR-0017）擋的是同一件事。換成這一欄：它是我們查得到也驗得了的，
  -- 而且對「要不要勾這一條」更有用 —— 它說的是這條角度憑什麼被提出來。
  seeds_json    TEXT NOT NULL DEFAULT '[]',
  selected      INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1)),
  -- 這條角度自己的收尾：找到幾個網址、寫進去幾個節點。
  found_urls    INTEGER NOT NULL DEFAULT 0,
  new_nodes     INTEGER NOT NULL DEFAULT 0,
  new_edges     INTEGER NOT NULL DEFAULT 0,
  -- 這條角度自己的錯誤碼。**一條失敗不影響其餘**（部分失敗是一等公民）。
  code          TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_run_angle_run ON run_angle(run_id, ord);

-- ── 由資料庫層守著的一條 ──────────────────────────────────
--
-- **長度為 0 的引文不是出處。**
--
-- 001 的 CHECK 是 `char_end >= char_start`，所以 `(0, 0)` 過得去 ——
-- 而那一列在畫面上會顯示成一筆出處、點下去跳到一個空區間。
-- 「有出處」是這個工具跟競品的全部差別，一筆長度為 0 的出處
-- **會讓一條邊變成可以被確認的**（`trg_edge_confirm_requires_evidence_*`
-- 數的是列數，不是內容）。
--
-- 寫成 trigger 而不是應用層檢查，理由跟 001 那兩條一樣：
-- **應用層有很多寫入點，trigger 只有一個。**
CREATE TRIGGER trg_evidence_nonempty_range
BEFORE INSERT ON edge_evidence
WHEN NEW.char_end <= NEW.char_start
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_EVIDENCE_REQUIRED');
END;

-- 「這一次擴展寫進去幾條邊」要數得快，而 Phase E 的驗收
-- （擴展前後對 origin='human' 的子集 diff 必須為空）也走這條路。
CREATE INDEX idx_edge_run ON edge(run_id) WHERE run_id IS NOT NULL;
