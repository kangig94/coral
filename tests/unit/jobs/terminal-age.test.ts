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
      expect(readIntactJobTerminalAge(f.db, terminal, TERMINAL_EXPORT_CUTOFF)).toBe(TERMINAL_EXPORT_CUTOFF - 1000);
    }
    expect(prepare.mock.calls.some(([sql]) => /COUNT\s*\(/i.test(sql))).toBe(false);
    expect(prepare.mock.calls).toHaveLength(20);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});
