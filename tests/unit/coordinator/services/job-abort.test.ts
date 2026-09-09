import { describe, expect, it, vi } from 'vitest';

import { JobAbortService } from '#src/coordinator/services/job-abort.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

describe('JobAbortService', () => {
  it('returns a live registry hold instead of reporting the job aborted', () => {
    const refusal = {
      jobId: 'held-job',
      reason: 'process absence is not yet proven',
      nextStep: 'Run coral-cli abort jobs held-job again to abandon without another signal.',
    };
    const abort = vi.fn(() => ({ aborted: [], notFound: [], refused: [refusal] }));
    const launchCoordinator = new LaunchCoordinator({ runtime: new SimulationRuntime() });
    const service = new JobAbortService({
      abortRegistry: {
        has: () => true,
        abort,
      } as never,
      progressStore: {
        readStatus: () => ({ phase: 'running' }),
      } as never,
      launchAdmission: launchCoordinator,
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
