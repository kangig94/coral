import { describe, expect, it } from 'vitest';

import { isAcceptedLaunchResponse } from '#src/cli/emit.js';

describe('accepted launch response decoding', () => {
  it('accepts only the current provider-session contract', () => {
    expect(
      isAcceptedLaunchResponse({
        kind: 'provider-session',
        launchState: 'running',
        jobId: 'job-1',
        sessionId: 'session-1',
      }),
    ).toBe(true);
    expect(
      isAcceptedLaunchResponse({
        kind: 'provider-session',
        launchState: 'running',
        jobId: 'job-1',
        sessionId: 'session-1',
        job: 'legacy-job',
      }),
    ).toBe(false);
    expect(
      isAcceptedLaunchResponse({
        kind: 'provider-session',
        launchState: 'running',
        job: 'legacy-job',
        session: 'legacy-session',
      }),
    ).toBe(false);
  });

  it('requires an explicit workflow id and rejects a provider-session field', () => {
    expect(
      isAcceptedLaunchResponse({
        kind: 'workflow',
        launchState: 'queued',
        jobId: 'workflow-1',
        workflowId: 'workflow-1',
      }),
    ).toBe(true);
    expect(
      isAcceptedLaunchResponse({
        kind: 'workflow',
        launchState: 'queued',
        jobId: 'workflow-1',
      }),
    ).toBe(false);
    expect(
      isAcceptedLaunchResponse({
        kind: 'workflow',
        launchState: 'queued',
        jobId: 'workflow-1',
        workflowId: 'workflow-1',
        sessionId: 'not-a-provider-session',
      }),
    ).toBe(false);
  });
});
