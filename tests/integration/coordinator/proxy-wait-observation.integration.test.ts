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
import { createProviderEventHandler } from '#src/coordinator/services/provider-event-application.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
import { ProviderProxySetLifecycleRef } from '#src/coordinator/services/provider-proxy-set/lifecycle-ref.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { formatWaitProgress, formatWaitWaiting } from '#src/cli/format/wait.js';
import { collectLocalCarrierInputs } from '#src/coordinator/composition/carrier-observation.js';
import { carrierStatusOperationKey, observeCarrierStatuses } from '#src/coordinator/live/carrier-observer.js';
import { JobStore } from '#src/jobs/store.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { WaitStreamEvent } from '#src/jobs/wait/contract.js';
import type { CarrierWaitObservation } from '#src/jobs/shell/wait.js';
import { connectControlClient } from '#src/provider-proxy/control-client.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import { proxyOperationStatusNonceSchema } from '#src/provider-proxy/protocol.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { insertProviderOperation, readProviderOperationForJob } from '#src/store/provider-operation-journal.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { asJointContainmentReceipt, asReservation } from '#tests/helpers/provider-proxy-correlation.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { strictControlExchangeResult } from '#tests/support/control-exchange.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { defineFakeProvider } from '#tests/helpers/scripted-provider.js';
import { testChildPrincipalRegistry } from '#tests/helpers/child-principal-registry.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { TEST_CODEX_SCOPE } from '#tests/helpers/provider-credentials.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { streamProviderTerminal } from '#src/providers/stream.js';

