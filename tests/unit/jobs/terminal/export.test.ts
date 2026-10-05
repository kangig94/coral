import { renderWorkflowReport } from '#src/workflow/result-report.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { dirname } from 'node:path';
import { WaitSession } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { trustedJobRetentionCutoff } from '#src/jobs/retention-clock.js';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TerminalResultExportOwner,
  type WorkflowReportPort,
  observeTerminalResultExports,
} from '#src/jobs/terminal/export.js';
import { formatResultAvailability } from '#src/cli/format/result-availability.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { deriveLaunchReadiness } from '#src/jobs/launch-readiness.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { initTestJob } from '#tests/helpers/session.js';
import { createTerminalExportFixture, TERMINAL_EXPORT_CUTOFF } from '#tests/helpers/terminal-export.js';

const fixtures: ReturnType<typeof createTerminalExportFixture>[] = [];
function fixture(kind: 'provider' | 'workflow' = 'provider') {
  const f = createTerminalExportFixture(kind);
  fixtures.push(f);
  return f;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) f.close();
});

describe('terminal export owner', () => {
  it('reports failed attempts until a successful retry clears them', async () => {
    const f = fixture();
    f.complete();
    const write = f.runtime.storage.writeAtomicDurableSync;
    const failure = vi
      .spyOn(f.runtime.storage, 'writeAtomicDurableSync')
      .mockImplementation((path, body, options) => (path === f.resultPath ? false : write(path, body, options)));
    const owner = f.store.getResultExportOwner();
    expect(() => owner.publishTerminalResult(f.jobId)).toThrow();
    expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'repair-failed',
      retryScheduled: true,
    });
    failure.mockRestore();
    await owner.repairPass([f.jobId], { canContinue: () => true, record: () => {} });
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('available');
  });

  it('repairs a committed terminal even if recording its location failed', async () => {
    const f = fixture();
    commitJobTerminal(f.store, f.jobId, 'session-1', {
      content: 'canonical result',
      outcome: { kind: 'completed' },
      durationMs: 1,
    });
    const owner = f.store.getResultExportOwner();
    owner.hintRepair(f.jobId);
    await owner.repairPass([f.jobId], { canContinue: () => true, record: () => {} });
    expect(f.index.read(f.jobId)?.disposition).toBe('terminal');
    expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
  });

  it('observes the source before applying a permanent location hold', () => {
    const f = fixture();
    f.complete();
    f.index.markUncertified(f.jobId);
    f.index.holdUnknownLocations(f.epochKey, 'retained-controller-recovery-unavailable');
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({ kind: 'repair-pending' });
  });
  it.each([1, 2, 'deadline'] as const)(
    'repairs an unhinted tail despite persistent failed retries with a %s pass budget',
    async (limit) => {
      const f = fixture();
      f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF + 1 });
      const heads = ['head-1', 'head-2'];
      for (const jobId of heads) {
        initTestJob(f.store, {
          jobId,
          sessionId: jobId,
          provider: 'claude',
          projectRoot: f.root,
          backendNamespace: 'fixture',
        });
        const seq = commitJobTerminal(f.store, jobId, jobId, {
          content: 'head result',
          outcome: { kind: 'completed' },
          durationMs: 1,
        });
        const detail = f.store.loadJobProjectionDetail(jobId);
        if (!detail.status) throw new Error('Missing fixture status');
        f.index.recordTerminal(
          jobId,
          {
            status: detail.status,
            events: f.store.readJobEvents(jobId),
            exit: detail.exit,
            readiness: deriveLaunchReadiness(detail),
          },
          f.index.resultPathFor(jobId),
          seq,
          f.db,
          true,
        );
      }
      const owner = f.store.getResultExportOwner();
      const wakeup = vi.fn();
      owner.onRepairHint(wakeup);
      const write = f.runtime.storage.writeAtomicDurableSync;
      const attempts: string[] = [];
      vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, bytes, options) => {
        const jobId = [...heads, f.jobId].find((id) => path === f.index.resultPathFor(id));
        if (jobId) attempts.push(jobId);
        if (jobId && heads.includes(jobId)) {
          if (limit === 'deadline') f.advance(5_001);
          return false;
        }
        return write(path, bytes, options);
      });
      for (let pass = 0; pass < 8; pass++) {
        let left = limit === 'deadline' ? 0 : limit;
        const deadline = f.runtime.time.monotonicNow() + 5_000n;
        await owner.repairPass([...heads, f.jobId], {
          canContinue: () => (limit === 'deadline' ? f.runtime.time.monotonicNow() < deadline : left-- > 0),
          record: vi.fn(),
        });
      }
      expect(attempts).toContain(f.jobId);
      expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
      expect(f.index.resultDurable(f.jobId)).toBe(true);
      for (const jobId of heads) {
        expect(attempts.filter((id) => id === jobId).length).toBeGreaterThan(1);
        expect(owner.observeResultAvailability(jobId)).toMatchObject({
          kind: 'failed',
          cause: 'repair-failed',
          retryScheduled: true,
        });
      }
      expect(wakeup).not.toHaveBeenCalled();
    },
  );

  it.each(['pending', 'failed'])(
    'resumes a bounded repair scan and retries a %s eligible tail across exhausted runs',
    async (state) => {
      const f = fixture();
      f.complete();
      const owner = f.store.getResultExportOwner();
      const wakeup = vi.fn();
      owner.onRepairHint(wakeup);
      const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
      if (state === 'failed') {
        write.mockReturnValueOnce(false);
        expect(() => owner.publishTerminalResult(f.jobId)).toThrow('Failed to write result artifact');
        expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
          kind: 'failed',
          cause: 'repair-failed',
          retryScheduled: true,
        });
      }
      const observe = owner.observeResultAvailability.bind(owner);
      const location = f.index.read(f.jobId);
      const read = f.index.read.bind(f.index);
      vi.spyOn(f.index, 'read').mockImplementation((jobId) =>
        jobId.startsWith('head-') && location ? { ...location, jobId } : read(jobId),
      );
      const visited: string[] = [];
      vi.spyOn(owner, 'observeResultAvailability').mockImplementation((jobId) => {
        visited.push(jobId);
        return jobId === f.jobId ? observe(jobId) : { kind: 'available', resultPath: '/head' };
      });
      const candidates = ['head-1', 'head-2', f.jobId];
      for (let pass = 0; pass < 3; pass++) {
        let left = 2;
        await owner.repairPass(candidates, { canContinue: () => left-- > 0, record: vi.fn() });
        if (pass === 0) {
          if (state === 'failed') expect(existsSync(f.resultPath)).toBe(true);
          else expect(visited).toEqual(['head-1', 'head-2']);
        }
      }
      if (state === 'failed') expect(wakeup).toHaveBeenCalled();
      else expect(wakeup).not.toHaveBeenCalled();
      expect(visited).toContain(f.jobId);
      expect(write).toHaveBeenCalledTimes(state === 'failed' ? 2 : 1);
      expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
    },
  );

  it('enumerates repair identities without eagerly reading every retained location', () => {
    const f = fixture();
    const read = vi.spyOn(f.runtime.storage, 'readFileSync');
    expect([...f.index.jobIds()]).toContain(f.jobId);
    expect(read).not.toHaveBeenCalled();
  });

  it('renders a real workflow step report through deletion and repair', () => {
    const f = fixture('workflow');
    f.complete({
      steps: [
        { stepIndex: 0, atomIndex: 0, label: 'intermediate', output: 'intermediate output' },
        { stepIndex: 1, atomIndex: 0, label: 'final', output: 'final output' },
      ],
    });
    f.store.publishTerminalResult(f.jobId);
    const report = readFileSync(f.resultPath, 'utf8');
    expect(report).toContain('intermediate output');
    rmSync(f.resultPath);
    f.store.ensureResultArtifact(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe(report);
  });

  it.each(['provider', 'workflow'] as const)('renders nonempty empty-terminal explanations for %s', (kind) => {
    const f = fixture(kind);
    f.complete({
      terminal: { content: '', outcome: { kind: 'aborted', reason: 'user_abort' }, durationMs: 0 },
      ...(kind === 'workflow' ? { steps: [] } : {}),
    });
    f.store.publishTerminalResult(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8').trim()).not.toBe('');
    expect(f.index.resultDurable(f.jobId)).toBe(true);
  });

  it('renders the outcome explanation when workflow completion facts are absent', () => {
    const f = fixture('workflow');
    f.complete();
    f.store.publishTerminalResult(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe('Completed.\n');
    expect(f.index.resultDurable(f.jobId)).toBe(true);
  });

  it('refuses contradictory workflow completion facts', () => {
    const f = fixture('workflow');
    f.complete({ steps: [] });
    f.db
      .prepare("UPDATE events SET body = ? WHERE type = 'workflow.completed'")
      .run(Buffer.from(JSON.stringify({ outcome: 'aborted', stepDetails: [] })));
    f.store.publishTerminalResult(f.jobId);
    expect(existsSync(f.resultPath)).toBe(false);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'workflow-facts-unavailable',
      retryScheduled: false,
    });
  });

  it('leaves an available workflow child file untouched without synchronization', () => {
    const f = fixture();
    f.complete();
    f.store.publishTerminalResult(f.jobId);
    writeFileSync(f.resultPath, 'older canonical rendering');
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
    const sync = vi.spyOn(f.runtime.storage, 'fdatasyncSync');
    f.store.ensureResultArtifact(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe('older canonical rendering');
    expect(write).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it.each([-1, 0, 1])('uses strict expiry at cutoff %+i', (offset) => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF + offset });
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(offset >= 0);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe(
      offset < 0 ? 'retained-away' : 'available',
    );
    if (offset < 0) expect(f.index.resultDurable(f.jobId)).toBe(true);
  });

  it('publishes source-backed regression, retries after failure and requires the file for retirement', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF + 1 });
    expect(f.index.terminalEligibility(f.jobId)).toMatchObject({ kind: 'regression', age: 'regression' });
    expect(f.index.resultDurable(f.jobId)).toBe(false);
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValueOnce(false);
    expect(() => f.store.publishTerminalResult(f.jobId)).toThrow('Failed to write');
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'repair-failed',
      retryScheduled: true,
    });
    write.mockRestore();
    f.store.ensureResultArtifact(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
    expect(f.index.certify(f.epochKey, 2)).not.toBeNull();
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
    rmSync(f.resultPath);
    const restarted = new JobLocationIndex(f.runtime, f.root);
    expect(restarted.resultDurable(f.jobId)).toBe(false);
    f.store.configureResultExports(restarted);
    f.store.ensureResultArtifact(f.jobId);
    expect(restarted.resultDurable(f.jobId)).toBe(true);
    rmSync(f.resultPath);
    f.removeSource();
    expect(restarted.resultDurable(f.jobId)).toBe(false);
    expect(restarted.terminalEligibility(f.jobId).age).toBe('regression');
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      retryScheduled: false,
      ageUncertain: true,
    });
  });

  it('retries a failed inside-window attempt through a coalesced hint pass', async () => {
    const f = fixture();
    f.complete();
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValueOnce(false);
    expect(() => f.store.publishTerminalResult(f.jobId)).toThrow();
    write.mockRestore();
    const owner = f.store.getResultExportOwner();
    owner.hintRepair(f.jobId);
    owner.hintRepair(f.jobId);
    await owner.repairPass([], { canContinue: () => true, record: () => {} });
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('available');
  });

  it('keeps retrying a failed hint with an empty scan and a one-candidate pass budget', async () => {
    const f = fixture();
    f.complete();
    const owner = f.store.getResultExportOwner();
    const wakeup = vi.fn();
    owner.onRepairHint(wakeup);
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockReturnValue(false);
    expect(() => owner.publishTerminalResult(f.jobId)).toThrow('Failed to write result artifact');
    for (let pass = 0; pass < 4; pass++) {
      let left = 1;
      await owner.repairPass([], { canContinue: () => left-- > 0, record: vi.fn() });
    }
    expect(write).toHaveBeenCalledTimes(3);
    expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'repair-failed',
      retryScheduled: true,
    });
    expect(wakeup).toHaveBeenCalled();
  });

  it('supplies file-based retirement proof for a fresh source-backed regression', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF + 1 });
    expect(f.index.resultDurable(f.jobId)).toBe(false);
    f.store.publishTerminalResult(f.jobId);
    expect(f.index.resultDurable(f.jobId)).toBe(true);
    expect(f.index.certify(f.epochKey, 2)).not.toBeNull();
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
    rmSync(f.resultPath);
    expect(f.index.resultDurable(f.jobId)).toBe(false);
  });

  it('discards its stage if expiry crosses during fdatasync before final rename', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF });
    const sync = f.runtime.storage.writeAtomicDurableSync;
    vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync').mockImplementation((path, bytes, options) => {
      if (path === f.resultPath)
        return sync(path, bytes, {
          ...options,
          beforeRename: () => {
            f.advance(1);
            return options?.beforeRename?.() ?? true;
          },
        });
      return sync(path, bytes, options);
    });
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(false);
    expect(readdirSync(f.resultPath.slice(0, -'result.md'.length))).toEqual([]);
    expect(f.index.resultDurable(f.jobId)).toBe(true);
  });

  it('keeps validated expired age after source removal and restart; no selected-source or mtime fallback', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1 });
    f.removeSource();
    const restarted = new JobLocationIndex(f.runtime, f.root);
    expect(restarted.resultDurable(f.jobId)).toBe(true);
    f.store.configureResultExports(restarted);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId).kind).toBe('retained-away');
    const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete record.resultPath;
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(restarted.resultDurable(f.jobId)).toBe(true);
    delete record.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(restarted.resultDurable(f.jobId)).toBe(false);
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'terminal-age-unknown',
      retryScheduled: false,
    });
  });

  it('refuses unproven legacy age after pruning and malformed or mismatched evidence', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1 });
    const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete record.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(record));
    f.db.prepare('DELETE FROM events WHERE seq = 1').run();
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(false);
    expect(f.index.resultDurable(f.jobId)).toBe(false);
    for (const terminalAge of [
      { kind: 'known', terminalAt: TERMINAL_EXPORT_CUTOFF - 1 },
      { ...record.terminalAge, epochKey: 'other' },
    ]) {
      writeFileSync(f.locationPath, JSON.stringify({ ...record, terminalAge }));
      expect(f.index.resultDurable(f.jobId)).toBe(false);
    }
  });

  it('denies both proof branches for present inconsistent copies and missing retained outcome', () => {
    const f = fixture();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1 });
    const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    for (const field of ['status', 'events', 'exit']) {
      const corrupt = structuredClone(record);
      if (field === 'status') corrupt.detail.status.result.content = 'stale';
      if (field === 'events') corrupt.detail.events[0].result.content = 'stale';
      if (field === 'exit') corrupt.detail.exit.durationMs += 1;
      writeFileSync(f.locationPath, JSON.stringify(corrupt));
      expect(f.index.read(f.jobId)?.detail.kind).toBe('unreadable');
      expect(f.index.resultDurable(f.jobId)).toBe(false);
    }
    delete record.detail;
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(f.index.resultDurable(f.jobId)).toBe(false);
  });

  it('refuses disagreement on recording and validates legacy optional copies without correction', () => {
    const f = fixture();
    const seq = f.complete();
    const location = f.index.read(f.jobId);
    if (location?.detail.kind !== 'recorded') throw new Error('missing fixture detail');
    const detail = structuredClone(location.detail.value);
    if (!detail.status.result) throw new Error('missing result');
    detail.status.result.content = 'stale caller content';
    expect(() => f.index.recordTerminal(f.jobId, detail, f.resultPath, seq, f.db)).toThrow('disagrees');
    const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    delete record.detail.status.result;
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(f.index.read(f.jobId)?.detail.kind).toBe('recorded');
    record.detail.epochKey = 'another epoch';
    writeFileSync(f.locationPath, JSON.stringify(record));
    expect(f.index.read(f.jobId)?.detail.kind).toBe('unreadable');
  });

  it('records a fresh terminal after unrelated journal pruning without discarding its own timestamp evidence', () => {
    const f = fixture();
    f.db
      .prepare('INSERT INTO events(ts, type, stream_kind, stream_id, body) VALUES (?, ?, ?, ?, ?)')
      .run('2026-09-01T00:00:00.000Z', 'fixture.pruned', 'workflow', 'unrelated', Buffer.from('{}'));
    f.db.prepare("DELETE FROM events WHERE type = 'fixture.pruned'").run();
    f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF + 1 });
    f.store.publishTerminalResult(f.jobId);
    expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
  });

  it('preserves age recorded by a concurrent owner before the revision lock is acquired', () => {
    const f = fixture();
    const seq = f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1, precedingAt: TERMINAL_EXPORT_CUTOFF + 1 });
    const retained = JSON.parse(readFileSync(f.locationPath, 'utf8'));
    const legacy = structuredClone(retained);
    delete legacy.terminalAge;
    writeFileSync(f.locationPath, JSON.stringify(legacy));
    f.db.prepare('DELETE FROM events WHERE seq = 1').run();
    const location = f.index.read(f.jobId);
    if (location?.detail.kind !== 'recorded') throw new Error('missing fixture terminal');
    const stat = f.runtime.storage.lstatSync;
    let observations = 0;
    vi.spyOn(f.runtime.storage, 'lstatSync').mockImplementation(((path, options) => {
      if (path === f.locationPath && ++observations === 2) writeFileSync(f.locationPath, JSON.stringify(retained));
      return stat(path, options);
    }) as typeof stat);
    f.index.recordTerminal(f.jobId, location.detail.value, f.resultPath, seq, f.db);
    expect(f.index.terminalEligibility(f.jobId).age).toBe('regression');
  });

  it('reports an unexpired missing artifact after source retirement as failed without a retry', () => {
    const f = fixture();
    f.complete();
    f.removeSource();
    expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'source-epoch-retired',
      retryScheduled: false,
    });
    expect(f.index.resultDurable(f.jobId)).toBe(false);
  });

  it('observation makes no write or fsync and an untrusted cutoff defers publication', () => {
    const f = fixture();
    f.complete();
    const owner = f.store.getResultExportOwner();
    const write = vi.spyOn(f.runtime.storage, 'writeAtomicDurableSync');
    const sync = vi.spyOn(f.runtime.storage, 'fdatasyncSync');
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
    expect(write).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    f.jump(86_400_000);
    expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
      kind: 'failed',
      cause: 'cutoff-untrusted',
      retryScheduled: true,
    });
    f.store.ensureResultArtifact(f.jobId);
    expect(existsSync(f.resultPath)).toBe(false);
  });
});

