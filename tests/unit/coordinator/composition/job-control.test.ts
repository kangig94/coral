import { describe, expect, it } from 'vitest';

import { createCoordinatorControl } from '#src/coordinator/composition/job-control.js';
import type { CoordinatorWorld } from '#src/coordinator/composition/world.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

function createControlHarness(): {
  control: ReturnType<typeof createCoordinatorControl>;
  internalJobAbortRegistry: AbortRegistry;
} {
  const runtime = new SimulationRuntime();
  const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
  const world = {
    idleTimer: { requestDrain() {} },
  } as unknown as CoordinatorWorld;
  const control = createCoordinatorControl({
    world,
    listExecutionServices: () => [],
    getLifecycleController: () => null,
    backendNamespace: 'test-ns',
    progressStore: {} as never,
    internalJobAbortRegistry,
  });
  return { control, internalJobAbortRegistry };
}

describe('createCoordinatorControl.abortJobs', () => {
  it('consults the internal-job abort registry before returning notFound', () => {
    const { control, internalJobAbortRegistry } = createControlHarness();
    const jobId = internalJobAbortRegistry.register('kb-reindex-1');

    const result = control.abortJobs([jobId, 'unknown-job']);

    expect(result.aborted).toEqual([jobId]);
    expect(result.notFound).toEqual(['unknown-job']);
    expect(internalJobAbortRegistry.getSignal(jobId)?.aborted).toBe(true);
  });

  it('reports notFound when the internal-job registry is empty', () => {
    const { control } = createControlHarness();

    const result = control.abortJobs(['absent-job']);

    expect(result.aborted).toEqual([]);
    expect(result.notFound).toEqual(['absent-job']);
  });
});
