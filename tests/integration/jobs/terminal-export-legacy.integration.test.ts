import { it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTerminalExportFixture, TERMINAL_EXPORT_NOW } from '#tests/helpers/terminal-export.js';

for (const variant of ['zero-byte', 'missing-file-in-dir', 'absent-dir'] as const) {
  it(`legacy expired terminal, ${variant}`, async () => {
    const f = createTerminalExportFixture('provider', true);
    try {
      f.complete({ terminalAt: TERMINAL_EXPORT_NOW - 20 * 86_400_000 });
      const stored = JSON.parse(readFileSync(f.locationPath, 'utf8'));
      delete stored.terminalAge; // record as written by v0.10.16-18
      writeFileSync(f.locationPath, JSON.stringify(stored) + '\n');
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
      expect(f.index.exportDeletionEligibility(f.jobId)?.kind).toBe('expired');
      expect(f.index.resultDurable(f.jobId)).toBe(true);
      expect(f.index.resultsReleased(f.epochKey)).toBe(true);
      expect(existsSync(f.resultPath)).toBe(variant === 'zero-byte');
      if (variant === 'zero-byte') expect(readFileSync(f.resultPath)).toHaveLength(0);
    } finally {
      f.close();
    }
  });
}
