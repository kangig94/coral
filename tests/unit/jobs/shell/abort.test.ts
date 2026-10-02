import { describe, expect, it } from 'vitest';

import { JobAbortService } from '#src/coordinator/services/job-abort.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { QueuedHandle } from '#src/jobs/contracts/admission.js';
import type { BoundProvider } from '#src/providers/bound-provider-contract.js';
import { SessionManager } from '#src/sessions/shell.js';
import { sessionsRegistry } from '#src/sessions/events.js';
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

describe('jobs abort command', () => {
  it('terminalizes an aborted queued job as aborted and releases its claim', async () => {
    const runtime = new SimulationRuntime();
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    try {
      const store = new JobStore('test', runtime, createEventBodyCodec(), {
        db,
        providers: permissiveProviderLookupPort,
        reducers: composeReducers(jobsRegistry, sessionsRegistry),
      });
      const registry = new AbortRegistry(runtime.ids);
      const released = createDeferred<void>();
      const sessions = new SessionManager(
        '/project',
        runtime,
        undefined,
        () => released.resolve(),
        db,
        permissiveProviderLookupPort,
      );
      const session = sessions.prepare({
        binding: TEST_CODEX_BINDING,
        name: 'test',
        cwd: '/project',
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
      const orchestrator = new LaunchOrchestrator({
        runtime,
        progressStore: store,
        sessionManager: sessions,
        abortRegistry: registry,
        backendNamespace: 'test',
        bundleHash: 'test',
        providerRegistry: {} as never,
        providerOperationBinding: {} as never,
        durableSpawner: {} as never,
        launchAdmission: { requestLaunch: () => admission } as never,
        coordinatorCommit: (cb) => store.commit(cb),
        settlementRefusalRecorder: { record: () => true },
        terminalMaterializer: { recordProviderTerminal: () => {} },
      });
      const decision = orchestrator.launchInitialProviderJob(
        { name: 'codex' } as BoundProvider,
        session,
        {
          action: 'exec',
          sessionId: session.sessionId,
          prompt: 'run',
          cwd: fixtureCanonicalWorkDir('/project'),
          bypassPermissions: false,
          coralEnv: {},
        },
        {
          requestedJobId: 'queued-job',
          owner: { kind: 'provider-session', id: session.sessionId },
          mintProtectedEnv: () => ({}),
        },
      );
      expect(decision).toMatchObject({ status: 'queued' });
      expect(store.readStatus('queued-job')?.phase).toBe('queued');
      const command = new JobAbortService({ abortRegistry: registry });
      expect(command.abort(['queued-job'])).toEqual({ aborted: ['queued-job'], notFound: [] });
      await released.promise;
      expect(store.readStatus('queued-job')).toMatchObject({
        phase: 'aborted',
        result: { outcome: { kind: 'aborted', reason: 'queue_shutdown' } },
      });
      expect(sessions.get('codex', session.sessionId)?.activeJobId).toBeUndefined();
      expect(queued).toBe(false);
      expect(registry.has('queued-job')).toBe(false);
    } finally {
      db.close();
    }
  });
});