it('recording failure does not skip publication after an accepted terminal commit', () => {
  const publish = vi.fn(() => '/result');
  const record = vi.fn(() => {
    throw new Error('location write failed');
  });
  observeTerminalResultExports(
    publish,
    record,
  )([{ stream: { kind: 'job', id: 'accepted' }, type: 'job.terminal.recorded', seq: 42 }] as never);
  expect(publish).toHaveBeenCalledWith('accepted', 42);
});

it('a known saved expiry outranks a later source read failure', () => {
  const f = fixture();
  f.complete({ terminalAt: TERMINAL_EXPORT_CUTOFF - 1 });
  vi.spyOn(f.db, 'prepare').mockImplementation(() => {
    throw new Error('busy source');
  });
  expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({ kind: 'retained-away' });
});

it('never promises result repair for a source with no accepted terminal', async () => {
  const f = fixture();
  const owner = f.store.getResultExportOwner();
  expect(owner.observeResultAvailability(f.jobId)).toMatchObject({ kind: 'failed', retryScheduled: false });
  const record = vi.fn();
  owner.hintRepair(f.jobId);
  await owner.repairPass([f.jobId], { canContinue: () => true, record }, true);
  expect(record).not.toHaveBeenCalled();
});

it('keeps source-backed hydration pending even with an unverified artifact', () => {
  const f = fixture();
  f.complete();
  f.store.publishTerminalResult(f.jobId);
  f.index.markUncertified(f.jobId);
  f.index.holdUnknownLocations(f.epochKey, 'retained-controller-recovery-unavailable');
  const state = f.store.getResultExportOwner().observeResultAvailability(f.jobId);
  expect(state).toMatchObject({ kind: 'repair-pending', ageUncertain: true });
  expect(formatResultAvailability(state)).not.toContain('Result path:');
});

