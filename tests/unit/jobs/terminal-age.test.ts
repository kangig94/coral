import { expect, it, vi } from 'vitest';
import { readJobTerminalAge } from '#src/jobs/terminal-age.js';
import { readAcceptedTerminal } from '#src/jobs/terminal/source.js';
import { createTerminalExportFixture, TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { ensureRetentionIndexes } from '#src/store/retention-indexes.js';
import type { EventsRow } from '#src/store/schema.js';

it('checks only the job predecessors and never counts the full journal when evaluating legacy age', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000, precedingAt: TERMINAL_EXPORT_CUTOFF - 2000 });
    const terminal = readAcceptedTerminal(f.db, f.jobId);
    if (!terminal) throw new Error('missing accepted terminal');
    const prepare = vi.spyOn(f.db, 'prepare');
    for (let evaluation = 0; evaluation < 20; evaluation++) {
      expect(readJobTerminalAge(f.db, terminal)).toBe(TERMINAL_EXPORT_CUTOFF - 1000);
    }
    expect(prepare.mock.calls.some(([sql]) => /COUNT\s*\(/i.test(sql))).toBe(false);
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(2);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

/** The predecessor read readJobTerminalAge prepares on a fresh connection, as SQLite plans it there. */
function predecessorPlan(indexed: boolean): string {
  const db = newRawDatabase(':memory:');
  try {
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    ensureRetentionIndexes(db);
    if (!indexed) db.exec('DROP INDEX events_retention_stream; DROP INDEX events_retention_age');
    const insert = db.prepare(
      "INSERT INTO events (seq, ts, type, stream_kind, stream_id, body) VALUES (?, ?, ?, 'job', 'job-1', '{}')",
    );
    insert.run(1, '2026-10-01T00:00:00.000Z', 'job.launch.requested');
    insert.run(2, '2026-10-01T00:00:01.000Z', 'job.terminal.recorded');
    const terminal = db.prepare<[], EventsRow>('SELECT * FROM events WHERE seq = 2').get()!;
    const prepare = vi.spyOn(db, 'prepare');
    readJobTerminalAge(db, terminal);
    const sql = prepare.mock.calls.map(([text]) => text).find((text) => text.includes('seq < ?'))!;
    prepare.mockRestore();
    return JSON.stringify(db.prepare('EXPLAIN QUERY PLAN ' + sql).all('job-1', terminal.seq));
  } finally {
    db.close();
  }
}

it('reads the newest predecessor through the age index without sorting the job history', () => {
  const plan = predecessorPlan(true);
  expect(plan).toContain('events_retention_age');
  expect(plan).not.toContain('TEMP B-TREE');
});

it('uses the logical-stream index on a store opened before its retention indexes were installed', () => {
  expect(predecessorPlan(false)).toContain('events_logical_stream');
});

it.each(['known', 'no predecessor', 'bad terminal', 'bad predecessor', 'regression'])(
  'classifies terminal age: %s',
  (scenario) => {
    const f = createTerminalExportFixture();
    try {
      f.complete();
      const row = readAcceptedTerminal(f.db, f.jobId)!;
      if (scenario === 'no predecessor')
        f.db.prepare('DELETE FROM events WHERE stream_id = ? AND seq < ?').run(f.jobId, row.seq);
      if (scenario === 'bad terminal') row.ts = 'invalid';
      if (scenario === 'bad predecessor' || scenario === 'regression')
        f.db
          .prepare('UPDATE events SET ts = ? WHERE stream_id = ? AND seq < ?')
          .run(scenario === 'regression' ? '2099-01-01T00:00:00Z' : 'invalid', f.jobId, row.seq);
      expect(readJobTerminalAge(f.db, row)).toBe(
        scenario === 'regression' ? 'regression' : scenario.startsWith('bad') ? 'unknown' : Date.parse(row.ts),
      );
    } finally {
      f.close();
    }
  },
);

it.each([false, true])('proves expiry only for a terminal no earlier row outdates, regression=%s', (regressed) => {
  const f = createTerminalExportFixture();
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000 });
    const terminal = readAcceptedTerminal(f.db, f.jobId)!;
    if (regressed)
      f.db
        .prepare('UPDATE events SET ts = ? WHERE stream_id = ? AND seq < ?')
        .run(new Date(TERMINAL_EXPORT_CUTOFF - 500).toISOString(), f.jobId, terminal.seq);
    else f.db.prepare('DELETE FROM events WHERE stream_id = ? AND seq < ?').run(f.jobId, terminal.seq);
    // A regressed terminal's newest earlier row bounds its real time only from below, so it is never aged by it.
    expect(readJobTerminalAge(f.db, terminal)).toBe(regressed ? 'regression' : TERMINAL_EXPORT_CUTOFF - 1000);
  } finally {
    f.close();
  }
});
