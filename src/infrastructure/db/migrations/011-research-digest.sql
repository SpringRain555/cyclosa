-- schema v11 —— 研究：初讀（Stage 21，ADR-0033 D9、REQ-0009 R14–R16）
--
-- 欄位與值域的權威是 docs/architecture/data-model.md。**改這裡就要改那一份。**
--
-- **全部是 ADD COLUMN，外鍵照開** —— 這一版沒有要改的 CHECK，不必重建資料表
-- （「重建資料表」是 v10 與 v13 的事）。

-- ══ 一 · item：初讀給的繁中標題與摘要（衍生物）══════════════════════
--
-- **原文欄位永遠不被覆蓋**（`multilingual.md`、R15）：`title` 與正文照舊，繁中另外四欄。
-- 把這四欄清成 NULL，原文完全不變 —— 那是這條規則可以驗的形式。
-- `digested_by` 是**實際跑的那一個模型**，連同服務（`ollama:granite4.2:8b`、`openai:…`），
-- 閱讀器與節點面板那一句「由 {模型} 於 {日期} 產生」讀的就是它與 `digested_at`。
ALTER TABLE item ADD COLUMN title_zh TEXT;
ALTER TABLE item ADD COLUMN summary_zh TEXT;
ALTER TABLE item ADD COLUMN digested_by TEXT;
ALTER TABLE item ADD COLUMN digested_at INTEGER;

-- ══ 二 · research_candidate：初讀的判斷 ══════════════════════════════
--
-- `relevance` 是**這一次研究**的判斷（同一份資料對另一個主題可能無關），所以住在候選上，不在 item 上。
-- `digest_code`：這一份初讀失敗的原因（模型沒回、回的不是 JSON、形狀不對）。**有碼 ＝ 讀過但失敗**；
-- `relevance` 是 NULL 而沒有碼 ＝ 還沒讀 —— 「繼續蒐集」只讀這兩種，已經讀好的不重讀。
ALTER TABLE research_candidate ADD COLUMN relevance TEXT
  CHECK (relevance IS NULL OR relevance IN ('yes', 'no', 'unsure'));
ALTER TABLE research_candidate ADD COLUMN relevance_why TEXT NOT NULL DEFAULT '';
ALTER TABLE research_candidate ADD COLUMN digest_code TEXT;

-- ══ 三 · run：逐任務的花費 ══════════════════════════════════════════
--
-- 研究畫面要說「花了 0.42 美元（初讀 0.31、找來源 0.11）」（R29），而一筆蒐集作業裡同時有找來源與初讀。
-- `requests`／`cost_usd`／`unpriced` 仍然是總數（既有的畫面讀它們），這一欄是拆開的那一份：
-- `{"find-sources": {"requests": 3, "costUsd": 0.11, "unpriced": 0}, "digest": {…}}`。
-- **跟總數一起寫**（`run-repo` 的同一支函式、同一句 UPDATE），分開寫會有一刻對不起來。
-- `NULL` ＝ 這一筆作業沒有拆（v11 以前的，或不花模型的匯入）。
ALTER TABLE run ADD COLUMN task_costs_json TEXT;
