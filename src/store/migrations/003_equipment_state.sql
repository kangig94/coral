CREATE TABLE IF NOT EXISTS equipment_state (
  name               TEXT PRIMARY KEY,
  state              TEXT NOT NULL,
  installed_at       TEXT,
  last_error_code    TEXT,
  last_error_message TEXT
);

UPDATE meta
   SET value = '3'
 WHERE key = 'schema_version';
