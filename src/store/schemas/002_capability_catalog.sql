CREATE TABLE IF NOT EXISTS expansion_manifest_catalog (
  id            TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

UPDATE meta SET value = '2' WHERE key = 'schema_version';