it('a hinted repair pass never enumerates the full location inventory', async () => {
  const f = fixture();
  f.complete();
  const owner = f.store.getResultExportOwner();
  const enumerate = vi.fn(function* () {
    throw new Error('full scan');
  });
  owner.hintRepair(f.jobId);
  await owner.repairPass({ [Symbol.iterator]: enumerate }, { canContinue: () => true, record: vi.fn() }, true);
  expect(enumerate).not.toHaveBeenCalled();
  expect(owner.observeResultAvailability(f.jobId).kind).toBe('available');
});

it('does not recapture an already saved unknown terminal age', () => {
  const f = fixture();
  f.complete();
  const stored = JSON.parse(readFileSync(f.locationPath, 'utf8'));
  stored.terminalAge.kind = 'unknown';
  delete stored.terminalAge.terminalAt;
  writeFileSync(f.locationPath, JSON.stringify(stored));
  const prepare = vi.spyOn(f.db, 'prepare');
  const owner = f.store.getResultExportOwner();
  for (let n = 0; n < 20; n++) expect(owner.progressRetentionExpired(f.jobId)).toBeUndefined();
  expect(prepare.mock.calls.some(([sql]) => /COUNT|ORDER BY ts DESC/.test(sql))).toBe(false);
});

it('reports contradictory accepted source facts as unusable without promising a retry', () => {
  const f = fixture();
  f.complete();
  f.db
    .prepare("UPDATE events SET body = ? WHERE stream_id = ? AND type = 'job.terminal.recorded'")
    .run(
      Buffer.from(
        JSON.stringify({ terminal: { content: 'different result', outcome: { kind: 'completed' }, durationMs: 1 } }),
      ),
      f.jobId,
    );
  expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toMatchObject({
    kind: 'failed',
    cause: 'terminal-unusable',
    retryScheduled: false,
  });
});

