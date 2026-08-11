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
  // Converted, not deleted: this case used to assert that a job from another build's namespace was reported
  // missing. Namespace is no longer work tenancy, so the same job — same project root, still recorded under a
  // different `backendNamespace` — is now simply in scope. The status deliberately keeps the foreign namespace
  // so the assertion fails again if namespace ever re-enters scoping.
  it('keeps a job recorded under another build namespace in scope when the project root matches', () => {
    const runtime = new SimulationRuntime();
    const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
    const world = { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld;
    const control = createCoordinatorControl({
      world,
      listExecutionServices: () => [],
      getLifecycleController: () => null,
      getProgressStore: () =>
        ({
          readStatus: () => ({ projectRoot: '/current/project', jobKind: 'provider', backendNamespace: 'other-ns' }),
        }) as never,
      internalJobAbortRegistry,
    });

    const result = control.scopeCheckJobs(['foreign-job'], '/current/project');

    expect(result).toEqual({ valid: ['foreign-job'], missing: [], mismatch: [] });
  });

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
      getProgressStore: () => ({ readStatus: (id: string) => statuses[id] ?? null }) as never,
      internalJobAbortRegistry,
    });

    // cwd is a third project that owns neither job.
    const result = control.scopeCheckJobs(['kb-job', 'provider-job'], '/current/project');

    expect(result.valid).toContain('kb-job');
    expect(result.mismatch).toContain('provider-job');
    expect(result.mismatch).not.toContain('kb-job');
  });
});
