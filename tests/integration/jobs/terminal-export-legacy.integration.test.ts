import { it, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createTerminalExportFixture,
  TERMINAL_EXPORT_CUTOFF,
  TERMINAL_EXPORT_NOW,
} from '#tests/helpers/terminal-export.js';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';

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

it('keeps a regressed legacy terminal regressed: its export is kept and age never discharges it', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const seq = f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000, precedingAt: TERMINAL_EXPORT_CUTOFF - 500 });
    const stored = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete stored.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(stored) + '\n');
    rmSync(dirname(f.resultPath), { recursive: true, force: true });
    // The newest earlier row only bounds the terminal's real time from below, so its expiry cannot be proven.
    expect(f.index.terminalEligibility(f.jobId)).toMatchObject({ kind: 'regression', age: 'regression' });
    expect(f.index.resultDurable(f.jobId)).toBe(false);
    const detail = f.store.loadJobProjectionDetail(f.jobId);
    f.index.recordTerminal(
      f.jobId,
      {
        status: detail.status!,
        events: f.store.readJobEvents(f.jobId),
        exit: detail.exit,
        readiness: deriveLaunchReadiness(detail),
      },
      f.index.resultPathFor(f.jobId),
      seq,
      f.db,
    );
    expect(JSON.parse(readFileSync(f.locationPath, 'utf8')).terminalAge).toMatchObject({ kind: 'regression' });
    expect(f.index.terminalEligibility(f.jobId)).toMatchObject({ kind: 'regression', regressionAuthorized: true });
    // Retention keeps a regressed export under its own reason; only the published file can retire the job.
    expect(f.index.exportDeletionEligibility(f.jobId)?.kind).toBe('regression');
    expect(f.index.resultDurable(f.jobId)).toBe(false);
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(true);
    expect(f.index.resultDurable(f.jobId)).toBe(true);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe('available');
  } finally {
    f.close();
  }
});

it.each([
  ['an absent directory', true],
  ['a zero-byte file', true],
  ['a dangling symlink', false],
  ['a directory', false],
  ['an export directory symlinked to an empty directory', false],
  ['a dangling export directory symlink', false],
] as const)('discharges an unknown-age legacy terminal whose result path holds %s: %s', (entry, discharged) => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const seq = f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000 });
    f.db.prepare("UPDATE events SET ts = 'unparseable' WHERE stream_id = ? AND seq < ?").run(f.jobId, seq);
    const stored = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete stored.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(stored) + '\n');
    rmSync(dirname(f.resultPath), { recursive: true, force: true });
    if (entry === 'an export directory symlinked to an empty directory') {
      mkdirSync(`${dirname(f.resultPath)}.elsewhere`, { recursive: true });
      symlinkSync(`${dirname(f.resultPath)}.elsewhere`, dirname(f.resultPath));
    } else if (entry === 'a dangling export directory symlink') {
      mkdirSync(dirname(dirname(f.resultPath)), { recursive: true });
      symlinkSync(`${dirname(f.resultPath)}.missing`, dirname(f.resultPath));
    } else if (entry !== 'an absent directory') mkdirSync(dirname(f.resultPath), { recursive: true });
    if (entry === 'a zero-byte file') writeFileSync(f.resultPath, '');
    if (entry === 'a dangling symlink') symlinkSync(`${f.resultPath}.missing`, f.resultPath);
    if (entry === 'a directory') mkdirSync(f.resultPath);
    expect(f.index.terminalEligibility(f.jobId)).toMatchObject({ age: 'unknown', sourceReadable: true });
    expect(f.index.resultDurable(f.jobId)).toBe(discharged);
  } finally {
    f.close();
  }
});
