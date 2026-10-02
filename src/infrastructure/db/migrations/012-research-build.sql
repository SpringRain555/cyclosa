ALTER TABLE item ADD COLUMN extracted_at INTEGER;
ALTER TABLE item ADD COLUMN extracted_by TEXT;
ALTER TABLE item ADD COLUMN bib_json TEXT;
ALTER TABLE research_candidate ADD COLUMN decision TEXT CHECK (decision IS NULL OR decision IN ('include', 'reference', 'discard'));
ALTER TABLE research_candidate ADD COLUMN cited_by_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE research_candidate ADD COLUMN build_state TEXT CHECK (build_state IS NULL OR build_state IN ('done', 'failed'));
ALTER TABLE research_candidate ADD COLUMN build_code TEXT;
ALTER TABLE research ADD COLUMN gap_json TEXT;
CREATE TABLE case_notice (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER
);
