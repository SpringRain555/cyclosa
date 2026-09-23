-- cyclosa: foreign-keys-off
--
-- schema v10 —— 研究：蒐集（Stage 20，ADR-0033 D3／D7／D8、REQ-0009 R7–R13）
--
-- 欄位與值域的權威是 docs/architecture/data-model.md。**改這裡就要改那一份。**
--
-- ## 這是這個專案第一次重建資料表
--
-- SQLite 改不了既有的 CHECK。`run.kind` 要多 `research`／`consolidate`、`item.kind` 要多
-- `reference`（書目節點，ADR-0033 D12），兩件事都只能照官方那套做法：
-- 建新表 → 搬資料 → 刪舊表 → **新表換名**（反過來「舊表先換名」會把別的表指著它的外鍵
-- 一起改成指向舊名字）。
--
-- 最上面那一行標記讓執行器在交易**外面**關外鍵（`database.ts` 的 `FOREIGN_KEYS_OFF_MARKER`）：
-- 外鍵開著的時候 `DROP TABLE run` 會先隱含一次 `DELETE`，而 `run_item`／`run_angle` 是
-- `ON DELETE CASCADE` —— 每一筆作業的逐項紀錄會跟著消失。提交之前執行器跑一次
-- `foreign_key_check`，多出斷掉的參照就整份退回。
--
-- ## 為什麼 `trg_note_needs_item_node` 要先拆掉再裝回
--
-- 它掛在 `note` 上，**內文讀 `item`**。`item` 刪掉、新表還沒換名的那一刻，換名那一步會去解析
-- 整份 schema 的 trigger，而它指著一張不存在的表：
-- `error in trigger trg_note_needs_item_node: no such table: main.item`（2026-09-23 實測）。
-- 另一個解法是 `PRAGMA legacy_alter_table = ON`，那會改變換名時外鍵的改寫規則 ——
-- **明寫拆掉、裝回**比切一個全域開關好讀，也只動到這一條。

-- ══ 一 · run：多兩種作業、記得是哪一次研究的、記得有幾次沒回報花費 ══════════
--
-- `research_id`：**研究的花費要加總它每一筆作業**（R29）。「繼續蒐集」會開新的一筆作業，
-- 只靠 `research.collect_run_id`（最新那一筆）的話，前面那幾筆花的錢就不見了。
-- 研究被刪掉的時候作業留著（ADR-0033 D15：它們是「圖上這些東西來自哪裡」的唯一紀錄），
-- 所以是 `SET NULL`。
--
-- `unpriced`：這一筆作業裡**有幾次呼叫沒回報花費**。`cost_usd` 只加總回報過的那幾次，
-- 所以光看它分不出「全部都回報了」與「一半沒回報」—— 而研究畫面要說的是
-- 「花了 $0.42，另外有 3 次不知道」（同 `research_message.cost_usd` 的規則：NULL 不是 0）。
CREATE TABLE run_new (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('import','expand','research','consolidate')),
  status        TEXT NOT NULL
                CHECK (status IN ('queued','running','done','partial','cancelled','failed')),
  succeeded     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  created_at    INTEGER NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  total         INTEGER NOT NULL DEFAULT 0,
  error_code    TEXT,
  topic         TEXT,
  providers_json TEXT,
  requests      INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL,
  ended_reason  TEXT CHECK (ended_reason IS NULL OR ended_reason IN ('shutdown', 'stale')),
  research_id   TEXT REFERENCES research(id) ON DELETE SET NULL,
  unpriced      INTEGER NOT NULL DEFAULT 0
);
INSERT INTO run_new (
  id, kind, status, succeeded, failed, correlation_id, started_at, ended_at, created_at,
  label, total, error_code, topic, providers_json, requests, cost_usd, ended_reason
)
SELECT
  id, kind, status, succeeded, failed, correlation_id, started_at, ended_at, created_at,
  label, total, error_code, topic, providers_json, requests, cost_usd, ended_reason
