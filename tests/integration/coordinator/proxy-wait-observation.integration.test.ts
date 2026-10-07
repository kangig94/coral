import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

import { createExecutionServices } from '#src/coordinator/composition/execution-services.js';
import type { CoordinatorWorld } from '#src/coordinator/composition/world.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set/lifecycle-ref.js';
import { formatWaitProgress, formatWaitWaiting } from '#src/cli/format/wait.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';
import type { CarrierWaitObservation } from '#src/jobs/shell/wait.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { readProviderOperationForJob } from '#src/store/provider-operation-journal.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { defineFakeProvider } from '#tests/helpers/scripted-provider.js';
import { testChildPrincipalRegistry } from '#tests/helpers/child-principal-registry.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { TEST_CODEX_SCOPE } from '#tests/helpers/provider-credentials.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { streamProviderTerminal } from '#src/providers/stream.js';

function progressRecorded(eventBus: TypedEventBus, message: string): Promise<void> {
  return new Promise((resolve) => {
    const listener = (progress: { message: string }): void => {
      if (progress.message !== message) return;
      eventBus.off('job:progress', listener);
      resolve();
    };
    eventBus.on('job:progress', listener);
  });
}

it('observes a progressing local app-server placement through production assembly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coral-local-wait-'));
  const runtime = createRealRuntime('prod');
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const eventBus = new TypedEventBus();
  const store = new JobStore('local-wait', runtime, createEventBodyCodec(), {
    db,
    eventBus,
    providers: permissiveProviderLookupPort,
    reducers: composeReducers(jobsRegistry, sessionsRegistry),
  });
  const registry = new LocalOperationRegistry();
  const launchCoordinator = new LaunchCoordinator({ runtime });
  const providerRegistry = new ProviderRegistry();
  let finishTurn!: () => void;
  let markTurnExited!: () => void;
  const turnFinished = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  const turnExited = new Promise<void>((resolve) => {
    markTurnExited = resolve;
  });
  const definition = defineFakeProvider({
    name: 'codex',
    appServerLifecycle: {
      host: {
        provider: 'codex',
        command: 'fixture',
        args: [],
        cwd: canonicalWorkDirWireSchema.parse(directory),
        leaseMode: 'shared',
        idleRetirement: 'never',
      },
      interrupt: async () => {},
      finalizeInterrupted: () => ({ kind: 'preserve' }),
    },
    execute: async function* () {
      try {
        yield { kind: 'progress' as const, message: 'local turn progressing' };
        await turnFinished;
        yield* streamProviderTerminal({ content: 'done', outcome: { kind: 'completed' }, durationMs: 1 });
      } finally {
        markTurnExited();
      }
    },
  });
  if (definition === undefined) throw new Error('expected a fixture provider');
  providerRegistry.register(definition);
  providerRegistry.connectAppServerHost({
    openSession: async () => ({
      session: {
        rpc: async <R>() => ({}) as R,
        subscribe: () => () => {},
        closed: new Promise<Error | void>(() => {}),
      },
      hostRef: { provider: 'codex', fingerprint: 'f'.repeat(64), instanceId: 'local', leaseMode: 'shared' },
      close: () => {},
    }),
    attachSession: async () => null,
  });
  const route = vi.fn(() => null);
  const awaitRoute = vi.fn(async () => null);
  const world = {
    identity: { instanceId: randomUUID(), buildSetId: randomUUID() },
    storeServicesRef: { tryGet: () => ({ progressStore: store }) },
    operationRegistry: registry,
    providerProxyClaims: new ProviderProxySetClaimMirror(),
    providerProxyLifecycleRef: new ProviderProxySetLifecycleRef(),
    providerHostManager: {
      proxyHostRoot: () => '/test/plugin/bridge',
      routeAppServerOperation: route,
      awaitAppServerOperationRoute: awaitRoute,
    },
    launchCoordinator,
    startupRecoveryBarrier: { hasPassed: () => true },
    eventBus,
    providerRegistry,
    childPrincipalRegistry: testChildPrincipalRegistry(runtime.ids, { db, namespace: 'local-wait' }),
    pluginRegistry: { discoverPluginRoot: () => null },
  } as unknown as CoordinatorWorld;
  const observedPasses: CarrierWaitObservation[][] = [];
  let localService: ExecutionService | undefined;
  const services = createExecutionServices({
    world,
    runtime,
    bundleHash: 'local-wait',
    backendNamespace: 'local-wait',
    settlementRefusalRecorder: { record: () => true },
    onProviderProxyLifecycleFatal: (error) => {
      throw error;
    },
    createExecutionService: (ctx, deps) => {
      const observe = deps.observeCarriers;
      if (observe === undefined) throw new Error('expected the production observer');
      vi.spyOn(deps, 'observeCarriers').mockImplementation(async (ids) => {
        const pass = await observe(ids);
        observedPasses.push(pass);
        return pass;
      });
      localService = new ExecutionService(ctx, deps);
      return localService;
    },
  });
  const ctx = {
    projectRoot: fixtureCanonicalWorkDir(directory),
    pluginRoot: directory,
    coralEnv: {},
    principal: testProjectPrincipal(directory),
    providerScope: TEST_CODEX_SCOPE,
  };
  const service = services.getExecutionService(ctx);
  let jobId: string | undefined;
  const progressed = progressRecorded(eventBus, 'local turn progressing');
  try {
    const launch = await service.start('codex', { prompt: 'local placement reproduction' }, ctx);
    expect(launch.status).toBe('running');
    if (launch.status !== 'running') throw new Error('expected a running launch');
    jobId = launch.jobId;
    await progressed;
    expect(store.readJobEvents(launch.jobId)).toContainEqual(
      expect.objectContaining({ type: 'progress', message: 'local turn progressing' }),
    );
    expect(route).toHaveBeenCalledOnce();
    expect(awaitRoute).toHaveBeenCalledOnce();
    expect(store.loadJobProjectionDetail(jobId).runtime).toMatchObject({
      transport: 'app-server',
      providerMeta: { leaseState: 'acquired', hostRef: { leaseMode: 'shared' } },
    });
    expect(registry.stateForJob(jobId)).toBeNull();
    expect(readProviderOperationForJob(db, jobId)).toBeNull();
    expect(launchCoordinator.reservationFor(jobId)).not.toBeNull();
    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: [jobId], timeoutSeconds: 0.01 })) events.push(event);
    const waiting = events.find((event) => event.type === 'waiting');
    if (waiting?.type !== 'waiting') throw new Error('expected a waiting event');
    const output = events
      .filter((event) => event.type === 'progress')
      .map((event) => formatWaitProgress(event))
      .concat(formatWaitWaiting(waiting, null))
      .join('\n');
    expect(output).toContain('local turn progressing');
    expect(output).not.toContain('Carrier unconfirmed');
    expect(observedPasses.length).toBeGreaterThan(0);
    expect(observedPasses.every((pass) => pass.length === 1 && pass[0]?.liveness === 'live')).toBe(true);
    if (localService === undefined) throw new Error('expected a local execution service');
    // see LaunchOrchestrator.runAsync in src/jobs/shell/launch.ts
    const release = launchCoordinator.releaseLaunch.bind(launchCoordinator);
    const released = new Promise<void>((resolve) => {
      vi.spyOn(launchCoordinator, 'releaseLaunch').mockImplementation((permit) => {
        const outcome = release(permit);
        resolve();
        return outcome;
      });
    });
    finishTurn();
    await released;
    expect(localService.holdsLocalAppServerExecution(launch.jobId)).toBe(false);
    expect(store.readStatus(jobId)?.phase).toBe('completed');
  } finally {
    finishTurn();
    if (jobId !== undefined) {
      await turnExited;
      expect(store.readStatus(jobId)?.phase).toBe('completed');
    }
    services.stopProviderOperationReconciler();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
