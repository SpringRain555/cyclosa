-- schema v9 —— 研究：談出方向的那一半（Stage 19，ADR-0033、REQ-0009 R1–R6）
--
-- 欄位與值域的權威是 docs/architecture/data-model.md。**改這裡就要改那一份。**
--
-- ## 研究不是作業
--
-- 真正做事的仍然是 `run`：蒐集是一筆、建圖是另一筆（Stage 20／22）。
-- 這三張表記的是**工作流停在哪**，以及停在那裡的時候人看得到什麼。
--
-- 分開的理由在 ADR-0033 D3：「等你上傳」可以等好幾天，而一個好幾天都標著
-- 「執行中」的作業，下次打開專題時會被 `run-sweep` 掃成「上次停在半路」。
--
-- ## 這一版還沒動 `run`
--
-- `run.kind` 的 CHECK 仍然只有 `import`／`expand` —— 這一版一筆研究作業都不會建
-- （蒐集在 Stage 20）。放寬它要**重建資料表**，而重建 `run` 必須先關掉外鍵
-- （`run_item`／`run_angle` 是 ON DELETE CASCADE，DROP TABLE 會連帶把它們刪掉），
-- 關外鍵又必須在交易外面 —— 而這支 migration runner 把整份檔案包在一個交易裡。
-- **所以那件事排在真的需要它的那一版**（Stage 20 的 v10），連同 runner 要怎麼支援它一起做。

-- ── 一次研究（或整理）────────────────────────────────────
CREATE TABLE research (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('research','consolidate')),
  status        TEXT NOT NULL CHECK (status IN (
                  'planning','collecting','awaiting-user','reviewing','building','done','abandoned')),
  -- 整理沒有主題（對象是整個專題），所以可以是 NULL。
  topic         TEXT,
  -- **最新的一份規劃**：方向清單、跟專題的關係、刻意不查的範圍。
  -- 閘門一之前每談一輪就換一次；按下閘門一的那一刻落成 `research_direction`（ADR-0033 D5）。
  plan_json     TEXT NOT NULL DEFAULT '{}',
  -- 輸入主題當下的全文檢索命中（R1）。**不花錢的那一份事實**，存下來是因為
  -- 它同時是給模型看的素材 —— 之後回頭看這次研究時，要知道當時它看到的是什麼。
  hits_json     TEXT NOT NULL DEFAULT '[]',
  -- 蒐集與建圖各是一筆作業（Stage 20／22 才會有值）。
  collect_run_id TEXT REFERENCES run(id),
  build_run_id   TEXT REFERENCES run(id),
  correlation_id TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  -- **同一個專題同時只有一次研究或整理沒結束**（ADR-0033 D4）。
  --
  -- 用產生欄位 ＋ 部分唯一索引來守，而不是在程式裡查一次再寫：
  -- 「先查再寫」在兩個請求同時進來時擋不住（畫面上按兩次「開始」就會發生），
  -- 而兩次研究同時建圖會同時寫實體對齊與關聯 —— 「這一次新增了什麼」就數不清了。
  --
  -- 終態是 NULL，而 **NULL 在唯一索引裡不互相衝突** —— 所以做完的可以有很多筆。
  open_key      INTEGER GENERATED ALWAYS AS (
                  CASE WHEN status IN ('done','abandoned') THEN NULL ELSE 1 END) VIRTUAL
);
CREATE UNIQUE INDEX idx_research_open ON research(open_key);
CREATE INDEX idx_research_created ON research(created_at DESC);

-- ── 規劃對話的一輪 ────────────────────────────────────────
--
-- **失敗的那幾輪也留著**（`code` 有值、`plan_json` 是 NULL）。
-- 「模型那一次回了什麼形狀的垃圾」是這次研究發生過的事實的一部分，
-- 而且它是使用者回報問題時唯一查得到的東西（`run_angle` 留下沒被勾的角度，同一個理由）。
CREATE TABLE research_message (
  id            TEXT PRIMARY KEY,
  research_id   TEXT NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  -- 顯示順序。**不重排** —— 重排會讓「第幾輪」在兩個畫面上不一樣。
  ord           INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('user','model')),
  -- 人說的話，或模型那一輪給人看的那一段（規劃裡的 `reply`）。
  content       TEXT NOT NULL DEFAULT '',
  -- 模型那一輪交出的規劃（正規化之後的）。人的那幾列是 NULL。
  plan_json     TEXT,
  -- **實際跑的那一個模型**與它走的服務。換了模型之後結果會不一樣，而這是唯一查得到的地方。
  model         TEXT,
  via           TEXT,
  -- **NULL 與 0 是兩件事**：本機模型真的是 0，沒回報的是不知道（同 `run.cost_usd`）。
  cost_usd      REAL,
  elapsed_ms    INTEGER,
  -- 這一輪的錯誤碼。**一輪失敗不會結束這次研究** —— 使用者可以再談一次。
  code          TEXT,
  at            INTEGER NOT NULL
);
CREATE INDEX idx_research_message ON research_message(research_id, ord);

-- ── 閘門一那一刻落成的方向 ────────────────────────────────
--
-- **沒被採用的也留著**（`adopted = 0`）：模型提了哪些、你留了哪些，
-- 是這次研究的一部分（跟 `run_angle` 保留沒被勾的角度是同一個理由）。
CREATE TABLE research_direction (
  id            TEXT PRIMARY KEY,
  research_id   TEXT NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  -- 要找什麼、預期哪一類來源、關鍵詞。**都可以是空的** —— 標題有時候就說完了。
  what          TEXT NOT NULL DEFAULT '',
  expect        TEXT NOT NULL DEFAULT '',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  -- 誰提的。**使用者改過的那一條就是人提的**（R4：畫面上標「你改的」）。
  origin        TEXT NOT NULL CHECK (origin IN ('model','human')),
  adopted       INTEGER NOT NULL DEFAULT 1 CHECK (adopted IN (0,1)),
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_research_direction ON research_direction(research_id, ord);
