CREATE TABLE IF NOT EXISTS projection_test_counter (
  id       TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0,
  last_seq INTEGER NOT NULL DEFAULT 0
);
