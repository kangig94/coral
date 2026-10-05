import { readFileSync, writeFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, it } from 'vitest';
import { createTerminalExportFixture, TERMINAL_EXPORT_NOW } from '#tests/helpers/terminal-export.js';
import { recoverJobLocations } from '#src/jobs/location-recovery.js';
import { pruneJobExports, readExportJobState } from '#src/jobs/export-retention.js';
import { trustedJobRetentionCutoff } from '#src/jobs/retention-clock.js';

it('legacy expired export in the active epoch after a compatible upgrade', async () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const terminalAt = TERMINAL_EXPORT_NOW - 20 * 86_400_000;
    f.complete({ terminalAt });
    // Simulate a v0.10.16/17 location record: no terminalAge field.
    const stored = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete stored.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(stored) + '\n');
    // The released build left its export behind (v0.10.16 has no export retention).
    mkdirSync(dirname(f.resultPath), { recursive: true });
    writeFileSync(f.resultPath, 'legacy result\n');
    const old = new Date(terminalAt);
    utimesSync(f.resultPath, old, old);
    utimesSync(dirname(f.resultPath), old, old);
    // First start of this build on the compatible (same) active epoch.
    recoverJobLocations(f.index, f.epochKey, f.store);
    const after = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    expect(after.terminalAge).toMatchObject({ kind: 'known', terminalAt });

    const eligibility = f.index.exportDeletionEligibility(f.jobId);

    const outcomes: unknown[] = [];
    const cutoff = trustedJobRetentionCutoff(f.runtime)!;
    await pruneJobExports({
      db: f.db as never,
      runtime: f.runtime as never,
      cutoff,
      afterId: '',
      budget: { record: (o) => outcomes.push(o), canContinue: () => true, canMutate: () => true },
      jobState: (id) => readExportJobState(f.db as never, f.store, id),
      resultHold: (id) => f.index.exportResultRetention(id, f.epochKey),
      mutate: (op) => op(),
      eligibility: (id) => f.index.exportDeletionEligibility(id),
    });

    expect(eligibility?.kind).toBe('expired');
    expect(existsSync(f.resultPath)).toBe(false);
  } finally {
    f.close();
  }
});
