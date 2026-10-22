import { currentCoralStoreFormat } from '#src/store-format.js';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { loadRetainedCurrentJob } from '#src/jobs/retained-current.js';
import { TerminalResultExportOwner } from '#src/jobs/terminal/export.js';
import { commit } from '#src/store/append.js';
import { retainedExecutionsFixture } from '#tests/helpers/retained-executions.js';
import { executionHarness, requestedExecution } from '#tests/helpers/job-executions.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { loadReleasedBuild } from '#tests/helpers/released-build.js';

const roots: string[] = [];
const databases: ReturnType<typeof newRawDatabase>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(ended = 2) {
  const f = retainedExecutionsFixture(roots, ended);
  const db = newRawDatabase(f.epoch.path);
  databases.push(db);
  const location = loadRetainedCurrentJob(db, f.epochKey, f.jobId, f.jobsRoot)!;
  if (location.detail.kind !== 'recorded') throw new Error('Fixture has no retained detail');
  f.index.register(f.jobId, f.epochKey, location.subject);
  f.index.recordExecutionDetails(f.jobId, location.executions!, location.detail.value);
  return { ...f, db, entries: location.executions! };
}
function writeResult(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'result\n');
}

function admission(f: ReturnType<typeof fixture>, afterRequest?: () => void) {
  const h = executionHarness();
  try {
    return f.index.withAdmissionGuard(f.epochKey, f.db, () => {
      f.index.prepareAdmission(f.jobId, 2, f.epochKey, {
        projectRoot: '/workspace',
        workDir: '/workspace',
        jobKind: 'provider',
      });
      return commit(
        f.db,
        (c) => {
          c.append(requestedExecution(2));
          afterRequest?.();
          return undefined;
        },
        { ...h.ctx, beforeAppend: (input) => f.index.beforeAppend(input, f.epochKey) },
      );
    });
  } finally {
    h.db.close();
  }
}

