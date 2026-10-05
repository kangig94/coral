import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowExecutionService,
  type WorkflowExecutionServiceDeps,
} from '#src/coordinator/services/workflow-execution.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { TEST_CODEX_SCOPE } from '#tests/helpers/provider-credentials.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

const executor = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('#src/workflow/executor.js', () => ({ executePipeline: (...args: unknown[]) => executor.execute(...args) }));

describe('workflow carrier ownership', () => {
  it.each(['completed', 'failed'] as const)(
    'removes a %s executor even when terminal finalization fails',
    async (outcome) => {
      const runtime = new SimulationRuntime();
      const workDir = fixtureCanonicalWorkDir('/workspace');
      const runningJobs = new Set<string>();
      const abortRegistry = new AbortRegistry(runtime.ids);
      let complete!: () => void;
      executor.execute.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            complete = () =>
              outcome === 'completed'
                ? resolve({ finalOutput: 'done', stepDetails: [] })
                : reject(new Error('executor failed'));
          }),
      );
      const service = new WorkflowExecutionService({
        runtime,
        runningJobs,
        abortRegistry,
        backendNamespace: 'test',
        bundleHash: 'test',
        providerRegistry: { get: () => ({}), decodeCompleteScope: () => ({ ok: true, value: TEST_CODEX_SCOPE }) },
        progressStore: {
          commit: (cb: (writer: { append: () => void }) => unknown) => cb({ append: () => {} }),
          nextEnqueueSequence: () => 1,
          readStatus: () => null,
          readRuntimeProjection: () => ({
            transport: 'workflow',
            startTime: new Date(runtime.time.now()).toISOString(),
          }),
        },
        coordinatorCommit: () => {
          throw new Error('terminal store busy');
        },
        launchOrchestrator: { markJobRunning: () => {} },
        executionPort: {},
      } as unknown as WorkflowExecutionServiceDeps);
      const result = await service.executeWorkflow(
        'codex',
        [[{ kind: 'prompt', text: 'task' }]],
        { expression: 'task', provider: 'codex', startPrompt: 'task', workDir },
        {
          projectRoot: workDir,
          pluginRoot: '/plugin',
          coralEnv: {},
          principal: testProjectPrincipal(workDir),
          providerScope: TEST_CODEX_SCOPE,
        },
        workDir,
      );
      if (!('kind' in result) || result.kind !== 'workflow') throw new Error('workflow launch refused');
      expect(runningJobs.has(result.jobId)).toBe(true);
      complete();
      await vi.waitFor(() => expect(runningJobs.has(result.jobId)).toBe(false));
    },
  );
});
