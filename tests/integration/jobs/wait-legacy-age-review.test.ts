import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { initTestJob } from '#tests/helpers/session.js';

function scenario(pruneUnrelatedProgress: boolean) {
  const f = createTerminalExportFixture('provider', true);
  try {
    initTestJob(f.store, {
      jobId: 'job-2',
      sessionId: 'session-2',
      provider: 'claude',
      projectRoot: f.root,
      backendNamespace: 'fixture',
    });
    f.store.appendProgress('job-2', 'session-2', 'another job, later pruned by journal-progress retention');
    const seq = f.complete();

    const stored = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete stored.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(stored));

    rmSync(f.resultPath, { force: true });
    if (pruneUnrelatedProgress)
      f.db.prepare("DELETE FROM events WHERE stream_id = 'job-2' AND type = 'job.progress.emitted'").run();

    const location = f.index.read(f.jobId)!;
    if (location.detail.kind !== 'recorded') throw new Error('detail');
    f.index.recordTerminal(f.jobId, location.detail.value, f.resultPath, seq, f.db);
    const saved = (JSON.parse(readFileSync(f.locationPath, 'utf8')) as { terminalAge?: { kind: string } }).terminalAge;
    f.advance(30 * 86_400_000);
    return {
      savedAge: saved?.kind,
      eligibility: f.index.terminalEligibility(f.jobId).kind,
      resultDurable: f.index.resultDurable(f.jobId),
      availability: f.store.getResultExportOwner().observeResultAvailability(f.jobId),
    };
  } finally {
    f.close();
  }
}

describe('legacy terminal age after unrelated progress pruning', () => {
  it('proves fresh legacy age despite unrelated progress pruning', () => {
    const control = scenario(false);
    const pruned = scenario(true);

    expect(control.resultDurable).toBe(true);
    expect(pruned.resultDurable).toBe(true);
    expect(pruned.savedAge).toBe('known');
  });
});
