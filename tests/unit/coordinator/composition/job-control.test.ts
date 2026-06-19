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
    getProgressStore: () => ({}) as never,
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

describe('createCoordinatorControl.scopeCheckJobs', () => {
  it('keeps KB jobs in scope from any project but rejects foreign non-KB jobs', () => {
    const runtime = new SimulationRuntime();
    const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
    const statuses: Record<string, { projectRoot: string; jobKind: string; backendNamespace: string }> = {
      'kb-job': { projectRoot: '/other/project', jobKind: 'kb', backendNamespace: 'test-ns' },
      'provider-job': { projectRoot: '/other/project', jobKind: 'provider', backendNamespace: 'test-ns' },
    };
    const world = { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld;
    const control = createCoordinatorControl({
      world,
      listExecutionServices: () => [],
      getLifecycleController: () => null,
      backendNamespace: 'test-ns',
      getProgressStore: () => ({ readStatus: (id: string) => statuses[id] ?? null }) as never,
      internalJobAbortRegistry,
    });

    // cwd is a third project that owns neither job.
    const result = control.scopeCheckJobs(['kb-job', 'provider-job'], '/current/project', 'test-ns');

    expect(result.valid).toContain('kb-job');
    expect(result.mismatch).toContain('provider-job');
    expect(result.mismatch).not.toContain('kb-job');
  });
});