it('a source terminal dominates its maintenance hold when location hydration failed', () => {
  const f = fixture();
  f.complete();
  f.index.markUncertified(f.jobId);
  f.index.holdUnknownLocations(f.epochKey, 'location recording unavailable', false);
  expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).toEqual({
    kind: 'repair-pending',
    ageUncertain: true,
  });
});

it('an untrusted cutoff reports its own cause and preserves settled causes', () => {
  const f = fixture();
  f.complete();
  const owner = f.store.getResultExportOwner();
  trustedJobRetentionCutoff(f.runtime);
  const wall = f.runtime.time.now();
  f.runtime.time.now = () => wall + 6 * 60 * 60 * 1000;
  expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
    kind: 'failed',
    cause: 'cutoff-untrusted',
    retryScheduled: true,
  });
  expect(formatResultAvailability(owner.observeResultAvailability(f.jobId))).toContain('five minutes');
  const original = f.index.read(f.jobId)!;
  vi.spyOn(f.index, 'read').mockReturnValue({ ...original, terminalAge: undefined });
  const closedOwner = new TerminalResultExportOwner({
    runtime: f.runtime,
    jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
    location: (id) => f.index.read(id),
    withSource: () => null,
  });
  expect(closedOwner.observeResultAvailability(f.jobId)).toMatchObject({
    kind: 'failed',
    cause: 'terminal-age-unknown',
    retryScheduled: false,
  });
});

