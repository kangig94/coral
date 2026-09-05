import { describe, expect, it, vi } from 'vitest';

import { JobAbortService } from '#src/coordinator/services/job-abort.js';

describe('JobAbortService', () => {
  it('returns a live registry hold instead of reporting the job aborted', () => {
    const refusal = {
      jobId: 'held-job',
      reason: 'process absence is not yet proven',
      nextStep: 'Run coral-cli abort jobs held-job again to abandon without another signal.',
    };
    const abort = vi.fn(() => ({ aborted: [], notFound: [], refused: [refusal] }));
    const service = new JobAbortService({
      abortRegistry: {
        has: () => true,
        abort,
      } as never,
      progressStore: {
        readStatus: () => ({ phase: 'running' }),
      } as never,
      launchAdmission: { cancelQueued: () => false } as never,
      jobPools: new Map(),
      launchOrchestrator: {} as never,
    });

    expect(service.abort([refusal.jobId])).toEqual({
      aborted: [],
      notFound: [],
      refused: [refusal],
    });
    expect(abort).toHaveBeenCalledWith([refusal.jobId]);
  });
});
