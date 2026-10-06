import { expect, it } from 'vitest';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { commitJobInput } from '#tests/helpers/job-commits.js';
import { historicalSourceReader, seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { currentCoralStoreFormat } from '#src/store-format.js';

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
