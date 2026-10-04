import { existsSync, rmSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { trustedJobRetentionCutoff } from '#src/jobs/retention-clock.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { TerminalResultExportOwner } from '#src/jobs/terminal/export.js';

it('publishes after accumulated second-scale steps across a quiet job run (clock-step-coordinator and quiet-trip probes)', () => {
  const f = createTerminalExportFixture();
  try {
    trustedJobRetentionCutoff(f.runtime);
    for (let i = 0; i < 8; i++) {
      f.advance(35_000);
      f.jump(3000);
    }
    f.complete();
    f.store.publishTerminalResult(f.jobId);
    f.advance(200);
    expect(existsSync(f.resultPath)).toBe(true);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe('available');
  } finally {
    f.close();
  }
});

it('exempts first post-commit publication but keeps repair pending until a large-step window ends', async () => {
  const f = createTerminalExportFixture();
  try {
    trustedJobRetentionCutoff(f.runtime);
    f.jump(86_400_000);
    const seq = f.complete();
    f.store.getResultExportOwner().publishTerminalResult(f.jobId, seq);
    expect(existsSync(f.resultPath)).toBe(true);
    rmSync(f.resultPath);
    const owner = f.store.getResultExportOwner();
    const wake = vi.fn();
    owner.onRepairHint(wake);
    const availability = owner.observeResultAvailability(f.jobId);
    expect(availability.kind).toBe('repair-pending');
    const location = f.index.read(f.jobId);
    if (location?.detail.kind !== 'recorded') throw new Error('missing terminal');
    const admission = {
      jobId: f.jobId,
      disposition: 'admitted' as const,
      epochKey: f.epochKey,
      detail: location.detail.value,
      availability,
    };
    const session = new WaitSession([f.jobId]);
    session.reconcile([admission]);
    session.acknowledge(admission);
    expect(session.remaining()).toEqual([f.jobId]);
    expect(session.artifactPending(f.jobId)).toBe(true);
    owner.hintRepair(f.jobId);
    owner.ensureResultMarkdownArtifact(f.jobId);
    expect(wake).toHaveBeenCalled();
    expect(existsSync(f.resultPath)).toBe(false);
    f.advance(1001);
    await owner.repairPass([f.jobId], { canContinue: () => true, record: () => {} });
    expect(existsSync(f.resultPath)).toBe(true);
  } finally {
    f.close();
  }
});

it('keeps a failed publication pending through a scheduled repair', async () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    const owner = f.store.getResultExportOwner();
    const wake = vi.fn();
    owner.onRepairHint(wake);
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValueOnce(false);
    expect(() => owner.publishTerminalResult(f.jobId)).toThrow();
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
    expect(wake).toHaveBeenCalled();
    write.mockRestore();
    await owner.repairPass([], { canContinue: () => true, record: () => {} });
    expect(existsSync(f.resultPath)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('publishes a newly appended terminal after a backwards clock step', () => {
  const f = createTerminalExportFixture();
  try {
    trustedJobRetentionCutoff(f.runtime);
    f.jump(-86_400_000);
    const seq = f.complete();
    f.store.getResultExportOwner().publishTerminalResult(f.jobId, seq);
    expect(existsSync(f.resultPath)).toBe(true);
  } finally {
    f.close();
  }
});

it('distinguishes transient source read failure from source retirement', () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    let unreadable = true;
    const owner = new TerminalResultExportOwner({
      runtime: f.runtime,
      jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
      location: (id) => f.index.read(id),
      withSource: (_id, read) => {
        if (unreadable) throw new Error('locked');
        return read(f.db, f.store);
      },
    });
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
    unreadable = false;
    owner.ensureResultMarkdownArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(true);
  } finally {
    f.close();
  }
});

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
        epochKey: () => 'active',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        waitStream: async function* () {},
      },
      () => false,
      () => 'decided',
      () => ({ kind: 'read', locations: new Map([[f.jobId, observed]]) }),
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

it('does not call an unregistered historical source retired', async () => {
  const f = createTerminalExportFixture();
  try {
    const { readHistoricalSource } = await import('#src/jobs/historical-reader.js');
    expect(readHistoricalSource(f.index.readOnlyView(), f.epochKey, [f.jobId])).toEqual({ kind: 'unreadable' });
  } finally {
    f.close();
  }
});

it('opens a provider source once for availability and uses saved age for progress retention', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    const owner = f.store.getResultExportOwner();
    const open = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync');
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
    expect(owner.progressRetentionExpired(f.jobId)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('keeps repair pending through a large clock step and wakes repeated repair hints', async () => {
  const f = createTerminalExportFixture();
  try {
    f.complete();
    const owner = f.store.getResultExportOwner();
    const wake = vi.fn();
    owner.onRepairHint(wake);
    f.jump(86_400_000);
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
    owner.hintRepair(f.jobId);
    owner.hintRepair(f.jobId);
    expect(wake).toHaveBeenCalledTimes(2);
    f.advance(1001);
    await owner.repairPass([], { canContinue: () => true, record: () => {} });
    expect(existsSync(f.resultPath)).toBe(true);
  } finally {
    f.close();
  }
});

it('keeps an inaccessible protected terminal source pending until observation recovers', () => {
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
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
    vi.restoreAllMocks();
    owner.ensureResultMarkdownArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('does not treat accumulated drift across an hours-old sample as one clock step', () => {
  const f = createTerminalExportFixture();
  try {
    trustedJobRetentionCutoff(f.runtime);
    for (let i = 0; i < 400; i++) {
      f.advance(35_000);
      f.jump(3000);
    }
    expect(trustedJobRetentionCutoff(f.runtime)).not.toBeNull();
    f.complete();
    f.store.publishTerminalResult(f.jobId);
    expect(existsSync(f.resultPath)).toBe(true);
  } finally {
    f.close();
  }
});

it('does not keep a nonterminal job on the artifact repair backlog', async () => {
  const f = createTerminalExportFixture();
  try {
    const record = vi.fn();
    await f.store.getResultExportOwner().repairPass([f.jobId], { canContinue: () => true, record });
    expect(record).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
