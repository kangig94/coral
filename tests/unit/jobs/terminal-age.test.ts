import { expect, it, vi } from 'vitest';
import { readIntactJobTerminalAge } from '#src/jobs/terminal-age.js';
import { readAcceptedTerminal } from '#src/jobs/terminal/source.js';
import { createTerminalExportFixture, TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';

it('checks only the job predecessors and never counts the full journal when evaluating legacy age', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000, precedingAt: TERMINAL_EXPORT_CUTOFF - 2000 });
    const terminal = readAcceptedTerminal(f.db, f.jobId);
    if (!terminal) throw new Error('missing accepted terminal');
    const prepare = vi.spyOn(f.db, 'prepare');
    for (let evaluation = 0; evaluation < 20; evaluation++) {
      expect(readIntactJobTerminalAge(f.db, terminal, TERMINAL_EXPORT_CUTOFF)).toBe('unknown');
    }
    expect(prepare.mock.calls.some(([sql]) => /COUNT\s*\(/i.test(sql))).toBe(false);
    expect(prepare.mock.calls).toHaveLength(20);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('uses the logical-stream index even before retention indexes were installed', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    f.db.exec('DROP INDEX events_retention_stream; DROP INDEX events_retention_age');
    const prepare = vi.spyOn(f.db, 'prepare');
    const terminal = readAcceptedTerminal(f.db, f.jobId)!;
    readIntactJobTerminalAge(f.db, terminal, TERMINAL_EXPORT_CUTOFF);
    const queries = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    for (const sql of queries) {
      const plan = f.db
        .prepare('EXPLAIN QUERY PLAN ' + sql)
        .all(...(sql.includes('seq <') ? [f.jobId, terminal.seq] : [f.jobId]));
      expect(JSON.stringify(plan)).toContain('events_logical_stream');
    }
  } finally {
    f.close();
  }
});

import { readJobTerminalAge } from '#src/jobs/terminal-age.js';

it.each(['known', 'no predecessor', 'bad terminal', 'bad predecessor', 'regression', 'untrusted cutoff'])(
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
      const result =
        scenario === 'untrusted cutoff' ? readIntactJobTerminalAge(f.db, row, null) : readJobTerminalAge(f.db, row);
      expect(result).toBe(
        scenario === 'regression'
          ? 'regression'
          : scenario.startsWith('bad') || scenario === 'untrusted cutoff'
            ? 'unknown'
            : Date.parse(row.ts),
      );
    } finally {
      f.close();
    }
  },
);

it('backfill records unknown when older predecessors could have been pruned', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000 });
    const terminal = readAcceptedTerminal(f.db, f.jobId)!;
    f.db.prepare('DELETE FROM events WHERE stream_id = ? AND seq < ?').run(f.jobId, terminal.seq);
    expect(readIntactJobTerminalAge(f.db, terminal, TERMINAL_EXPORT_CUTOFF)).toBe('unknown');
  } finally {
    f.close();
  }
});
