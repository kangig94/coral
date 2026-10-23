import { expect, it } from 'vitest';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { commitJobInput } from '#tests/helpers/job-commits.js';
import { historicalSourceReader, seedHistoricalEpoch } from '#src/jobs/historical-reader.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { loadJobExecutionDetails } from '#src/jobs/read-queries.js';

it('keeps known progress-fault diagnostics when their journal prefix was pruned', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const fault = { kind: 'missing_launch_record' as const };
    commitJobInput(f.store, {
      type: 'job.execution.progress',
      stream: { kind: 'job', id: f.jobId },
      namespace: 'fixture',
      project: f.root,
      refs: { jobId: f.jobId },
      body: { ...fault, execution: 1 },
    });
    const terminalSeq = f.complete();
    f.db
      .prepare("DELETE FROM events WHERE stream_id = ? AND seq < ? AND type = 'job.execution.progress'")
      .run(f.jobId, terminalSeq);
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

it('keeps journal progress-fault diagnostics when the latest projection lags', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const fault = { kind: 'missing_launch_record' as const };
    commitJobInput(f.store, {
      type: 'job.execution.progress',
      stream: { kind: 'job', id: f.jobId },
      namespace: 'fixture',
      project: f.root,
      refs: { jobId: f.jobId },
      body: { ...fault, execution: 1 },
    });
    f.complete();
    f.db
      .prepare('UPDATE projection_jobs SET diagnostics = ? WHERE job_id = ?')
      .run(JSON.stringify({ progressFaults: [] }), f.jobId);
    const executions = loadJobExecutionDetails(f.db, f.jobId, f.store);
    expect(executions[0]?.detail.exit?.diagnostics.progressFaults).toEqual([fault]);
  } finally {
    f.close();
  }
});
