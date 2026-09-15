-- schema v6 —— 實體對齊
--
-- `entity-repo.ts` 開頭那段註解從 v0.5.0 就寫著這個問題：
-- 比對只看名字、不做同義詞，代價是**同一個東西的兩種寫法會變成兩個節點**。
-- 當時的判斷是「多一個節點比錯一個節點好 —— 前者看得見，後者看不見」。
--
-- **那個判斷漏算了一個後果。** 投影三段的門檻是「被 ≥3 份文件提到才展開成節點，
-- 被 1 份提到根本不畫」。所以一個被 9 份文件提到、但拆成三種叫法的實體，
-- 三個都低於門檻 —— **一個都不會出現在圖上**。
-- 那不是「多一個節點」，那是**少了唯一那一個**。

-- ── 合併的指標 ────────────────────────────────────────────
--
-- 被吸收的那一列**不刪**。同一段註解的另一句話是這裡的設計限制：
-- 「合錯了沒有工具可以拆開」——所以留著指標，取消合併就是把它清掉。
--
-- 形狀跟 ADR-0016 的墓碑一樣：**不刪任何一列。**
ALTER TABLE entity ADD COLUMN merged_into TEXT REFERENCES entity(id) ON DELETE SET NULL;
ALTER TABLE entity ADD COLUMN merged_at INTEGER;

-- 「還活著的實體」是每一次抽取、每一次投影都要問的一句話。
CREATE INDEX idx_entity_merged ON entity(merged_into);

-- ── 合併紀錄 ──────────────────────────────────────────────
--
-- **只增不刪**，跟 `edge_audit` 同一個規矩。
--
-- `moved_json` 記的是這一次真的動了哪幾條邊（`[{edgeId, field}]`），
-- 而它存在的唯一理由是**取消合併時要動得回來**。
-- 沒有它的話，「把 B 的邊還給 B」只能猜，而猜錯會把 A 本來就有的邊送給 B。
CREATE TABLE entity_merge (
  id            TEXT PRIMARY KEY,
  kept_id       TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  merged_id     TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  -- 為什麼覺得它們是同一個：same-key / alias / parenthetical / manual。
  reason        TEXT NOT NULL,
  moved_json    TEXT NOT NULL DEFAULT '[]',
  -- 取消合併之後這一列留著，只是標成已撤銷 —— **紀錄不會消失。**
  undone_at     INTEGER,
  at            INTEGER NOT NULL
);
CREATE INDEX idx_entity_merge_merged ON entity_merge(merged_id, at DESC);

-- ── 一個實體不能合併到自己 ────────────────────────────────
--
-- 這條 trigger 擋的是一個會讓讀取路徑無窮迴圈的狀態。
-- `resolveMerged` 那邊也有跳數上限，而**兩層擋同一件事**的理由跟別處一樣：
-- 應用層有很多寫入點，trigger 只有一個。
CREATE TRIGGER trg_entity_no_self_merge
BEFORE UPDATE OF merged_into ON entity
WHEN NEW.merged_into = NEW.id
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_SELF_EDGE');
END;