it('preserves the confirmed absent-directory rule for an unknown-age legacy crash residue', () => {
  const f = fixture();
  f.complete();
  const location = f.index.read(f.jobId)!;
  vi.spyOn(f.index, 'read').mockReturnValue({ ...location, terminalAge: undefined });
  vi.spyOn(f.index, 'terminalEligibility').mockReturnValue({
    kind: 'unknown',
    age: 'unknown',
    ageUnproven: true,
    sourceReadable: true,
    cutoffTrusted: true,
    publicationAuthorized: false,
  });
  f.runtime.storage.mkdirSync(f.runtime.paths.coral.exports.jobsRoot + '/' + f.jobId, { recursive: true });
  writeFileSync(f.resultPath + '.stage-crashed', 'unfinished publication');
  expect(f.index.resultDurable(f.jobId)).toBe(false);
  expect(f.store.getResultExportOwner().observeResultAvailability(f.jobId)).not.toHaveProperty('resultPath');
});

it('unchanged workflow availability polls render the report once per read session', () => {
  const f = fixture('workflow');
  f.complete();
  writeFileSync(f.epoch.path, 'source stamp');
  const owner = f.store.getResultExportOwner();
  const input = (owner as unknown as { input: { workflowReport: WorkflowReportPort } }).input;
  const report = vi.spyOn(input, 'workflowReport');
  const session = {};
  for (let i = 0; i < 40; i++) owner.observeResultAvailability(f.jobId, session);
  expect(report).toHaveBeenCalledTimes(1);
});

