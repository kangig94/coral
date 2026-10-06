import { progressVisitFromDetails } from '#tests/helpers/wait-progress.js';
import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { initTestJob } from '#tests/helpers/session.js';
import { TERMINAL_EXPORT_CUTOFF, createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

import { TerminalResultExportOwner } from '#src/jobs/terminal/export.js';

{
  describe('expired terminal with a pruned export', () => {
    it('releases an expired terminal without recreating its export directory', () => {
      const f = createTerminalExportFixture('provider', true);
      try {
        f.complete();
        f.store.publishTerminalResult(f.jobId);
        initTestJob(f.store, {
          jobId: 'legacy',
          sessionId: 'legacy',
          provider: 'claude',
          projectRoot: f.root,
          backendNamespace: 'fixture',
        });
        f.db.prepare('DELETE FROM events WHERE seq = 1').run();
        const seq = commitJobTerminal(f.store, 'legacy', 'legacy', {
          content: 'legacy result',
          outcome: { kind: 'completed' },
          durationMs: 1,
        });
        const d = f.store.loadJobProjectionDetail('legacy');
        if (!d.status) throw new Error('no status');
        f.advance(30 * 86400000);
        f.index.recordTerminal(
          'legacy',
          {
            status: d.status,
            events: f.store.readJobEvents('legacy'),
            exit: d.exit,
            readiness: deriveLaunchReadiness(d),
          },
          f.index.resultPathFor('legacy'),
          seq,
        );
        const high = (
          f.db.prepare("SELECT MAX(seq) AS s FROM events WHERE stream_kind = 'job'").get() as {
            s: number;
          }
        ).s;
        expect(f.index.certify(f.epochKey, high)?.jobIds).toEqual([f.jobId, 'legacy']);
        expect(existsSync(f.index.resultPathFor('legacy'))).toBe(false);
        expect(f.index.resultsReleased(f.epochKey)).toBe(true);
        f.advance(400 * 86400000);
        const sync = vi.spyOn(f.runtime.storage, 'syncDirectoryDurableSync');
        for (let sweep = 0; sweep < 3; sweep++) expect(f.index.resultsReleased(f.epochKey)).toBe(true);
        expect(sync).not.toHaveBeenCalled();
        expect(existsSync(f.index.resultPathFor('legacy'))).toBe(false);
      } finally {
        f.close();
      }
    });
  });
}
{
  it('keeps a failed publication pending until its scheduled repair succeeds', async () => {
    const f = createTerminalExportFixture();
    try {
      f.complete();
      const owner = f.store.getResultExportOwner();
      const wake = vi.fn();
      owner.onRepairHint(wake);
      const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValueOnce(false);
      expect(() => owner.publishTerminalResult(f.jobId)).toThrow();
      expect(owner.observeResultAvailability(f.jobId)).toEqual({ kind: 'pending' });
      expect(wake).toHaveBeenCalled();
      write.mockRestore();
      await owner.repairPass([], { canContinue: () => true, record: () => {} });
      expect(existsSync(f.resultPath)).toBe(true);
    } finally {
      vi.restoreAllMocks();
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
      expect(owner.observeResultAvailability(f.jobId)).toEqual({ kind: 'pending' });
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
  it('observes absence before calling an unregistered historical source retired', async () => {
    const f = createTerminalExportFixture();
    try {
      const { readHistoricalSource } = await import('#src/jobs/historical-reader.js');
      expect(readHistoricalSource(f.index.readOnlyView(), f.epochKey, [f.jobId])).toMatchObject({
        kind: 'unreadable',
        retired: true,
      });
    } finally {
      f.close();
    }
  });
  it('opens a provider source once for availability', () => {
    const f = createTerminalExportFixture('provider', true);
    try {
      f.complete();
      const owner = f.store.getResultExportOwner();
      const open = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync');
      expect(owner.observeResultAvailability(f.jobId)).toEqual({ kind: 'pending' });
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
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
}

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

it('does not re-record a verified terminal when its result file is already available', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    mkdirSync(dirname(f.resultPath), { recursive: true });
    writeFileSync(f.resultPath, 'canonical result\n');
    const record = vi.spyOn(f.index, 'recordTerminal').mockImplementation(() => {
      throw new Error('verified terminal must not be recorded again');
    });
    expect(f.store.ensureResultArtifact(f.jobId)).toBe(f.resultPath);
    expect(record).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
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
