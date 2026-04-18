import type BetterSqlite3 from 'better-sqlite3';

import type { Reducer } from '../../append.js';

const TEST_COUNTER_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS projection_test_counter (
  id TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  last_seq INTEGER NOT NULL
);
`;

export function applyTestCounterMigration(db: BetterSqlite3.Database): void {
  db.exec(TEST_COUNTER_MIGRATION_SQL);
}

const tickedReducer: Reducer = (db, event) => {
  const body = event.body as { id: string; delta: number };
  db.prepare(
    [
      'INSERT INTO projection_test_counter (id, value, last_seq)',
      'VALUES (?, ?, ?)',
      'ON CONFLICT(id) DO UPDATE SET',
      '  value = projection_test_counter.value + excluded.value,',
      '  last_seq = excluded.last_seq',
    ].join('\n'),
  ).run(body.id, body.delta, event.seq);
};

export const testCounterRegistry = {
  reducers: {
    'test.counter.ticked': tickedReducer,
  } satisfies Record<string, Reducer>,
};
