import { expect, it, vi } from 'vitest';
import { createCoordinatorCoreContext } from '#src/coordinator/composition/core-context.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

it('shares the server location index and its repair state with the execution composition', () => {
  const runtime = new SimulationRuntime();
  const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
  index.resultRepairFailures.add('job');
  const context = createCoordinatorCoreContext({
    runtime,
    jobLocationIndex: index,
    storeFormat: currentCoralStoreFormat(),
    pluginRoot: '/plugin',
    backendNamespace: 'test-namespace',
    kbDaemonSupervisor: createMockKbDaemonSupervisor(),
    getConsumerStuck: () => [],
    onFatalShutdownError: vi.fn(),
  });
  expect(context.jobLocationIndex).toBe(index);
  expect(context.jobLocationIndex.resultRepairFailures.has('job')).toBe(true);
});
