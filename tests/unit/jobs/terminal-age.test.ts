import { expect, it } from 'vitest';
import { readJobTerminalAge } from '#src/jobs/terminal-age.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { ensureRetentionIndexes } from '#src/store/retention-indexes.js';
import type { EventsRow } from '#src/store/schema.js';

it('reads a terminal age on a store opened before its retention indexes were installed', () => {
  const db = newRawDatabase(':memory:');
  try {
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    ensureRetentionIndexes(db);
    db.exec('DROP INDEX events_retention_stream; DROP INDEX events_retention_age');
    const insert = db.prepare(
      "INSERT INTO events (seq, ts, type, stream_kind, stream_id, body) VALUES (?, ?, ?, 'job', 'job-1', '{}')",
    );
    insert.run(1, '2026-10-01T00:00:00.000Z', 'job.launch.requested');
    insert.run(2, '2026-10-01T00:00:01.000Z', 'job.terminal.recorded');
    const terminal = db.prepare<[], EventsRow>('SELECT * FROM events WHERE seq = 2').get()!;
    expect(readJobTerminalAge(db, terminal)).toBe(Date.parse('2026-10-01T00:00:01.000Z'));
  } finally {
    db.close();
  }
});
