import { expect, it } from 'vitest';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { initTestJob } from '#tests/helpers/session.js';
import { commitJobInput } from '#tests/helpers/job-commits.js';
import { historicalSourceReader, seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';

it('reads same-epoch members at one cut when a writer commits between member reads', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    initTestJob(f.store, {
      jobId: 'job-2',
      sessionId: 'session-2',
      provider: 'claude',
      projectRoot: f.root,
      backendNamespace: 'fixture',
    });
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    const source = historicalSourceReader(f.index);
    let committed = false;
    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        epochKey: () => 'new-epoch',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      (epoch, ids) => {
        const result = source(epoch, ids);
        if (!committed) {
          committed = true;
          f.store.appendProgress('job-1', 'session-1', 'A committed between reads');
          f.store.appendProgress('job-2', 'session-2', 'B later commit');
        }
        return result;
      },
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    );
    const cursor = {
      version: 'jobs.wait.v3' as const,
      epochs: [{ token: waitEpochToken(f.epochKey), watermark: 0, lineOffset: 0 }],
      jobs: ['job-1', 'job-2'].map((id) => ({ hash: waitJobHash(id), epoch: 0, flags: 0 })),
    };
    const first = addressing.snapshot({ jobIds: ['job-1', 'job-2'], supportsWaitV3: true, cursor });
    const next = addressing.snapshot({ jobIds: ['job-1', 'job-2'], supportsWaitV3: true, cursor: first.cursor });
    expect([...first.jobs[0].progress, ...next.jobs[0].progress]).toEqual(['A committed between reads']);
    expect([...first.jobs[1].progress, ...next.jobs[1].progress]).toEqual(['B later commit']);
  } finally {
    f.close();
  }
});

it('preserves journal progress faults through historical hydration and source retirement', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const fault = { kind: 'recovery_parse_failed' as const, cause: { message: 'fault-marker' } };
    commitJobInput(f.store, {
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: f.jobId },
      namespace: 'fixture',
      project: f.root,
      refs: { jobId: f.jobId, sessionId: 'session-1' },
      body: fault,
    });
    f.complete();
    expect(f.store.loadJobProjectionDetail(f.jobId).exit?.diagnostics.progressFaults).toEqual([fault]);
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    const observed = historicalSourceReader(f.index)(f.epochKey, [f.jobId]);
    expect(observed.kind).toBe('read');
    if (observed.kind !== 'read') throw new Error('Missing historical source');
    const historical = observed.locations.get(f.jobId);
    expect(historical?.detail.kind === 'recorded' && historical.detail.value.exit?.diagnostics.progressFaults).toEqual([
      fault,
    ]);
    f.removeSource();
    const retained = f.index.read(f.jobId);
    expect(retained?.detail.kind === 'recorded' && retained.detail.value.exit?.diagnostics.progressFaults).toEqual([
      fault,
    ]);
  } finally {
    f.close();
  }
});

it('does not acknowledge a retained terminal committed after the historical progress cut', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    const source = historicalSourceReader(f.index);
    let committed = false;
    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        epochKey: () => 'new-epoch',
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      (epoch, ids) => {
        const result = source(epoch, ids);
        if (!committed) {
          committed = true;
          f.store.appendProgress(f.jobId, 'session-1', 'late progress');
          f.complete();
        }
        return result;
      },
      () => ({ kind: 'failed', cause: 'terminal-unusable', retryScheduled: false }),
    );
    const first = addressing.snapshot({ jobIds: [f.jobId], supportsWaitV3: true });
    expect(first.jobs[0].terminal).toBeUndefined();
    expect(first.remainingJobIds).toEqual([f.jobId]);
    const next = addressing.snapshot({ jobIds: [f.jobId], supportsWaitV3: true, cursor: first.cursor });
    expect(next.jobs[0].progress).toEqual(['late progress']);
    expect(next.jobs[0].terminal?.outcomeKind).toBe('completed');
  } finally {
    f.close();
  }
});

it('keeps known progress-fault diagnostics when their journal prefix was pruned', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const fault = { kind: 'missing_launch_record' as const };
    commitJobInput(f.store, {
      type: 'job.progress.emitted',
      stream: { kind: 'job', id: f.jobId },
      namespace: 'fixture',
      project: f.root,
      refs: { jobId: f.jobId, sessionId: 'session-1' },
      body: fault,
    });
    const terminalSeq = f.complete();
    f.db.prepare('DELETE FROM events WHERE stream_id = ? AND seq < ?').run(f.jobId, terminalSeq);
    seedHistoricalEpoch(
      f.runtime,
      f.index,
      f.epoch,
      f.epochKey,
      currentCoralStoreFormat().fingerprint,
      f.runtime.paths.coral.exports.jobsRoot,
      f.runtime.storage,
    );
    const result = historicalSourceReader(f.index)(f.epochKey, [f.jobId]);
    expect(result.kind).toBe('read');
    if (result.kind !== 'read') throw new Error('Missing historical source');
    const location = result.locations.get(f.jobId);
    expect(location?.detail.kind === 'recorded' && location.detail.value.exit?.diagnostics.progressFaults).toEqual([
      fault,
    ]);
  } finally {
    f.close();
  }
});
