import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it, vi, afterEach } from 'vitest';

import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { TERMINAL_EXPORT_CUTOFF, createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

it('delivers a validated retained terminal ahead of an inconclusive source detail', async () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    const retained = f.index.read(f.jobId);
    if (retained?.detail.kind !== 'recorded') throw new Error('missing retained detail');
    const { JobAddressing } = await import('#src/jobs/addressing.js');
    const observed = {
      ...retained,
      disposition: 'unresolved' as const,
      detail: {
        kind: 'recorded' as const,
        value: {
          ...retained.detail.value,
          exit: null,
          events: [],
          status: { ...retained.detail.value.status, phase: 'running' as const, result: undefined },
        },
      },
    };
    const addressing = new JobAddressing(
      f.index,
      {
        visitProgress: progressVisitFromDetails(() => null),
        epochKey: () => 'active',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'decided',
      () => ({ kind: 'read', dispositions: new Map(), locations: new Map([[f.jobId, observed]]) }),
      (id) => f.store.getResultExportOwner().observeResultAvailability(id),
    );
    expect(addressing.snapshot({ jobIds: [f.jobId] }).jobs[0]).toMatchObject({
      disposition: 'admitted',
      terminal: { outcomeKind: 'completed' },
    });
  } finally {
    f.close();
  }
});

it('keeps a permission-denied terminal source pending until observation recovers', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    const exists = f.runtime.storage.existsSync;
    const stat = f.runtime.storage.lstatSync;
    vi.spyOn(f.runtime.storage, 'existsSync').mockImplementation((path) =>
      path === f.epoch.path ? false : exists(path),
    );
    vi.spyOn(f.runtime.storage, 'lstatSync').mockImplementation(((path: string, options: never) => {
      if (path === f.epoch.path) throw Object.assign(new Error('temporarily inaccessible'), { code: 'EACCES' });
      return stat(path, options);
    }) as typeof stat);
    const owner = f.store.getResultExportOwner();
    expect(owner.observeResultAvailability(f.jobId)).toEqual({ kind: 'pending' });
    vi.restoreAllMocks();
    owner.ensureResultMarkdownArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('proves expiry for a pruned terminal and discharges the absent export', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000, precedingAt: TERMINAL_EXPORT_CUTOFF - 2000 });
    f.db.prepare("DELETE FROM events WHERE type <> 'job.terminal.recorded'").run();
    expect(f.index.terminalEligibility(f.jobId)).toEqual({ source: 'readable', age: 'expired' });
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'retained-away',
    });
    expect(f.index.resultDurable(f.jobId)).toBe(true);
  } finally {
    f.close();
  }
});

const closeFixtures: ReturnType<typeof createTerminalExportFixture>[] = [];
afterEach(() => {
  for (const f of closeFixtures.splice(0)) f.close();
});

it('repairs post-commit terminal recording under a permanent active epoch hold', async () => {
  const f = createTerminalExportFixture('provider', true);
  closeFixtures.push(f);
  commitJobTerminal(f.store, f.jobId, 'session-1', {
    content: 'canonical held result',
    outcome: { kind: 'completed' },
    durationMs: 1,
  });
  f.index.holdUnknownLocations(f.epochKey, 'post-commit recording failed', false);
  const owner = f.store.getResultExportOwner();
  await owner.repairPass([f.jobId], { canContinue: () => true, record: () => {} });
  expect(f.index.read(f.jobId)?.disposition).toBe('terminal');
  expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical held result\n');
});
