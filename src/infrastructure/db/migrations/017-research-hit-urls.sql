-- 研究開始時命中的「專題裡已有的」補上網址（ADR-0039 第五節：舊資料升級，不靠讀取時退回空字串）。
-- v1.0.1 起寫入時就帶 `url`（`sourceUrl ?? requestedUrl ?? ''`，找來源的提示詞拿它說「這幾份已經有了」）；
-- 在那之前開的研究沒有這一欄。照同一條規則補；那一份資料已經刪掉的補空字串。
-- 只動「每一筆都是物件、而且至少一筆沒有 url」的那幾列 —— 形狀不對的不碰，讀取那一層本來就會略過。
UPDATE research
SET hits_json = (
  SELECT json_group_array(
           json_set(h.value, '$.url', COALESCE(i.source_url, i.requested_url, ''))
           ORDER BY h.key)
  FROM json_each(research.hits_json) AS h
  LEFT JOIN item AS i ON i.id = json_extract(h.value, '$.itemId')
)
WHERE json_valid(hits_json)
  AND json_type(hits_json) = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(research.hits_json) AS h WHERE h.type != 'object')
  AND EXISTS (
    SELECT 1 FROM json_each(research.hits_json) AS h WHERE json_type(h.value, '$.url') IS NULL
  );
