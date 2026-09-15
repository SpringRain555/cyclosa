-- schema v5 —— 筆記與點註
--
-- `note` 這張表 schema v1 就在了，欄位也齊。這一版加的是**兩條沒有被寫下來的規則**，
-- 而它們沒被寫下來的時候，兩邊的文件各自是對的、合起來是矛盾的。

-- ── 一 · 「錨在不可變的快照上」要有一個看得到的欄位 ───────
--
-- ADR-0010 第 2 條寫著「錨點釘在 `sources/` 的不可變快照上，不是釘在
-- `derived/` 的重構排版上」。但在這一欄出現之前，**那句話在 schema 上沒有對應物** ——
-- 一則點註只記得它屬於哪個 `item`，而一個 `item` 的快照是可以換的
-- （抓失敗之後重試，換到一份不同的內容，`sha256` 就變了）。
--
-- 有了這一欄，「這則點註是對著哪一份東西標的」就是一個可以比對的事實，
-- 而不是一句註解。**快照換了 → 錨點對的是舊的那一份 → 該說出來**，
-- 而不是拿新的快照去解舊的錨點然後回一個看起來成功的位置。
--
-- NULL 代表「標的時候那一份還沒有快照」，目前只有 kind='text' 的手打內容會這樣。
ALTER TABLE note ADD COLUMN snapshot_sha256 TEXT;

-- ── 二 · 一則點註在圖上就是一個 kind='note' 的 item ───────
--
-- ADR-0010 第 4 條：「點註在圖上是節點，可以參與關聯」。
-- 而 `edge.source_kind` 的值域只有 `item` 與 `entity` —— **沒有 `note`。**
--
-- 那不是漏掉，是設計：`item.kind` 的 CHECK 從 schema v1 就收著 `'note'`，
-- 也就是**一則點註本來就是一個 item**，只是它不走擷取管線
-- （沒有快照、沒有 fetch、沒有 URL）。`note` 那張表存的是它的錨點。
--
-- 兩者靠**同一個 id** 綁在一起。這條規則之前只存在於 `domain/ingest/state.ts`
-- 的一段註解裡，而註解攔不住 INSERT。
CREATE TRIGGER trg_note_needs_item_node
BEFORE INSERT ON note
WHEN (SELECT kind FROM item WHERE id = NEW.id) IS NOT 'note'
BEGIN
  SELECT RAISE(ABORT, 'NOTE_TARGET_MISSING');
END;

-- 「這個專題有哪些點註對不上原文」是閱讀器與整批重算之後都要問的一句話。
CREATE INDEX idx_note_anchor ON note(anchor_ok);