it.each(['completion', 'handoff'] as const)(
  'observes a progressing local app-server placement through production assembly (%s)',
  async (ending) => {
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
    let turnExited = false;
    const turnFinished = new Promise<void>((resolve) => {
      finishTurn = resolve;
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
          turnExited = true;
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
      providerHostManager: { routeAppServerOperation: route, awaitAppServerOperationRoute: awaitRoute },
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
    let quiesced = false;
    try {
      const launch = await service.start('codex', { prompt: 'local placement reproduction' }, ctx);
      expect(launch.status).toBe('running');
      if (launch.status !== 'running') throw new Error('expected a running launch');
      jobId = launch.jobId;
      await vi.waitFor(() =>
        expect(store.readJobEvents(launch.jobId)).toContainEqual(
          expect.objectContaining({ type: 'progress', message: 'local turn progressing' }),
        ),
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
      if (ending === 'completion') {
        finishTurn();
        await vi.waitFor(() => expect(localService?.holdsLocalAppServerExecution(launch.jobId)).toBe(false));
        expect(store.readStatus(jobId)?.phase).toBe('completed');
        return;
      }
      quiesced = true;
      await localService.quiesceAppServerJobsForHandoff();
      expect(launchCoordinator.reservationFor(jobId)).not.toBeNull();
      observedPasses.length = 0;
      const unknown: WaitStreamEvent[] = [];
      for await (const event of service.waitStream({ jobIds: [jobId], timeoutSeconds: 0.01 })) unknown.push(event);
      const unknownWaiting = unknown.find((event) => event.type === 'waiting');
      if (unknownWaiting?.type !== 'waiting') throw new Error('expected a quiesced waiting event');
      expect(formatWaitWaiting(unknownWaiting, null)).toContain(`Carrier unconfirmed for: ${jobId}`);
      expect(observedPasses.length).toBeGreaterThan(0);
      expect(observedPasses.every((pass) => pass.length === 1 && pass[0]?.liveness === 'unknown')).toBe(true);
      expect(store.readStatus(jobId)?.phase).toBe('running');
    } finally {
      finishTurn();
      if (jobId !== undefined) {
        const observedJobId = jobId;
        await vi.waitFor(() => {
          expect(turnExited).toBe(true);
          expect(store.readStatus(observedJobId)?.phase).toBe(quiesced ? 'running' : 'completed');
        });
      }
      services.stopProviderOperationReconciler();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('observes a progressing inherited proxy through execution-service assembly and the wait formatter', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coral-proxy-wait-'));
  const endpoint = join(directory, 'proxy.sock');
  const realRuntime = createRealRuntime('prod');
  const runtime = {
    ...realRuntime,
    time: { ...realRuntime.time, now: () => Date.parse('2026-08-09T12:34:56.000Z') },
  };
  const fixture = providerOperationRecord('executing');
  if (fixture.phase !== 'executing') throw new Error('expected an executing operation');
  const record = {
    ...fixture,
    locator: { ...fixture.locator, proxy: { ...fixture.locator.proxy, controlEndpoint: endpoint } },
  };
  const { operation, locator } = record;
  const shared = {
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: operation.buildSetId,
    hostFingerprint: locator.hostFingerprint,
    guardianInstanceId: locator.guardian.instanceId,
    reaperInstanceId: locator.reaper.instanceId,
    proxyInstanceId: operation.proxyInstanceId,
    bootstrapNonce: 'a'.repeat(64),
  };
  const proxy = createProxy({
    capsule: {
      role: 'proxy',
      ...shared,
      canonicalEndpoint: endpoint,
      guardianControlEndpoint: join(directory, 'g.sock'),
      proxyGuardianAuthSecret: 'b'.repeat(64),
    },
    identity: {
      ...shared,
      pid: locator.proxy.pid,
      incarnation: locator.proxy.incarnation,
      processGroupId: locator.containment.processGroupId,
      canonicalEndpoint: endpoint,
    },
    clock: createMonotonicClock(Symbol('proxy-wait'), { readMilliseconds: () => 0n }),
    timer: runtime.time,
    mintChallenge: randomUUID,
    mintReceipt: randomUUID,
    mintReservation: () => asReservation(randomUUID()),
    wallClockNow: () => Date.parse('2026-08-09T12:34:56.000Z'),
    host: {
      start: () => ({
        result: Promise.resolve({
          kind: 'started',
          hostRef: {
            provider: 'codex',
            fingerprint: locator.hostFingerprint,
            instanceId: 'shared',
            leaseMode: 'shared',
          },
        }),
        abortAndRelease: async () => {},
      }),
      stop: async () => {},
    },
    containment: {
      stageProviderRoot: () => ({
        result: Promise.resolve({
          state: 'staged',
          providerRoot: fixture.providerRoot,
          receipt: asJointContainmentReceipt('contained'),
        }),
        confirmActivation: async () => {},
        abortAndRelease: async () => {},
      }),
    },
  });
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const eventBus = new TypedEventBus();
  const store = new JobStore('proxy-wait', runtime, createEventBodyCodec(), {
    db,
    eventBus,
    providers: permissiveProviderLookupPort,
  });
  const registry = new LocalOperationRegistry();
  const launchCoordinator = new LaunchCoordinator({ runtime });
  const providerRegistry = new ProviderRegistry();
  const world = {
    identity: { instanceId: randomUUID(), buildSetId: operation.buildSetId },
    storeServicesRef: { tryGet: () => ({ progressStore: store }) },
    operationRegistry: registry,
    providerProxyClaims: new ProviderProxySetClaimMirror(),
    providerProxyLifecycleRef: new ProviderProxySetLifecycleRef(),
    providerHostManager: {},
    launchCoordinator,
    startupRecoveryBarrier: { hasPassed: () => true },
    eventBus,
    providerRegistry,
    pluginRegistry: {},
  } as unknown as CoordinatorWorld;
  const observedPasses: CarrierWaitObservation[][] = [];
  const services = createExecutionServices({
    world,
    runtime,
    bundleHash: 'proxy-wait',
    backendNamespace: 'proxy-wait',
    settlementRefusalRecorder: { record: () => true },
    onProviderProxyLifecycleFatal: (error) => {
      throw error;
    },
    createExecutionService: (ctx, deps) => {
      const observeCarriers = deps.observeCarriers;
      if (observeCarriers === undefined) throw new Error('expected the production carrier observer');
      vi.spyOn(deps, 'observeCarriers').mockImplementation(async (jobIds) => {
        const observations = await observeCarriers(jobIds);
        observedPasses.push(observations);
        return observations;
      });
      return new ExecutionService(ctx, deps);
    },
  });
  let control: Awaited<ReturnType<typeof connectControlClient>> | undefined;
  try {
    await proxy.listen();
    control = await connectControlClient(
      endpoint,
      runtime.time,
      1_000,
      createProviderEventHandler({
        db,
        progressStore: store,
        appendContext: {
          now: () => new Date(runtime.time.now()),
          reducers: composeReducers(jobsRegistry),
          bodyCodec: store.bodyCodec,
          providers: permissiveProviderLookupPort,
        },
        providerRegistry,
        runtime,
        emitSessionReleased: (payload) => eventBus.emit('session:released', payload),
        recordedStopCauseFor: (identity) => registry.recordedStopCauseFor(identity),
        observeCommitted: (appended) => store.announceCommitted(appended),
        operations: { settled: (identity) => registry.settled(identity) },
      }),
    );
    const opened = (await strictControlExchangeResult(control, 'control.open.v1', {
      bootstrapNonce: shared.bootstrapNonce,
      coordinator: {
        instanceId: randomUUID(),
        pid: process.pid,
        incarnation: locator.proxy.incarnation,
        generation: 'gen2',
        flavor: 'prod',
        buildSetId: operation.buildSetId,
      },
    })) as { controlEpoch: number; heartbeatChallenge: string };
    await strictControlExchangeResult(control, 'control.heartbeat.v1', {
      controlEpoch: opened.controlEpoch,
      heartbeatChallenge: opened.heartbeatChallenge,
    });
    const prepared = (await strictControlExchangeResult(control, 'operation.prepare.v1', {
      operation,
      hostFingerprint: locator.hostFingerprint,
      prepareAttemptNumber: 1,
      prepared: {
        version: 1,
        provider: 'codex',
        binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
        request: {
          action: 'exec',
          sessionId: operation.jobId,
          prompt: 'progress fixture',
          cwd: fixtureCanonicalWorkDir(directory),
          bypassPermissions: false,
          coralEnv: {},
        },
        persistedContinuity: null,
        baseEnv: {},
        protectedEnv: {},
        platform: 'linux',
      },
    })) as { reservation: string; jointContainmentReceipt: string };
    await strictControlExchangeResult(control, 'operation.activate.v1', {
      operation,
      reservation: prepared.reservation,
      jointContainmentReceipt: prepared.jointContainmentReceipt,
      jointActivationReceipt: 'activated',
    });
    insertProviderOperation(db, record);
    seedTestSessionProjection(db, {
      sessionId: operation.jobId,
      provider: 'codex',
      projectRoot: directory,
      backendNamespace: 'proxy-wait',
      activeJobId: operation.jobId,
    });
    store.appendLaunchRequested(operation.jobId, {
      jobId: operation.jobId,
      owner: { kind: 'provider-session', id: operation.jobId },
      sessionId: operation.jobId,
      provider: 'codex',
      projectRoot: directory,
      backendNamespace: 'proxy-wait',
      pool: 'default',
      enqueueSequence: 1,
      createdAt: '2026-08-09T12:34:55.000Z',
      jobKind: 'provider',
      providerAction: 'exec',
      request: {
        prompt: 'progress fixture',
        cwd: fixtureCanonicalWorkDir(directory),
        bypassPermissions: false,
        coralEnv: {},
      },
    });
    store.appendRuntimeStarted(operation.jobId, {
      transport: 'app-server',
      startTime: '2026-08-09T12:34:56.000Z',
      providerMeta: {
        provider: 'codex',
        leaseState: 'acquired',
        hostRef: { provider: 'codex', fingerprint: locator.hostFingerprint, instanceId: 'shared', leaseMode: 'shared' },
      },
    });
    await strictControlExchangeResult(control, 'operation.attach.v1', { operation, committedThroughProviderSeq: 0 });
    expect(proxy.emitProviderEvent(operation, { kind: 'progress', message: 'still progressing' })).toMatchObject({
      kind: 'recorded',
      providerSeq: 1,
    });
    await vi.waitFor(() =>
      expect(store.readJobEvents(operation.jobId)).toContainEqual(
        expect.objectContaining({ type: 'progress', message: 'still progressing' }),
      ),
    );
    const registries = {
      getDb: () => db,
      loadJobProjectionDetail: (id: string) => store.loadJobProjectionDetail(id),
      platform: process.platform,
      hasStartupRecoveryPassed: () => true,
      isAdmittedByThisCoordinator: () => false,
      registryStateForJob: (id: string) => registry.stateForJob(id),
    };
    const [collected] = collectLocalCarrierInputs([operation.jobId], registries, 3);
    expect(collected?.input.evidence).toEqual({ carrierClass: 'app-server-acquired', registryState: 'inherited' });
    expect(collected?.providerOperation).toMatchObject({ operation, locator, committedThroughProviderSeq: 1 });
    const statuses = await observeCarrierStatuses([record], {
      timer: runtime.time,
      mintNonce: () => proxyOperationStatusNonceSchema.parse(randomUUID()),
      log: () => {},
    });
    expect(statuses.get(carrierStatusOperationKey(operation))).toBe('held');
    const service = services.getExecutionService({
      projectRoot: fixtureCanonicalWorkDir(directory),
      pluginRoot: directory,
      coralEnv: {},
      principal: {
        subject: 'system',
        transport: 'internal',
        credential: { kind: 'internal', id: 'proxy-wait' },
        binding: { kind: 'project', root: fixtureCanonicalWorkDir(directory) },
      },
    });
    const events: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: [operation.jobId], timeoutSeconds: 0.01 }))
      events.push(event);
    const waiting = events.find((event) => event.type === 'waiting');
    if (waiting?.type !== 'waiting') throw new Error('expected a waiting event');
    const output = events
      .filter((event) => event.type === 'progress')
      .map((event) => formatWaitProgress(event))
      .concat(formatWaitWaiting(waiting, null))
      .join('\n');
    expect(output).toContain('still progressing');
    expect(output).not.toContain('Carrier unconfirmed');
    expect(waiting.carrierUnknownJobIds).toBeUndefined();
    expect(observedPasses.length).toBeGreaterThan(0);
    expect(observedPasses.every((pass) => pass.length === 1 && pass[0]?.liveness === 'live')).toBe(true);
    observedPasses.length = 0;
    await proxy.close();
    const unknown: WaitStreamEvent[] = [];
    for await (const event of service.waitStream({ jobIds: [operation.jobId], timeoutSeconds: 0.01 }))
      unknown.push(event);
    const unknownWaiting = unknown.find((event) => event.type === 'waiting');
    if (unknownWaiting?.type !== 'waiting') throw new Error('expected an unobservable waiting event');
    expect(formatWaitWaiting(unknownWaiting, null)).toContain(`Carrier unconfirmed for: ${operation.jobId}`);
    expect(observedPasses.length).toBeGreaterThan(0);
    expect(observedPasses.every((pass) => pass.length === 1 && pass[0]?.liveness === 'unknown')).toBe(true);
    expect(store.readStatus(operation.jobId)?.phase).toBe('running');
  } finally {
    control?.close();
    services.stopProviderOperationReconciler();
    await proxy.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
