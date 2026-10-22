import { ProviderRegistry } from '#src/providers/registry.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { recordProviderTerminal } from '#src/coordinator/services/terminal-materializer.js';
import { describe, expect, it } from 'vitest';

import { JobAbortService } from '#src/coordinator/services/job-abort.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { QueuedHandle } from '#src/jobs/contracts/admission.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const jobId = '10000000-0000-4000-8000-000000000001';

describe('jobs abort command', () => {
  it('terminalizes an aborted queued job as aborted and releases its claim', async () => {
    const runtime = new SimulationRuntime();
    const db = newRawDatabase(':memory:');
    const eventBus = new TypedEventBus();
    const released = createDeferred<void>();
    eventBus.on('job:completed', () => released.resolve());
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    try {
      const store = new JobStore('test', runtime, createEventBodyCodec(), {
        db,
        eventBus,
        providers: permissiveProviderLookupPort,
        reducers: composeReducers(jobsRegistry),
      });
      const registry = new AbortRegistry();
      const coordinator = new LaunchCoordinator({ runtime });
      const sessions = new ConversationManager('/project', runtime, (cb) => store.commit(cb), db);
      const session = sessions.prepare({
        jobId: jobId,
        binding: TEST_CODEX_BINDING,
        name: 'test',
        cwd: fixtureCanonicalWorkDir('/project'),
        projectRoot: '/project',
        backendNamespace: 'test',
      });
      let queued = true;
      const admission: QueuedHandle = {
        type: 'queued',
        queuePosition: 1,
        waitForPermit: () => new Promise(() => {}),
        cancel: () => {
          queued = false;
          return { kind: 'cancelled' };
        },
      };
      const executionFinisher = new ExecutionFinisher({
        time: { sleep: async () => {} },
        commit: (cb) => store.commit(cb),
        read: (address) => readExecutionFinishingState(db, address, store),
        quiesce: async () => true,
        retentionAction: async () => ({ attempt: 0, handles: [] }),
        settleRetention: async () => ({ kind: 'completed', outcome: 'skipped_no_handles' }),
      });
      const orchestrator = new LaunchOrchestrator({
        executionFinisher,
        runtime,
        progressStore: store,
        conversationManager: sessions,
        abortRegistry: registry,
        backendNamespace: 'test',
        bundleHash: 'test',
        providerRegistry: new ProviderRegistry(),
        providerOperationBinding: coordinator,
        durableSpawner: coordinator,
        launchAdmission: {
          requestLaunch: () => admission,
          releaseLaunch: (permit) => coordinator.releaseLaunch(permit),
          reservationFor: () =>
            queued
              ? {
                  kind: 'queued',
                  reservationId: 'queue-reservation',
                  pool: 'default',
                  provider: 'codex',
                  executionOwner: { kind: 'provider-session', id: jobId },
                  position: 1,
                }
              : null,
        },
        coordinatorCommit: (cb) => store.commit(cb),
        settlementRefusalRecorder: { record: () => true },
        terminalMaterializer: { recordProviderTerminal },
      });
      const provider: BoundProvider = {
        name: 'codex',
        envelope: TEST_CODEX_BINDING,
        present: () => 'Codex fixture',
        artifacts: { kind: 'none', reason: 'fixture' },
        compareIdentity: () => ({ ok: true, value: true }),
        decodeContinuity: () => ({ ok: true, value: undefined }),
        readiness: async (use) => ({ ok: true, value: { ready: true, use } }),
        preflight: async () => ({ kind: 'satisfied' }),
        prepareExecution: () => {
          throw new Error('A cancelled queued job must not execute.');
        },
      };
      const decision = await orchestrator.launchExecution(
        provider,
        session,
        {
          action: 'exec',
          jobId: session.jobId,
          prompt: 'run',
          cwd: fixtureCanonicalWorkDir('/project'),
          bypassPermissions: false,
          coralEnv: {},
        },
        {
          owner: { kind: 'provider-session', id: session.jobId },
          mintProtectedEnv: () => ({}),
        },
      );
      expect(decision).toMatchObject({ status: 'queued' });
      expect(store.readStatus(jobId)?.phase).toBe('queued');
      const command = new JobAbortService({ abortRegistry: registry, readStatus: (jobId) => store.readStatus(jobId) });
      expect(command.abort([jobId])).toEqual({ aborted: [jobId], notFound: [] });
      await released.promise;
      expect(store.readStatus(jobId)).toMatchObject({
        phase: 'aborted',
        result: { outcome: { kind: 'aborted', reason: 'queue_shutdown' } },
      });
      expect(sessions.get('codex', session.jobId)?.open).toBe(false);
      expect(queued).toBe(false);
      expect(registry.has(jobId)).toBe(false);
    } finally {
      db.close();
    }
  });
});
