import { expect, it } from 'vitest';
import { JobAbortService } from '#src/coordinator/services/job-abort.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { loadJobProjectionDetail } from '#src/jobs/read-queries.js';
import {
  executionHarness,
  openedJob,
  requestedExecution,
  executionInput,
  EXECUTION_JOB_ID as jobId,
} from '#tests/helpers/job-executions.js';

it('refuses abort while finishing even after the live abort registration has gone', () => {
  const h = executionHarness();
  try {
    h.append(
      openedJob(),
      requestedExecution(),
      executionInput('job.execution.outcome.accepted', {
        execution: 1,
        terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
      }),
    );
    const service = new JobAbortService({
      abortRegistry: new AbortRegistry(),
      readStatus: (id) => loadJobProjectionDetail(h.db, id, h.readCtx).status,
    });
    expect(service.abort([jobId])).toEqual({
      aborted: [],
      notFound: [],
      refused: [
        {
          jobId,
          reason: expect.stringContaining('finishing'),
          nextStep: { detail: 'Wait for the execution to end.', remedy: { kind: 'wait-job', jobId } },
        },
      ],
    });
    expect(h.events().at(-1)?.type).toBe('job.execution.outcome.accepted');
  } finally {
    h.db.close();
  }
});
