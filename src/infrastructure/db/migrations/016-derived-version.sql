-- 這個專題的正文（derived／索引／引文／點註）上一次升級做到第幾版抽取器（ADR-0039 第五節）。
-- 0 ＝ 還沒做過：v1.1.0 第一次碰到這個專題時由 App 升級（`application/case-upgrade.ts`），做完寫成 `EXTRACTOR_VERSION`。
ALTER TABLE "case" ADD COLUMN derived_version INTEGER NOT NULL DEFAULT 0 CHECK (derived_version >= 0);