describe('durable execution locations', () => {
  it('requires every execution result before resultsReleased, including after source removal', () => {
    const f = fixture();
    expect(f.index.certify(f.epochKey, f.ends.at(-1)!)).not.toBeNull();
    writeResult(f.entries[1].resultPath);
    expect(f.index.resultsReleased(f.epochKey)).toBe(false);
    writeResult(f.entries[0].resultPath);
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
    f.db.close();
    rmSync(dirname(f.epoch.path), { recursive: true });
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
    rmSync(f.entries[0].resultPath);
    expect(f.index.resultsReleased(f.epochKey)).toBe(false);
  });

  it('invalidates before a request rollback and reconciles absence with a new revision', () => {
    const f = fixture(1);
    writeResult(f.entries[0].resultPath);
    const certificate = f.index.certify(f.epochKey, f.ends[0])!;
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
    expect(() =>
      admission(f, () => {
        const pending = f.index.read(f.jobId)!;
        expect(pending.disposition).toBe('active-owner');
        expect(pending.pendingAdmission).toMatchObject({ execution: 2, priorTerminalSeq: f.ends[0] });
        expect(f.index.certificate(f.epochKey)).toBeNull();
        throw new Error('rollback');
      }),
    ).toThrow('rollback');
    expect(f.index.read(f.jobId)).toMatchObject({ disposition: 'terminal', latestExecution: 1 });
    expect(f.index.read(f.jobId)?.pendingAdmission).toBeUndefined();
    expect(f.index.certificate(f.epochKey)).toBeNull();
    expect(f.index.certify(f.epochKey, f.ends[0])!.revision).toBeGreaterThan(certificate.revision);
    expect(f.index.resultsReleased(f.epochKey)).toBe(true);
  });

  it('leaves fail-closed evidence across a crash after request commit, readable by a released build', async () => {
    const f = fixture(1);
    writeResult(f.entries[0].resultPath);
    f.index.certify(f.epochKey, f.ends[0]);
    const original = f.runtime.storage.writeAtomicDurableSync.bind(f.runtime.storage);
    const failure = vi
      .spyOn(f.runtime.storage, 'writeAtomicDurableSync')
      .mockImplementation((path, content, options) => {
        if (String(path).includes('/jobs/') && !String(content).includes('pendingAdmission')) return false;
        return original(path, content, options);
      });
    expect(() => admission(f)).not.toThrow();
    failure.mockRestore();
    const rebooted = new JobLocationIndex(
      f.runtime,
      f.runtime.paths.coral.generation.dataRoot,
      undefined,
      currentCoralStoreFormat().fingerprint,
    );
    expect(rebooted.read(f.jobId)).toMatchObject({ disposition: 'active-owner', pendingAdmission: { execution: 2 } });
    expect(rebooted.resultsReleased(f.epochKey)).toBe(false);
    const released = await loadReleasedBuild('v0.10.18', roots);
    const ReleasedIndex = released.JobLocationIndex;
    if (ReleasedIndex === undefined) throw new Error('Released fixture has no location reader');
    const old = new ReleasedIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    expect(old.read(f.jobId)?.disposition).toBe('active-owner');
    expect(old.certificate(f.epochKey)).toBeNull();
    expect(old.resultsReleased(f.epochKey)).toBe(false);
    rebooted.withAdmissionGuard(f.epochKey, f.db, () => {});
    expect(rebooted.read(f.jobId)).toMatchObject({ disposition: 'active-owner', latestExecution: 2, openExecution: 2 });
    expect(rebooted.read(f.jobId)?.pendingAdmission).toBeUndefined();
    expect(rebooted.certify(f.epochKey, f.ends[0])).toBeNull();
  });

  it('returns the committed request when both location refresh and its hold write fail', () => {
    const f = fixture(1);
    const reconcile = vi.spyOn(f.index, 'reconcileAdmissions');
    reconcile
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('refresh unavailable');
      });
    const hold = vi.spyOn(f.index, 'holdUnknownLocations').mockImplementationOnce(() => {
      throw new Error('hold unavailable');
    });
    const appended = admission(f);
    expect(hold).toHaveBeenCalledWith(f.epochKey, expect.stringContaining('refresh unavailable'), false);
    expect(appended.at(-1)).toMatchObject({ type: 'job.execution.requested', body: { execution: 2 } });
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'job.execution.requested'").get()).toEqual({
      count: 2,
    });
  });

  it('compacts and repairs each complete execution detail after its source disappears', async () => {
    const f = fixture();
    const rawPath = join(
      f.runtime.paths.coral.generation.dataRoot,
      'job-locations.v1',
      'jobs',
      `${Buffer.from(f.jobId).toString('base64url')}.json`,
    );
    const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
    raw.detail.events = f.entries[1].detail.events;
    raw.executions[0].futureExecution = 'keep';
    raw.executions[0].detail.exit.futureExit = 'keep';
    writeFileSync(rawPath, JSON.stringify(raw));
    const released = await loadReleasedBuild('v0.10.18', roots);
    const ReleasedIndex = released.JobLocationIndex;
    if (ReleasedIndex === undefined) throw new Error('Released fixture has no location reader');
    const old = new ReleasedIndex(f.runtime, f.runtime.paths.coral.generation.dataRoot);
    await old.compactTerminalRecords('', { canContinue: () => true, record: () => {} }, (action) => action());
    await f.index.compactTerminalRecords('', { canContinue: () => true, record: () => {} }, (action) => action());
    f.db.close();
    rmSync(dirname(f.epoch.path), { recursive: true });
    const index = new JobLocationIndex(
      f.runtime,
      f.runtime.paths.coral.generation.dataRoot,
      undefined,
      currentCoralStoreFormat().fingerprint,
    );
    const first = index.execution(f.jobId, 1)!;
    const second = index.execution(f.jobId, 2)!;
    expect(first.detail.exit?.diagnostics.usage).toEqual({ inputTokens: 100, costUsd: 0.1 });
    expect(second.detail.exit?.diagnostics.usage).toEqual({ inputTokens: 200, costUsd: 0.2 });
    expect(second.detail.exit?.outcome).toMatchObject({
      kind: 'failed',
      causeRef: { stream: { kind: 'job', id: f.jobId } },
    });
    expect(first.detail.events).toHaveLength(1);
    expect(second.detail.events).toHaveLength(1);
    expect(first).toHaveProperty('futureExecution', 'keep');
    expect(first.detail.exit).toHaveProperty('futureExit', 'keep');
    const owner = new TerminalResultExportOwner({
      runtime: f.runtime,
      jobsRoot: f.jobsRoot,
      location: (jobId) => index.read(jobId),
      withSource: () => null,
    });
    expect(owner.ensureResultMarkdownArtifact(f.jobId, undefined, 1)).toBe(first.resultPath);
    expect(owner.ensureResultMarkdownArtifact(f.jobId, undefined, 2)).toBe(second.resultPath);
    expect(readFileSync(first.resultPath, 'utf8')).toBe('result #1\n');
    expect(readFileSync(second.resultPath, 'utf8')).toBe('result #2\n');
    expect(owner.observeResultAvailability(f.jobId, undefined, 3)).toEqual({ kind: 'pending' });
    expect(index.read(f.jobId)?.detail).toMatchObject({ kind: 'recorded', value: { status: { execution: 2 } } });
  });
});