it('a repair scan skips terminal preparation for already recorded age evidence', async () => {
  const f = fixture();
  f.complete();
  const owner = f.store.getResultExportOwner();
  const input = (owner as unknown as { input: { prepareTerminal?: (id: string) => void } }).input;
  const prepare = vi.spyOn(input, 'prepareTerminal');
  await owner.repairPass([f.jobId], { canContinue: () => true, record: () => {} });
  expect(prepare).not.toHaveBeenCalled();
});

it('rechecks clock trust without forgetting cached source facts', () => {
  const f = fixture();
  f.complete();
  writeFileSync(f.epoch.path, 'source stamp');
  const session = {};
  const owner = f.store.getResultExportOwner();
  expect(owner.observeResultAvailability(f.jobId, session)).toMatchObject({ kind: 'repair-pending' });
  f.jump(60001);
  expect(owner.observeResultAvailability(f.jobId, session)).toMatchObject({
    kind: 'failed',
    cause: 'cutoff-untrusted',
    retryScheduled: true,
  });
  f.advance(300000);
  expect(owner.observeResultAvailability(f.jobId, session)).toMatchObject({ kind: 'repair-pending' });
});

it('rechecks a deferred source age after clock trust returns and the terminal expires', () => {
  const f = fixture();
  f.complete();
  writeFileSync(f.epoch.path, 'source stamp');
  const location = f.index.read(f.jobId)!;
  vi.spyOn(f.index, 'read').mockReturnValue({ ...location, terminalAge: undefined });
  const session = {};
  const owner = f.store.getResultExportOwner();
  f.jump(60001);
  expect(owner.observeResultAvailability(f.jobId, session)).toMatchObject({
    kind: 'failed',
    cause: 'cutoff-untrusted',
    retryScheduled: true,
  });
  f.advance(30 * 86_400_000);
  expect(owner.observeResultAvailability(f.jobId, session)).toMatchObject({
    kind: 'failed',
    cause: 'terminal-age-unknown',
    retryScheduled: false,
  });
});

