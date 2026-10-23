import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowExecutionService,
  type WorkflowExecutionServiceDeps,
} from '#src/coordinator/services/workflow-execution.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { JobStore } from '#src/jobs/store.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type { CommitEventsFn } from '#src/store/append.js';
import { WorkflowExecutionError } from '#src/workflow/execution-contract.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { executionHarness } from '#tests/helpers/job-executions.js';
import { TEST_CODEX_SCOPE } from '#tests/helpers/provider-credentials.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const executor = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('#src/workflow/executor.js', () => ({ executePipeline: (...args: unknown[]) => executor.execute(...args) }));

describe('workflow carrier ownership', () => {
  it.each(['completed', 'failed', 'aborted'] as const)(
    'retains the original %s outcome until storage recovers, then ends once without external redrive',
    async (outcome) => {
      const runtime = new SimulationRuntime();
      const workDir = fixtureCanonicalWorkDir('/workspace');
      const journal = executionHarness(workflowRegistry);
      const runningJobs = new Set<string>();
      const abortRegistry = new AbortRegistry();
      let storageUnavailable = true;
      const acceptanceAttempts = vi.fn();
      const store = new JobStore('test', runtime, journal.readCtx.bodyCodec, {
        db: journal.db,
        reducers: journal.ctx.reducers,
        providers: permissiveProviderLookupPort,
        beforeAppend: (event) => {
          if (event.type !== 'job.execution.outcome.accepted') return;
          acceptanceAttempts();
          if (storageUnavailable) throw new Error('terminal store busy');
        },
      });
      const commit: CommitEventsFn = (write) => store.commit(write);
      const finisher = new ExecutionFinisher({
        time: runtime.time,
        commit,
        read: (address) => readExecutionFinishingState(journal.db, address, store),
        quiesce: async (address) => !runningJobs.has(address.jobId),
        retentionAction: async () => ({ attempt: 0, handles: [] }),
        settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
      });
      const artifact = vi.spyOn(store, 'ensureResultArtifact');
      const stepDetails = [{ stepIndex: 0, atomIndex: 0, label: 'task', output: 'original step output' }];
      let complete!: () => void;
      executor.execute.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            complete = () => {
              if (outcome === 'completed') resolve({ finalOutput: 'original result', stepDetails });
              else
                reject(
                  new WorkflowExecutionError('original executor failure', {
                    aborted: outcome === 'aborted',
                    stepDetails,
                    ...(outcome === 'aborted'
                      ? { terminalOutcome: { kind: 'aborted', reason: 'user_abort' } as const }
                      : {}),
                  }),
                );
            };
          }),
      );
      const service = new WorkflowExecutionService({
        runtime,
        runningJobs,
        abortRegistry,
        backendNamespace: 'test',
        bundleHash: 'test',
        providerRegistry: { get: () => ({}), decodeCompleteScope: () => ({ ok: true, value: TEST_CODEX_SCOPE }) },
        progressStore: store,
        coordinatorCommit: commit,
        executionFinisher: finisher,
        launchOrchestrator: { markJobRunning: () => {} },
        executionPort: {},
      } as unknown as WorkflowExecutionServiceDeps);

      try {
        const result = await service.executeWorkflow({
          providerName: 'codex',
          ast: [[{ kind: 'prompt', text: 'task' }]],
          input: { expression: 'task', provider: 'codex', startPrompt: 'task', workDir },
          ctx: {
            projectRoot: workDir,
            pluginRoot: '/plugin',
            coralEnv: {},
            principal: testProjectPrincipal(workDir),
            providerScope: TEST_CODEX_SCOPE,
          },
          workDir,
        });
        if (!('kind' in result) || result.kind !== 'workflow') throw new Error('workflow launch refused');
        const address = { jobId: result.jobId, execution: 1 };
        expect(runningJobs.has(result.jobId)).toBe(true);
        runtime.time.tick(100);
        complete();
        await flushMicrotasks(50);

        expect(acceptanceAttempts).toHaveBeenCalledTimes(1);
        expect(runningJobs.has(result.jobId)).toBe(true);
        expect(abortRegistry.getSignal(result.jobId)).not.toBeNull();
        expect(finisher.owns(address)).toBe(true);
        expect(finisher.state(address).kind).toBe('unaccepted');
        expect(journal.events().some((event) => event.type === 'workflow.completed')).toBe(false);
        expect(artifact).not.toHaveBeenCalled();

        storageUnavailable = false;
        runtime.time.tick(500);
        await flushMicrotasks(50);
        expect(runningJobs.has(result.jobId)).toBe(false);
        expect(abortRegistry.getSignal(result.jobId)).toBeNull();
        runtime.time.tick(500);
        await flushMicrotasks(50);

        const events = journal.events();
        expect(acceptanceAttempts).toHaveBeenCalledTimes(2);
        expect(executor.execute).toHaveBeenCalledTimes(1);
        expect(events.filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'job.execution.ended')).toHaveLength(1);
        expect(events.at(-1)?.type).toBe('job.execution.ended');
        const workflowEnds = events.filter((event) => event.type === 'workflow.completed');
        expect(workflowEnds).toHaveLength(1);
        expect(workflowEnds[0].body).toMatchObject({ outcome, stepDetails });
        const state = finisher.state(address);
        expect(state.kind).toBe('ended');
        if (state.kind !== 'ended') throw new Error('workflow did not end');
        expect(state.accepted).toMatchObject({
          execution: 1,
          terminal: {
            content: outcome === 'completed' ? 'original result' : '',
            durationMs: 100,
            outcome: outcome === 'aborted' ? { kind: 'aborted', reason: 'user_abort' } : { kind: outcome },
          },
        });
        const faults = events.filter((event) => event.type === 'workflow.lifecycle_fault');
        expect(faults).toHaveLength(outcome === 'failed' ? 1 : 0);
        if (outcome === 'failed') expect(faults[0].body).toMatchObject({ message: 'original executor failure' });
        expect(artifact).toHaveBeenCalledTimes(1);
      } finally {
        await finisher.dispose();
        journal.db.close();
        executor.execute.mockReset();
      }
    },
  );
});