FROM run;
DROP TABLE run;
ALTER TABLE run_new RENAME TO run;
CREATE INDEX idx_run_created ON run(created_at DESC);
CREATE INDEX idx_run_research ON run(research_id) WHERE research_id IS NOT NULL;

-- ══ 二 · item：書目節點（`reference`），拿掉從來沒建過的 `paper` ══════════════
--
-- `paper` 從 v1 就在 CHECK 裡，而**沒有任何一條寫入路徑產生過它**（程式裡只出現在型別、
-- 節點型別篩選的值域與重算時一行 `paper → pdf` 的對映）。搬資料時照同一個對映處理 ——
-- 萬一真的有一列，它不該讓整份 migration 因為新的 CHECK 失敗。
DROP TRIGGER trg_note_needs_item_node;

CREATE TABLE item_new (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('web','pdf','image','text','note','reference')),
  title         TEXT NOT NULL DEFAULT '',
  title_rank    TEXT NOT NULL DEFAULT '',
  source_url    TEXT,
  lang          TEXT NOT NULL DEFAULT 'und',
  sha256        TEXT,
  fetched_at    INTEGER,
  status        TEXT NOT NULL
                CHECK (status IN ('pending','fetched','parsed','included','excluded','failed')),
  low_confidence INTEGER NOT NULL DEFAULT 0 CHECK (low_confidence IN (0,1)),
  read_at       INTEGER,
  run_id        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  requested_url TEXT,
  mime          TEXT,
  source_ext    TEXT,
  byte_size     INTEGER,
  low_confidence_reasons TEXT NOT NULL DEFAULT '[]',
  excerpt       TEXT NOT NULL DEFAULT '',
  extractor_version INTEGER,
  page_count    INTEGER,
  image_width   INTEGER,
  image_height  INTEGER,
  error_code    TEXT
);
INSERT INTO item_new (
  id, kind, title, title_rank, source_url, lang, sha256, fetched_at, status, low_confidence,
  read_at, run_id, created_at, updated_at, requested_url, mime, source_ext, byte_size,
  low_confidence_reasons, excerpt, extractor_version, page_count, image_width, image_height,
  error_code
)
SELECT
  id, CASE kind WHEN 'paper' THEN 'pdf' ELSE kind END, title, title_rank, source_url, lang,
  sha256, fetched_at, status, low_confidence, read_at, run_id, created_at, updated_at,
  requested_url, mime, source_ext, byte_size, low_confidence_reasons, excerpt,
  extractor_version, page_count, image_width, image_height, error_code
FROM item;
DROP TABLE item;
ALTER TABLE item_new RENAME TO item;

-- v1 與 v2 的七個索引，**一個不少**（`tests/infrastructure/migration-v10.test.ts` 對著重建前後比）。
CREATE INDEX idx_item_status     ON item(status);
CREATE INDEX idx_item_title_rank ON item(title_rank);
CREATE INDEX idx_item_lang       ON item(lang);
CREATE UNIQUE INDEX idx_item_sha256 ON item(sha256) WHERE sha256 IS NOT NULL;
CREATE UNIQUE INDEX idx_item_requested_url ON item(requested_url) WHERE requested_url IS NOT NULL;
CREATE INDEX idx_item_run ON item(run_id);
CREATE INDEX idx_item_read_at ON item(read_at) WHERE read_at IS NOT NULL;

-- 跟 v5 一字不差（理由在 005-annotation.sql）。
CREATE TRIGGER trg_note_needs_item_node
BEFORE INSERT ON note
WHEN (SELECT kind FROM item WHERE id = NEW.id) IS NOT 'note'
BEGIN
  SELECT RAISE(ABORT, 'NOTE_TARGET_MISSING');
END;