it('a settled source owner ends artifact retry after a retained terminal read fails', () => {
  const f = fixture();
  f.complete();
  const owner = new TerminalResultExportOwner({
    runtime: f.runtime,
    jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
    location: (id) => f.index.read(id),
    withSource: () => {
      throw new Error('unable to open database file');
    },
    hydrationRetry: () => false,
  });
  expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
    kind: 'failed',
    cause: 'terminal-unusable',
    retryScheduled: false,
  });
  expect(f.index.read(f.jobId)?.disposition).toBe('terminal');
});

it('a busy legacy source stays repair-pending through a middle poll', () => {
  const f = fixture();
  f.complete();
  const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
  delete record.terminalAge;
  writeFileSync(f.locationPath, JSON.stringify(record));
  let busy = false;
  const owner = new TerminalResultExportOwner({
    runtime: f.runtime,
    jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
    location: (id) => f.index.read(id),
    withSource: (_id, read) => {
      if (busy) throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
      return read(f.db, f.store);
    },
  });
  expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
  const a = admitted(f.jobId);
  a.availability = owner.observeResultAvailability(f.jobId);
  const session = new WaitSession([f.jobId]);
  session.reconcile([a]);
  session.acknowledge(a);
  busy = true;
  a.availability = owner.observeResultAvailability(f.jobId);
  session.reconcile([a]);
  expect(selectWaitSnapshot(session).cursor.jobs[0].flags).toBe(3);
  expect(owner.observeResultAvailability(f.jobId)).toMatchObject({ kind: 'repair-pending', ageUncertain: true });
  busy = false;
  expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
});

it.each(['recorded', 'legacy', 'unhydrated'] as const)(
  'one failed owner attempt settles %s artifact pending',
  async (kind) => {
    const f = fixture();
    f.complete();
    if (kind === 'legacy') {
      const record = JSON.parse(readFileSync(f.locationPath, 'utf8'));
      delete record.terminalAge;
      writeFileSync(f.locationPath, JSON.stringify(record));
    }
    if (kind === 'unhydrated') f.index.markUncertified(f.jobId);
    const failures = new Set<string>();
    const owner = new TerminalResultExportOwner({
      runtime: f.runtime,
      jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
      failures,
      location: (id) => f.index.read(id),
      withSource: (_id, read) => {
        if (kind === 'unhydrated') return read(f.db, f.store);
        throw new Error('Source lock is malformed.');
      },
      prepareTerminal: () => {
        throw new Error('Source lock is malformed.');
      },
    });
    expect(owner.observeResultAvailability(f.jobId).kind).toBe('repair-pending');
    for (let pass = 0; pass < 5; pass++) {
      await owner.repairPass([f.jobId], { canContinue: () => true, record: () => {} });
      expect(failures.has(f.jobId)).toBe(true);
      expect(owner.observeResultAvailability(f.jobId)).toMatchObject({
        kind: 'failed',
        cause: 'repair-failed',
        retryScheduled: true,
      });
      f.advance(5 * 60_000);
    }
  },
);

