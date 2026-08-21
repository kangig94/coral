import { describe, expect, it } from 'vitest';

import { createCoordinatorControl } from '#src/coordinator/composition/job-control.js';
import type { CoordinatorWorld } from '#src/coordinator/composition/world.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

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
  // The status deliberately carries a foreign `backendNamespace`, so this assertion fails again if
  // namespace ever re-enters scope judgement.
  it('keeps a job recorded under another build namespace in scope when the work directory matches', () => {
    const runtime = new SimulationRuntime();
    const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
    const world = { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld;
    const control = createCoordinatorControl({
      world,
      listExecutionServices: () => [],
      getLifecycleController: () => null,
      getProgressStore: () =>
        ({
          readStatus: () => ({
            workDir: fixtureCanonicalWorkDir('/current/project'),
            jobKind: 'provider',
            backendNamespace: 'other-ns',
          }),
        }) as never,
      internalJobAbortRegistry,
    });

    const result = control.scopeCheckJobs(['foreign-job'], fixtureCanonicalWorkDir('/current/project'), 'exact');

    expect(result).toEqual({ valid: ['foreign-job'], missing: [], mismatch: [] });
  });

  it('keeps KB jobs in scope from any project but rejects foreign non-KB jobs', () => {
    const runtime = new SimulationRuntime();
    const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
    const statuses = {
      'kb-job': { workDir: null, jobKind: 'kb', backendNamespace: 'test-ns' },
      'provider-job': {
        workDir: fixtureCanonicalWorkDir('/other/project'),
        jobKind: 'provider',
        backendNamespace: 'test-ns',
      },
    };
    const world = { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld;
    const control = createCoordinatorControl({
      world,
      listExecutionServices: () => [],
      getLifecycleController: () => null,
      getProgressStore: () => ({ readStatus: (id: string) => statuses[id as keyof typeof statuses] ?? null }) as never,
      internalJobAbortRegistry,
    });

    const result = control.scopeCheckJobs(
      ['kb-job', 'provider-job'],
      fixtureCanonicalWorkDir('/current/project'),
      'contains',
    );

    expect(result.valid).toContain('kb-job');
    expect(result.mismatch).toContain('provider-job');
    expect(result.mismatch).not.toContain('kb-job');
  });

  it('uses containment for explicit jobs and equality for ambient jobs', () => {
    const runtime = new SimulationRuntime();
    const internalJobAbortRegistry = new AbortRegistry(runtime.ids);
    const world = { idleTimer: { requestDrain() {} } } as unknown as CoordinatorWorld;
    const status = { workDir: fixtureCanonicalWorkDir('/repo/sub'), jobKind: 'provider' };
    const control = createCoordinatorControl({
      world,
      listExecutionServices: () => [],
      getLifecycleController: () => null,
      getProgressStore: () => ({ readStatus: () => status }) as never,
      internalJobAbortRegistry,
    });
    const callerRoot = fixtureCanonicalWorkDir('/repo');

    expect(control.scopeCheckJobs(['job'], callerRoot, 'contains').mismatch).toEqual([]);
    expect(control.scopeCheckJobs(['job'], callerRoot, 'exact').mismatch).toEqual(['job']);
  });
});
