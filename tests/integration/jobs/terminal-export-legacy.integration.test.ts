import { it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createTerminalExportFixture,
  TERMINAL_EXPORT_CUTOFF,
  TERMINAL_EXPORT_NOW,
} from '#tests/helpers/terminal-export.js';

for (const variant of ['zero-byte', 'missing-file-in-dir', 'absent-dir'] as const) {
  it(`expired terminal, ${variant}`, async () => {
    const f = createTerminalExportFixture('provider', true);
    try {
      f.complete({ terminalAt: TERMINAL_EXPORT_NOW - 20 * 86_400_000 });
      rmSync(dirname(f.resultPath), { recursive: true, force: true });
      if (variant !== 'absent-dir') mkdirSync(dirname(f.resultPath), { recursive: true });
      if (variant === 'zero-byte') writeFileSync(f.resultPath, '');
      f.index.certify(f.epochKey, 1000);
      const owner = f.store.getResultExportOwner();
      expect(owner.observeResultAvailability(f.jobId).kind).toBe('retained-away');
      owner.ensureResultMarkdownArtifact(f.jobId);
      // a maintenance repair pass
      const outcomes: unknown[] = [];
      await owner.repairPass([f.jobId], {
        canContinue: (() => {
          let n = 0;
          return () => n++ < 3;
        })(),
        record: (o: unknown) => outcomes.push(o),
      } as never);
      expect(f.index.certify(f.epochKey, 1000)).not.toBeNull();
      expect(f.index.terminalEligibility(f.jobId).age).toBe('expired');
      expect(f.index.resultDurable(f.jobId)).toBe(true);
      expect(f.index.resultsReleased(f.epochKey)).toBe(true);
      expect(existsSync(f.resultPath)).toBe(variant === 'zero-byte');
      if (variant === 'zero-byte') expect(readFileSync(f.resultPath)).toHaveLength(0);
    } finally {
      f.close();
    }
  });
}

it('never discharges a regressed terminal by age: only its published file retires it', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000, precedingAt: TERMINAL_EXPORT_CUTOFF - 500 });
    rmSync(dirname(f.resultPath), { recursive: true, force: true });
    // The newest earlier row only bounds the terminal's real time from below, so its expiry cannot be proven.
    expect(f.index.terminalEligibility(f.jobId)).toEqual({ source: 'readable', age: 'unknown' });
    expect(f.index.resultDurable(f.jobId)).toBe(false);
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(true);
    expect(f.index.resultDurable(f.jobId)).toBe(true);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe('available');
  } finally {
    f.close();
  }
});