it('publication uses one source session including final authorization', () => {
  const f = fixture();
  f.complete();
  const withSource = vi.fn((_id: string, read: (db: typeof f.db, ctx: typeof f.store) => unknown) =>
    read(f.db, f.store),
  );
  const owner = new TerminalResultExportOwner({
    runtime: f.runtime,
    jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
    location: (id) => f.index.read(id),
    withSource: withSource as never,
  });
  owner.publishTerminalResult(f.jobId);
  expect(readFileSync(f.resultPath, 'utf8')).toBe('canonical result\n');
  expect(withSource).toHaveBeenCalledTimes(1);
});

describe('canonical render across owner contexts', () => {
  describe('result renderer canonicality', () => {
    it('renders identical bytes for a failed terminal across owner read contexts', () => {
      const f = createTerminalExportFixture('provider');
      try {
        const ins = f.db
          .prepare('INSERT INTO events(ts, type, stream_kind, stream_id, refs, body) VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            new Date().toISOString(),
            'workflow.lifecycle_fault',
            'workflow',
            'wf-1',
            JSON.stringify({ workflowId: 'wf-1' }),
            Buffer.from(JSON.stringify({ kind: 'wrapper_crashed', message: 'boom' })),
          );
        const causeSeq = Number(ins.lastInsertRowid);
        f.complete({
          terminal: {
            content: '',
            outcome: { kind: 'failed', causeRef: { stream: { kind: 'workflow', id: 'wf-1' }, seq: causeSeq } },
            durationMs: 1,
          } as never,
        });
        const render = (ctx: object) => {
          rmSync(dirname(f.resultPath), { recursive: true, force: true });
          const owner = new TerminalResultExportOwner({
            runtime: f.runtime,
            jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
            workflowReport: renderWorkflowReport,
            location: (id) => f.index.read(id),
            withSource: (_id, read) => read(f.db, ctx as never),
          });
          owner.publishTerminalResult(f.jobId);
          return readFileSync(f.resultPath, 'utf8');
        };
        const full = {
          ...composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
          bodyCodec: createEventBodyCodec(),
        };
        const jobsOnly = { ...composeReducers(jobsRegistry), bodyCodec: createEventBodyCodec() };
        const coordinatorBytes = render(full);
        const historicalBytes = render(jobsOnly);

        expect(coordinatorBytes).toBe(historicalBytes);
      } finally {
        f.close();
      }
    });
  });
});

describe('first publication schedules retry after clock trust', () => {
  describe('first publication under an untrusted cutoff', () => {
    it('defers an untrusted first publication and posts its repair hint', () => {
      const f = createTerminalExportFixture('provider');
      try {
        const owner = f.store.getResultExportOwner();
        let hinted = 0;
        owner.onRepairHint(() => {
          hinted++;
        });
        trustedJobRetentionCutoff(f.runtime); // establish the clock baseline
        f.jump(120_000); // wall steps +2 min without monotonic progress
        f.complete();
        owner.publishTerminalResult(f.jobId);
        const during = owner.observeResultAvailability(f.jobId);
        const hints = [...(owner as unknown as { hints: Set<string> }).hints];
        f.advance(5 * 60_000 + 1);
        const after = owner.observeResultAvailability(f.jobId);

        expect(during).toMatchObject({ kind: 'failed', cause: 'cutoff-untrusted', retryScheduled: true });
        expect(hinted).toBe(1);
        expect(hints).toEqual([f.jobId]);
        expect(after.kind).toBe('repair-pending');
      } finally {
        f.close();
      }
    });
  });
});

it('bounds unscheduled daemon repair hints and failures', () => {
  const f = fixture();
  const owner = new TerminalResultExportOwner({
    runtime: f.runtime,
    jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
    location: () => null,
    withSource: () => {
      throw new Error('EIO');
    },
    repairQueueLimit: 2,
  });
  for (const id of ['a', 'b', 'c']) {
    owner.hintRepair(id);
    expect(() => owner.ensureResultMarkdownArtifact(id)).toThrow('EIO');
  }
  expect((owner as unknown as { hints: Set<string>; failures: Set<string> }).hints.size).toBe(2);
  expect((owner as unknown as { hints: Set<string>; failures: Set<string> }).failures.size).toBe(2);
});

it('retired source dominates a remembered repair failure', () => {
  const f = fixture();
  const owner = new TerminalResultExportOwner({
    runtime: f.runtime,
    jobsRoot: f.runtime.paths.coral.exports.jobsRoot,
    location: () => null,
    withSource: () => null,
    failures: new Set(['a']),
  });
  expect(owner.observeResultAvailability('a')).toMatchObject({
    kind: 'failed',
    cause: 'terminal-unusable',
    retryScheduled: false,
  });
});
