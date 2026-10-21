-- 人工確認的實體型別不得被機器抽取改寫。
ALTER TABLE entity ADD COLUMN type_manual INTEGER NOT NULL DEFAULT 0 CHECK (type_manual IN (0, 1));
