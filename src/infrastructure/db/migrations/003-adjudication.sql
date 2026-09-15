-- Cyclosa schema v3 —— 關聯與出處
--
-- 欄位與值域的權威是 docs/architecture/data-model.md。**改這裡就要改那一份。**
--
-- 這一版**沒有新欄位也沒有新表** —— `edge`／`edge_evidence`／`edge_audit`
-- 在 v1 就建好了。加的是兩條約束與兩個索引，而它們全部來自
-- 「真的動手寫寫入路徑」那一天才看得到的東西。

-- ══ open-questions Q6 的答案 ═════════════════════════════
--
-- **問題**：非 `named` 層的邊，`status` 欄該寫什麼？
--
-- **不加第四個值（`n/a`）**，兩個理由：
--
-- 1. `DEFAULT_FILTERS.statuses` 是 `['pending','confirmed']`。多一個值
--    就會讓**全部的共同提及與相似度線在預設篩選下整批消失** ——
--    而那是一個沒有人會想到要去改篩選才能解釋的空畫面。
-- 2. 那件事**已經從 `layer` 推得出來**（`requiresAdjudication`）。
--    同一個事實存兩個地方，遲早會有一個地方是錯的。
--
-- **改成把「不適用」變成一條約束**：機器建的非 `named` 邊只能是 `pending`。
-- 於是那一欄在那些列上永遠是同一個值，**它不帶資訊，也就不會誤導**。
--
-- 而「能不能裁決」由 `mayAdjudicate` 判斷，判準是
-- **「這條邊會不會被重算蓋掉」**，不是層別 —— 見 domain/graph/edge-state.ts。

CREATE TRIGGER trg_edge_machine_nonnamed_pending_ins
BEFORE INSERT ON edge
WHEN NEW.origin = 'machine' AND NEW.layer <> 'named' AND NEW.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_LAYER_NOT_ADJUDICABLE');
END;

CREATE TRIGGER trg_edge_machine_nonnamed_pending_upd
BEFORE UPDATE OF status ON edge
WHEN NEW.origin = 'machine' AND NEW.layer <> 'named' AND NEW.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_LAYER_NOT_ADJUDICABLE');
END;

-- ══ 稽核紀錄只增不刪 ═════════════════════════════════════
--
-- data-model 寫著「**只增不刪**」，而在 v1 那句話只是一句話。
-- 校準比例（ADR-0017）採計的是每條邊的**最新判定** ——
-- 一列被改掉的稽核紀錄會讓那個比例安靜地變成另一個數字，
-- 而使用者沒有任何辦法發現。

CREATE TRIGGER trg_edge_audit_append_only_upd
BEFORE UPDATE ON edge_audit
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_AUDIT_APPEND_ONLY');
END;

CREATE TRIGGER trg_edge_audit_append_only_del
BEFORE DELETE ON edge_audit
-- ⚠️ 例外：邊自己被刪掉時，`ON DELETE CASCADE` 會連帶刪它的稽核紀錄。
--    那不是竄改。判別方式是「那條邊還在不在」——
--    還在就是有人單獨刪紀錄，不在就是 cascade。
WHEN EXISTS (SELECT 1 FROM edge WHERE id = OLD.edge_id)
BEGIN
  SELECT RAISE(ABORT, 'GRAPH_AUDIT_APPEND_ONLY');
END;

-- ══ 兩個索引 ═════════════════════════════════════════════

-- 裁決佇列：`layer='named' AND status='pending'`，依可信度排序。
-- v1 的 idx_edge_layer_status 只到 (layer, status)，排序仍然要掃一遍 ——
-- 20 萬條邊時那是佇列每次開啟都要付的代價。
CREATE INDEX idx_edge_queue ON edge(layer, status, confidence DESC);

-- 校準比例要把 edge_audit 折成「每條邊最新一列」。
-- v1 的 idx_audit_edge_at 是 (edge_id, at DESC)，適合查**單一條邊**的歷史；
-- 這一個是給「全專題掃一遍」用的。
CREATE INDEX idx_audit_actor_at ON edge_audit(actor, at DESC);
