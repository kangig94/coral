import { describe, expect, it } from 'vitest';

import { buildJobEventRefs } from '#src/jobs/refs.js';

describe('buildJobEventRefs', () => {
  it('emits only canonical non-empty job refs', () => {
    expect(
      buildJobEventRefs({
        jobId: 'job-1',
        sessionId: 'session-1',
        parentJobId: 'workflow-1',
        workflowId: 'workflow-1',
        workflowSlotId: 'workflow-1:0:0',
      }),
    ).toEqual({
      jobId: 'job-1',
      sessionId: 'session-1',
      parentJobId: 'workflow-1',
      workflowId: 'workflow-1',
      workflowSlotId: 'workflow-1:0:0',
    });
  });

  it('omits absent optional refs', () => {
    expect(
      buildJobEventRefs({
        jobId: 'job-1',
        sessionId: null,
        parentJobId: undefined,
        workflowId: null,
      }),
    ).toEqual({
      jobId: 'job-1',
    });
  });

  it('rejects empty required and optional refs', () => {
    expect(() => buildJobEventRefs({ jobId: '' })).toThrow("Job ref 'jobId' must be non-empty.");
    expect(() => buildJobEventRefs({ jobId: 'job-1', sessionId: '' })).toThrow(
      "Job ref 'sessionId' must be non-empty.",
    );
    expect(() => buildJobEventRefs({ jobId: 'job-1', workflowSlotId: '' })).toThrow(
      "Job ref 'workflowSlotId' must be non-empty.",
    );
  });
});
