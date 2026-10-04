import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { initTestJob } from '#tests/helpers/session.js';
import { TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

import { trustedJobRetentionCutoff } from '#src/jobs/retention-clock.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { TerminalResultExportOwner } from '#src/jobs/terminal/export.js';
import { createStorageRetentionScheduler } from '#src/coordinator/composition/storage-retention-scheduler.js';

{
  describe('legacy unknown-age terminal with a pruned export', () => {
    it('releases an unknown-age legacy terminal without recreating its export directory', () => {
      const f = createTerminalExportFixture('provider');
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
          f.db,
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
      const saved = (
        JSON.parse(readFileSync(f.locationPath, 'utf8')) as {
          terminalAge?: {
            kind: string;
          };
        }
      ).terminalAge;
      f.advance(30 * 86400000);
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
}
{
  const fixtures: ReturnType<typeof createTerminalExportFixture>[] = [];
  afterEach(() => {
    for (const f of fixtures.splice(0)) f.close();
  });
  describe('fresh terminal whose post-commit recording did not run, in a store with any pruned journal row', () => {
    it('publishes a fresh terminal recovered after unrelated pruning', () => {
      const f = createTerminalExportFixture('provider');
      fixtures.push(f);
      f.db
        .prepare('INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, ?, ?, ?, ?)')
        .run(
          new Date(f.runtime.time.now()).toISOString(),
          'fixture.pruned',
          'workflow',
          'unrelated',
          Buffer.from('{}'),
        );
      f.db
        .prepare('INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, ?, ?, ?, ?)')
        .run(new Date(f.runtime.time.now()).toISOString(), 'fixture.kept', 'workflow', 'unrelated', Buffer.from('{}'));
      f.db.prepare("DELETE FROM events WHERE type = 'fixture.pruned'").run();
      const seq = commitJobTerminal(f.store, f.jobId, 'session-1', {
        content: 'fresh result',
        outcome: { kind: 'completed' },
        durationMs: 1,
      });
      const detail = f.store.loadJobProjectionDetail(f.jobId);
      if (!detail.status) throw new Error('no status');
      f.index.recordTerminal(
        f.jobId,
        {
          status: detail.status,
          events: f.store.readJobEvents(f.jobId),
          exit: detail.exit,
          readiness: deriveLaunchReadiness(detail),
        },
        f.resultPath,
        seq,
        f.db,
      );
      f.store.ensureResultArtifact(f.jobId);
      f.advance(30 * 86400000);
      expect(existsSync(f.resultPath)).toBe(true);
      expect(f.index.read(f.jobId)?.terminalAge).toMatchObject({ kind: 'known' });
      expect(f.index.resultDurable(f.jobId)).toBe(true);
    });
  });
}
{
  it('publishes after accumulated second-scale steps across a quiet job run (clock-step-coordinator and quiet-trip probes)', () => {
    const f = createTerminalExportFixture();
    try {
      trustedJobRetentionCutoff(f.runtime);
      for (let i = 0; i < 8; i++) {
        f.advance(35000);
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
      f.jump(86400000);
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
  it('reports a failed publication until its scheduled repair succeeds', async () => {
    const f = createTerminalExportFixture();
    try {
      f.complete();
      const owner = f.store.getResultExportOwner();
      const wake = vi.fn();
      owner.onRepairHint(wake);
      const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValueOnce(false);
      expect(() => owner.publishTerminalResult(f.jobId)).toThrow();
      expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
        kind: 'failed',
        cause: 'repair-failed',
        retryScheduled: true,
      });
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
      f.jump(-86400000);
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
      expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
        kind: 'repair-pending',
        ageUncertain: true,
      });
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
  it('observes absence before calling an unregistered historical source retired', async () => {
    const f = createTerminalExportFixture();
    try {
      const { readHistoricalSource } = await import('#src/jobs/historical-reader.js');
      expect(readHistoricalSource(f.index.readOnlyView(), f.epochKey, [f.jobId])).toEqual({
        kind: 'unreadable',
        retired: true,
      });
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
  it('keeps repair pending through a large clock step and coalesces repair hints', async () => {
    const f = createTerminalExportFixture();
    try {
      f.complete();
      const owner = f.store.getResultExportOwner();
      const wake = vi.fn();
      owner.onRepairHint(wake);
      f.jump(86400000);
      expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
      owner.hintRepair(f.jobId);
      owner.hintRepair(f.jobId);
      expect(wake).toHaveBeenCalledTimes(1);
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
      expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
        kind: 'repair-pending',
        ageUncertain: true,
      });
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
        f.advance(35000);
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
}
{
  describe('repair hint consumed by a run that starts in an untrusted-clock window', () => {
    it('retries a skipped owner promptly and wakes on repeated hints', async () => {
      const f = createTerminalExportFixture('provider');
      try {
        f.complete();
        const timers: Array<{
          fn: () => void;
          ms: number;
        }> = [];
        const runtime = {
          ...f.runtime,
          time: {
            ...f.runtime.time,
            setTimeout: (fn: () => void, ms: number) => {
              const t = { fn, ms, unref() {} };
              timers.push(t);
              return t as never;
            },
            clearTimeout: (t: unknown) => {
              const i = timers.indexOf(t as never);
              if (i >= 0) timers.splice(i, 1);
            },
          },
        };
        const logs: string[] = [];
        const scheduler = createStorageRetentionScheduler({
          runtime: runtime as never,
          getProgressStore: () => f.store as never,
          openEpoch: () => f.epoch as never,
          activeEpochKey: () => f.epochKey,
          jobLocations: f.index,
          log: (m) => logs.push(m.trim()),
          publish: () => {},
          cleanupScratch: () => {},
        });
        scheduler.start();
        const fire = async () => {
          const t = timers.shift();
          t?.fn();
          for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
        };
        await fire();
        rmSync(f.resultPath, { force: true });
        f.jump(86400000);
        const owner = f.store.getResultExportOwner();
        expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
        owner.hintRepair(f.jobId);
        await fire();
        expect(existsSync(f.resultPath)).toBe(false);
        expect(timers.some((t) => t.ms <= 1000)).toBe(true);
        f.advance(5000);
        for (let i = 0; i < 5; i++) owner.hintRepair(f.jobId);
        f.advance(1001);
        expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
        owner.hintRepair(f.jobId);
        await fire();
        expect(existsSync(f.resultPath)).toBe(true);
        await scheduler.stop();
      } finally {
        f.close();
      }
    });
  });
}

it('unknown-age discharge requires an observed source and cannot use a failed read', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    const location = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete location.terminalAge;
    f.db.prepare("UPDATE events SET ts = 'unparseable' WHERE type = 'job.launch.requested'").run();
    writeFileSync(f.locationPath, JSON.stringify(location));
    expect(f.index.resultDurable(f.jobId)).toBe(true);
    const open = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync').mockImplementation(() => {
      throw new Error('busy source');
    });
    expect(f.index.resultDurable(f.jobId)).toBe(false);
    open.mockRestore();
    expect(f.index.resultDurable(f.jobId)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    f.close();
  }
});

it('proves a legacy terminal older than cutoff after unrelated predecessor rows were pruned without a full count', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1000, precedingAt: TERMINAL_EXPORT_CUTOFF - 2000 });
    const location = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete location.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(location));
    f.db.prepare("DELETE FROM events WHERE type <> 'job.terminal.recorded'").run();
    const eligibility = f.index.terminalEligibility(f.jobId);
    expect(eligibility.kind).toBe('expired');
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe('retained-away');
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

it('leaves an untrusted hydration capture absent so a later trusted owner can recapture it', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    const legacy = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete legacy.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(legacy));
    f.index.markUncertified(f.jobId);
    f.index.terminalEligibility(f.jobId);
    f.jump(120_000);
    f.store.ensureResultArtifact(f.jobId);
    expect(JSON.parse(readFileSync(f.locationPath, 'utf8')).terminalAge).toBeUndefined();
    f.advance(5_000);
    f.store.ensureResultArtifact(f.jobId);
    expect(JSON.parse(readFileSync(f.locationPath, 'utf8')).terminalAge.kind).toBe('known');
    expect(existsSync(f.resultPath)).toBe(true);
  } finally {
    f.close();
  }
});

it('cannot discharge an absent legacy directory while the cutoff is untrusted', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    f.complete();
    const legacy = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete legacy.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(legacy));
    f.index.terminalEligibility(f.jobId);
    f.jump(120_000);
    expect(f.index.resultDurable(f.jobId)).toBe(false);
  } finally {
    f.close();
  }
});