-- ══ 三 · 方向：搜過了沒有 ═══════════════════════════════════════════════
--
-- 「繼續蒐集」只做還沒做完的（R13：已抓的不重抓）。**搜尋失敗的那幾條要能重來**
-- （服務連不上、逾時、回的不是 JSON），而「搜過、找到 0 份」是做完了 —— 三種要分得開。
-- 沒被採用的方向（`adopted = 0`）永遠停在 `pending`：它們不搜。
ALTER TABLE research_direction ADD COLUMN search_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (search_state IN ('pending','done','failed'));
ALTER TABLE research_direction ADD COLUMN search_code TEXT;
ALTER TABLE research_direction ADD COLUMN searched_at INTEGER;

-- ══ 四 · 候選：找到、還沒確認要不要進專題的一個來源（ADR-0033 D7）════════════
--
-- **同一次研究裡同一個網址只有一列**：兩條方向找到同一篇，第二條記在 `also_directions_json`。
-- 分成兩列的話它會被抓兩次、在確認畫面上出現兩次，而「每條方向找到幾份」會數錯。
--
-- **取得狀態與最終狀態是兩件事**（`decision` 在 Stage 22 加）。這一版只有取得狀態：
--
--   found       找到了，還沒抓
--   fetching    正在抓（作業還活著的時候才看得到；程式停在半路的話下一次當成 found）
--   fetched     抓到了 —— `item_id` 是那一份資料（抓回來的候選**就是資料節點**，D8）
--   needs-user  要你拿：抓了拿不到（`code` 是擷取的錯誤碼），或依你的紀錄這個網站多半要登入、
--               所以沒去試（`code` 是 NULL —— R8：試一次付費牆只會多一次被擋）
--   uploaded    你上傳的那一份（`item_id` 指著它；出處仍然指得回 `url`，R10）
--   unavailable 你說拿不到，而且說了原因（R11）
--
-- `expected_access` 是**抓之前**依你的紀錄的預期（公開／多半要登入／會被擋／不知道），
-- 不是模型說的 —— 模型只給網址、標題、為什麼與搜尋結果裡看得到的書目欄位。
CREATE TABLE research_candidate (
  id            TEXT PRIMARY KEY,
  research_id   TEXT NOT NULL REFERENCES research(id) ON DELETE CASCADE,
  direction_id  TEXT REFERENCES research_direction(id) ON DELETE SET NULL,
  also_directions_json TEXT NOT NULL DEFAULT '[]',
  -- 顯示順序 ＝ 找到的順序。**不重排**（同 `research_message.ord`）。
  ord           INTEGER NOT NULL,
  -- 正規化過的網址（`domain/ingest/url.ts`）。去重的鍵。
  url           TEXT NOT NULL,
  -- 搜尋結果上的標題（原文，不翻）。**書目節點要有名字**（D7）；模型沒給就是空字串，畫面退回網址。
  title         TEXT NOT NULL DEFAULT '',
  why           TEXT NOT NULL DEFAULT '',
  -- 作者、年份、出處：**搜尋結果裡有才填**，不叫模型猜（D7）。
  bib_json      TEXT NOT NULL DEFAULT '{}',
  expected_access TEXT NOT NULL CHECK (expected_access IN ('open','login','blocked','unknown')),
  acquisition   TEXT NOT NULL CHECK (acquisition IN (
                  'found','fetching','fetched','needs-user','uploaded','unavailable')),
  code          TEXT,
  unavailable_reason TEXT CHECK (unavailable_reason IS NULL OR unavailable_reason IN (
                  'paywall','not-found','blocked','other')),
  reason_note   TEXT NOT NULL DEFAULT '',
  item_id       TEXT REFERENCES item(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (research_id, url),
  -- **「拿不到」一定帶原因，原因只跟「拿不到」一起出現。** 兩邊各自寫的話，
  -- 會出現一列「要你拿」卻帶著「付費牆」的候選 —— 畫面上不知道該信哪一個。
  CHECK ((acquisition = 'unavailable') = (unavailable_reason IS NOT NULL))
);
CREATE INDEX idx_research_candidate ON research_candidate(research_id, ord);
-- 閱讀器要問「這一份是不是某一次研究的候選」（D8 的標籤）。
CREATE INDEX idx_research_candidate_item ON research_candidate(item_id) WHERE item_id IS NOT NULL;
