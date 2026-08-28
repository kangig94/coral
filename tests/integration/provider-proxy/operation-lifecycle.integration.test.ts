import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { strictControlExchangeResult as strictTestExchange } from '#tests/support/control-exchange.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ProviderBootstrapMod from '#src/providers/bootstrap.js';

const providerRegistryDouble = vi.hoisted(() => ({
  rehydrateBinding: vi.fn(),
}));
vi.mock('#src/providers/bootstrap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderBootstrapMod>();
  return {
    ...actual,
    createBuiltInProviderRegistry: () => {
      const registry = actual.createBuiltInProviderRegistry();
      return {
        ...registry,
        connectAppServerHost: registry.connectAppServerHost.bind(registry),
        sealPersistedCodecComponents: registry.sealPersistedCodecComponents.bind(registry),
        rehydrateBinding: (binding: unknown) => providerRegistryDouble.rehydrateBinding(binding),
      };
    },
  };
});

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { createRealTimePort } from '#src/infra/time.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import type { HostRef } from '#src/providers/contract.js';
import { heartbeatOnce } from '#src/coordinator/live/provider-proxy/heartbeat.js';
import {
  connectControlClient,
  controlExchangeForTest,
  ControlClientError,
  type ControlClient,
  type ControlExchange,
  type ProviderEventHandler,
} from '#src/provider-proxy/control-client.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { compareAndSwapProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import { createAppServerProxyRoute } from '#src/coordinator/services/provider-proxy-launch-route.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { createProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import {
  inspectProviderOperation,
  prepareProviderOperation,
  providerOperationPrepareAttempt,
  type ProviderProxyOperationActivationDeps,
} from '#src/coordinator/services/provider-proxy-operation-activation.js';
import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import {
  MAX_PROXY_OPERATION_LEDGERS,
  MAX_PROVIDER_REPLAY_BYTES,
  MAX_PROVIDER_REPLAY_EVENTS,
} from '#src/provider-proxy/ledger.js';
import { proxyHandoffRedeemResultSchema } from '#src/coordinator/live/provider-proxy/control-redemption.js';
import { PROXY_CONTROL_HEARTBEAT_MS, PROXY_CONTROL_LEASE_MS } from '#src/provider-proxy/orphan-deadline.js';
import {
  decodeProxyControlFrame,
  providerEventRequestSchema,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';
import { createProxyGuardianContainment } from '#src/provider-proxy/role-main.js';
import { createProxy, type Proxy } from '#src/provider-proxy/proxy.js';
import type {
  OperationStageHandle,
  SemanticOperationHost,
  SemanticOperationStartHandle,
} from '#src/provider-proxy/operation-supervisor.js';
import type { ProxyAppServerHostAuthority } from '#src/provider-proxy/provider-root-authority.js';
import { createSemanticOperationRuntime } from '#src/provider-proxy/semantic-operation-runner.js';
import { asJointContainmentReceipt, asReservation } from '#tests/helpers/provider-proxy-correlation.js';

const NONCE = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const GRANT_SECRET = 'f'.repeat(64);
const WALL_CLOCK_EPOCH_MS = Date.parse('2026-08-09T12:34:56.000Z');

function hostRefFor(jobId: string): HostRef {
  return {
    provider: PREPARED.provider,
    fingerprint: FINGERPRINT,
    instanceId: `host:${jobId}`,
    leaseMode: 'job-exclusive',
    ownerJobId: jobId,
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  providerRegistryDouble.rehydrateBinding.mockReset();
});

const timer: ControlEndpointTimer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

function resultExchange(value: unknown): ControlExchange {
  return controlExchangeForTest({ kind: 'response', response: { kind: 'result', value } });
}

function noResponse(error: ControlClientError): ControlExchange {
  return controlExchangeForTest({ kind: 'no-response', cause: 'connection-closed-after-write', error });
}

function refusedExchange(error: ControlClientError): ControlExchange {
  if (error.remoteFailure === null) return noResponse(error);
  return controlExchangeForTest({
    kind: 'response',
    response: { kind: 'refusal', failure: error.remoteFailure, error },
  });
}

type Started = { jobId: string; operationId: string };

async function startProxy(
  options: {
    prepareRefusal?: Readonly<{
      state: 'permanent-refusal';
      code: 'provider_creation_refused';
      disposition: 'local-fallback';
      reason: string;
    }>;
    blockFirstProviderCreation?: boolean;
    failProviderCreation?: boolean;
    failConfirmActivation?: boolean;
    failStart?: boolean;
    timer?: ControlEndpointTimer;
    onProviderEvent?: ProviderEventHandler;
    openingDelayMs?: number;
    skipInitialHeartbeat?: boolean;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'coral-proxy-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const endpoint = join(directory, 'p.sock');

  const shared = {
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId: randomUUID(),
    hostFingerprint: FINGERPRINT,
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId: randomUUID(),
    bootstrapNonce: NONCE,
  };
  const coordinator = {
    instanceId: randomUUID(),
    pid: 4_000,
    incarnation: testIncarnation(700),
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
  };
  const identity = {
    proxyInstanceId: shared.proxyInstanceId,
    pid: 6_000,
    incarnation: testIncarnation(850),
    processGroupId: 6_000,
    guardianInstanceId: shared.guardianInstanceId,
    reaperInstanceId: shared.reaperInstanceId,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalEndpoint: endpoint,
  };

  let elapsed = 0n;
  const clock = createMonotonicClock(Symbol('proxy-lifecycle'), { readMilliseconds: () => elapsed });
  const started: Array<Started & { prepared: ProxyPreparedAppServerOperation }> = [];
  const stopped: Array<Started & { cause: string }> = [];
  const released: Started[] = [];
  const releasedMemberships: Started[] = [];
  let startAttempts = 0;
  const host: SemanticOperationHost = {
    // Recording `prepared` (not just `key`) is what exposes a host that starts with the wrong payload: the
    // proxy must hand over the envelope prepare validated, not activate's own request params.
    start: ({ key, prepared }) => {
      startAttempts += 1;
      if (options.failStart === true) {
        return {
          result: Promise.reject(new Error('the semantic kernel failed to start')),
          abortAndRelease: async () => {},
        };
      }
      started.push({ ...key, prepared });
      const handle: SemanticOperationStartHandle = {
        result: Promise.resolve({ kind: 'started', hostRef: hostRefFor(key.jobId) }),
        abortAndRelease: async () => {},
      };
      return handle;
    },
    stop: ({ key, cause }) => {
      stopped.push({ ...key, cause });
    },
  };

  let receipts = 0;
  let stageAttempts = 0;
  let providerCreationAttempts = 0;
  const providerCreationJobs: string[] = [];
  let releaseFirstProviderCreation: () => void = () => undefined;
  const firstProviderCreationReleased = new Promise<void>((resolve) => {
    releaseFirstProviderCreation = resolve;
  });
  let observeFirstProviderCreation: () => void = () => undefined;
  const firstProviderCreationEntered = new Promise<void>((resolve) => {
    observeFirstProviderCreation = resolve;
  });
  const proxyRef: { current: Proxy | null } = { current: null };
  const semantic =
    options.failProviderCreation === true || options.blockFirstProviderCreation === true
      ? (() => {
          providerRegistryDouble.rehydrateBinding.mockReturnValue({
            ok: true,
            value: {
              name: PREPARED.provider,
              appServer: {
                openReplacement: async (_input: unknown, hostOptions: { jobId?: string }) => {
                  providerCreationAttempts += 1;
                  const jobId = hostOptions.jobId ?? 'unknown-job';
                  providerCreationJobs.push(jobId);
                  if (options.blockFirstProviderCreation === true && providerCreationAttempts === 1) {
                    observeFirstProviderCreation();
                    await firstProviderCreationReleased;
                  }
                  if (options.failProviderCreation === true) {
                    throw new Error('the provider root could not be created');
                  }
                  return { hostRef: hostRefFor(jobId), close: () => {} };
                },
              },
            },
          });
          const hostAuthority = {
            beginOperation: () => ({
              selectCancellationMode: () => {},
              openSession: () => {
                throw new Error('provider creation refusal must not open a host session');
              },
              attachSession: async () => null,
            }),
            rootIdentity: () => ({ pid: 7_001, incarnation: testIncarnation(800) }),
            closed: () => new Promise<Error | void>(() => {}),
            forceClose: async () => {},
          } as unknown as ProxyAppServerHostAuthority;
          return createSemanticOperationRuntime({
            runtime: createRealRuntime('prod'),
            hostAuthority,
            getProxy: () => {
              if (proxyRef.current === null) throw new Error('Proxy is not ready.');
              return proxyRef.current;
            },
          });
        })()
      : null;
  const semanticContainment =
    semantic === null
      ? null
      : createProxyGuardianContainment({
          identity,
          guardianChannel: {
            exchange: async (method, params) => {
              if (options.failProviderCreation === true) {
                throw new Error('provider creation refusal must not register guardian membership');
              }
              if (method === 'guardian.register-provider-root.v1') {
                const root = params as { providerPid: number; providerIncarnation: ProcessIncarnation };
                return resultExchange({
                  state: 'staged-contained',
                  providerRoot: {
                    pid: root.providerPid,
                    incarnation: root.providerIncarnation,
                  },
                  jointContainmentReceipt: 'joint-1',
                });
              }
              return resultExchange({ state: 'membership-released' });
            },
          },
          stageProviderRoot: semantic.stage,
        });
  const proxy = createProxy({
    capsule: {
      role: 'proxy',
      ...shared,
      canonicalEndpoint: endpoint,
      guardianControlEndpoint: join(directory, 'g.sock'),
      proxyGuardianAuthSecret: 'c'.repeat(64),
    },
    clock,
    identity,
    host: semantic?.host ?? host,
    timer: options.timer ?? timer,
    mintChallenge: () => randomUUID(),
    mintReceipt: () => {
      receipts += 1;
      return `receipt-${receipts}`;
    },
    mintReservation: () => asReservation(randomUUID()),
    wallClockNow: () => WALL_CLOCK_EPOCH_MS + Number(elapsed),
    containment: semanticContainment ?? {
      stageProviderRoot: (key) => {
        stageAttempts += 1;
        const guardianRegistered = options.prepareRefusal === undefined;
        const result = (
          options.prepareRefusal !== undefined
            ? Promise.resolve(options.prepareRefusal)
            : Promise.resolve({
                state: 'staged' as const,
                providerRoot: { pid: 7_001, incarnation: testIncarnation(800) },
                receipt: asJointContainmentReceipt('joint-1'),
              })
        ) as OperationStageHandle['result'];
        let releasedStage = false;
        return {
          result,
          confirmActivation: async () => {
            if (options.failConfirmActivation === true) {
              throw new Error('the guardian did not recognise this activation pair');
            }
          },
          abortAndRelease: async () => {
            await result.catch(() => undefined);
            if (releasedStage) return;
            releasedStage = true;
            released.push(key);
            if (guardianRegistered) releasedMemberships.push(key);
          },
        };
      },
    },
  });
  proxyRef.current = proxy;
  await proxy.listen();
  cleanups.push(() => proxy.close());

  elapsed += BigInt(options.openingDelayMs ?? 0);
  const control = await connectControlClient(endpoint, timer, 5_000, options.onProviderEvent);
  cleanups.push(() => control.close());
  const opened = (await strictTestExchange(
    control,
    'control.open.v1',
    { bootstrapNonce: NONCE, coordinator },
    5_000,
  )) as {
    controlEpoch: number;
    heartbeatChallenge: string;
  };
  let heartbeatChallenge = opened.heartbeatChallenge;
  if (options.skipInitialHeartbeat !== true) {
    const observation = await heartbeatOnce(
      control,
      'control.heartbeat.v1',
      opened.controlEpoch,
      opened.heartbeatChallenge,
    );
    if (observation.kind !== 'reply' || observation.reply.kind !== 'accepted') {
      throw new Error(`opening heartbeat was not accepted: ${observation.kind}`);
    }
    heartbeatChallenge = observation.reply.nextChallenge;
  }

  const advanceWithHeartbeat = async (ms: number): Promise<void> => {
    let remainingMs = ms;
    while (remainingMs > 0) {
      const stepMs = Math.min(remainingMs, PROXY_CONTROL_HEARTBEAT_MS);
      elapsed += BigInt(stepMs);
      remainingMs -= stepMs;
      if (stepMs === PROXY_CONTROL_HEARTBEAT_MS) {
        const observation = await heartbeatOnce(
          control,
          'control.heartbeat.v1',
          opened.controlEpoch,
          heartbeatChallenge,
        );
        if (observation.kind !== 'reply' || observation.reply.kind !== 'accepted') {
          throw new Error(`periodic heartbeat was not accepted: ${observation.kind}`);
        }
        heartbeatChallenge = observation.reply.nextChallenge;
      }
    }
  };

  const advanceSilently = (ms: number): void => {
    elapsed += BigInt(ms);
  };

  const operationFor = () => ({
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: shared.proxyInstanceId,
    buildSetId: shared.buildSetId,
  });

  return {
    proxy,
    control,
    endpoint,
    shared,
    coordinator,
    identity,
    opened,
    operationFor,
    started,
    stopped,
    released,
    releasedMemberships,
    startAttempts: () => startAttempts,
    stageAttempts: () => (semantic === null ? stageAttempts : providerCreationAttempts),
    providerCreationJobs,
    firstProviderCreationEntered,
    releaseFirstProviderCreation,
    semantic,
    advanceWithHeartbeat,
    advanceSilently,
  };
}

type ProxyUnderTest = Awaited<ReturnType<typeof startProxy>>;

/**
 * One valid prepared-operation envelope. Every field is required and strictly typed, so a shape that merely
 * "looks like" an operation no longer reaches the ledger — which is the point: a reservation committed
 * against a malformed envelope is one nothing could ever activate.
 */
const PREPARED: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'do the thing',
    cwd: fixtureCanonicalWorkDir('/project'),
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
};

async function launchThroughRoute(
  set: ProxyUnderTest,
  options: {
    dropPrepareReplies?: number;
    ambiguatePrepareRejections?: boolean;
    dropPrepareInspectReplies?: number;
    preparingInspectReplies?: number;
    dropGuardianActivationReplies?: number;
    dropActivationReplies?: number;
    leavePlacementPending?: boolean;
    blockCancel?: boolean;
  } = {},
) {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  cleanups.push(() => db.close());

  let prepareCalls = 0;
  let prepareInspectCalls = 0;
  let guardianActivationCalls = 0;
  let activationCalls = 0;
  let cancelCalls = 0;
  let allowCancel!: () => void;
  const cancelGate =
    options.blockCancel === true
      ? new Promise<void>((resolve) => {
          allowCancel = resolve;
        })
      : null;
  const proxyClient = {
    exchange: async (method: string, params: unknown, timeoutMs: number): Promise<ControlExchange> => {
      if (method === 'operation.prepare.v1') prepareCalls += 1;
      if (method === 'operation.inspect.v1') {
        prepareInspectCalls += 1;
        if (prepareInspectCalls <= (options.dropPrepareInspectReplies ?? 0)) {
          return noResponse(
            new ControlClientError('control_call_failed', 'The prepare inspect reply was dropped.', 'closed'),
          );
        }
        if (prepareInspectCalls <= (options.dropPrepareInspectReplies ?? 0) + (options.preparingInspectReplies ?? 0)) {
          const inspected = (await strictTestExchange(set.control, method, params, timeoutMs)) as {
            reservation?: string;
          };
          if (inspected.reservation === undefined) return resultExchange(inspected);
          return resultExchange({
            state: 'preparing',
            reservation: inspected.reservation,
            leaseExpiresInMs: 15_000,
          });
        }
      }
      if (method === 'operation.activate.v1') activationCalls += 1;
      if (method === 'operation.cancel.v1') {
        cancelCalls += 1;
        await cancelGate;
      }
      let result: unknown;
      try {
        result = await strictTestExchange(set.control, method, params, timeoutMs);
      } catch (error: unknown) {
        if (method === 'operation.prepare.v1' && options.ambiguatePrepareRejections === true) {
          return noResponse(
            new ControlClientError(
              'control_call_failed',
              'The rejected prepare reply was transport-ambiguous.',
              'closed',
            ),
          );
        }
        if (error instanceof ControlClientError) return refusedExchange(error);
        throw error;
      }
      if (method === 'operation.prepare.v1' && prepareCalls <= (options.dropPrepareReplies ?? 0)) {
        return noResponse(new ControlClientError('control_call_failed', 'The prepare reply was dropped.', 'closed'));
      }
      if (method === 'operation.activate.v1' && activationCalls <= (options.dropActivationReplies ?? 0)) {
        return noResponse(new ControlClientError('control_call_failed', 'The activation reply was dropped.', 'closed'));
      }
      return resultExchange(result);
    },
  };
  const guardianCalls: Array<{ method: string; params: unknown }> = [];
  const guardianClient = {
    exchange: async (method: string, params: unknown): Promise<ControlExchange> => {
      guardianCalls.push({ method, params });
      if (method === 'guardian.operation-activate.v1') {
        guardianActivationCalls += 1;
        if (guardianActivationCalls <= (options.dropGuardianActivationReplies ?? 0)) {
          return noResponse(
            new ControlClientError('control_call_failed', 'The guardian activation reply was dropped.', 'closed'),
          );
        }
        return resultExchange({ state: 'activation-authorized', jointActivationReceipt: 'joint-activation-1' });
      }
      return resultExchange({ state: 'membership-released' });
    },
  };
  const setIdentity = {
    buildSetId: set.shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    guardianInstanceId: set.shared.guardianInstanceId,
    guardianPid: 5_000,
    guardianIncarnation: testIncarnation(700),
    guardianControlEndpoint: '/tmp/guardian.sock',
    proxyInstanceId: set.shared.proxyInstanceId,
    proxyPid: set.identity.pid,
    reaperInstanceId: set.shared.reaperInstanceId,
    reaperPid: 5_500,
    reaperIncarnation: testIncarnation(750),
    reaperControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'detached-group',
    proxyIncarnation: set.identity.incarnation,
    proxyProcessGroupId: set.identity.processGroupId,
    canonicalEndpoint: set.endpoint,
  } as const;
  const base = {
    proxyInstanceId: set.shared.proxyInstanceId,
    autonomousDeadline: {
      orphanTimeoutMs: 37_000,
      adoptionWindowMs: 23_000,
      heartbeatHoldBound: { spanMs: 23_000, materialSchedulerLatenessMs: 5_750 },
    },
    controlReattachment: {} as never,
    registerSuccessionOperation: async () => ({ kind: 'registered' as const }),
    stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
    stopHeartbeats: () => undefined,
    initiateControlClose: async () => undefined,
  } as const;
  const authorityForClient = (client: Pick<ControlClient, 'exchange'>) => {
    const proxy = {
      exchange: client.exchange.bind(client),
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => undefined,
    };
    const guardian = {
      ...guardianClient,
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => undefined,
    };
    const clients = { proxy, guardian, reaper: guardian };
    const faults = createProviderProxyAuthorityFaultLatch();
    faults.observeControlClient('proxy', clients.proxy);
    faults.observeControlClient('guardian', clients.guardian);
    faults.observeControlClient('reaper', clients.reaper);
    return createProviderProxyOperationAuthority({
      base,
      setIdentity,
      clients,
      faults,
      mutationRpcTimeoutMs: 5_000,
    });
  };
  const authority = authorityForClient(proxyClient);
  let activeAuthority = authority;
  const registry = new LocalOperationRegistry();
  const operationId = randomUUID();
  const jobId = randomUUID();
  const sessionId = randomUUID();
  const runtimeStarted: unknown[] = [];
  const commit: JobProgressStore['commit'] = (callback) => {
    const pending: unknown[] = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      callback({
        append: (input) => {
          pending.push(input);
          return {} as never;
        },
      });
      db.exec('COMMIT');
      runtimeStarted.push(...pending);
      return [];
    } catch (error: unknown) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const time = createRealTimePort();
  const reconciler = new ProviderOperationReconciler({
    getProgressStore: () => ({
      getDb: () => db,
      commit,
      readStatus: () => ({
        jobId,
        owner: { kind: 'provider-session', id: sessionId },
        sessionId,
        provider: PREPARED.provider,
        projectRoot: '/project',
        workDir: PREPARED.request.cwd,
        backendNamespace: 'tests',
        jobKind: 'provider',
        phase: 'running',
        updatedAt: new Date(WALL_CLOCK_EPOCH_MS).toISOString(),
      }),
      readLaunchProjection: () => ({
        jobId,
        owner: { kind: 'provider-session', id: sessionId },
        sessionId,
        provider: PREPARED.provider,
        projectRoot: '/project',
        backendNamespace: 'tests',
        pool: 'default',
        enqueueSequence: 1,
        createdAt: new Date(WALL_CLOCK_EPOCH_MS).toISOString(),
        jobKind: 'provider',
        providerAction: 'exec',
        request: PREPARED.request,
      }),
    }),
    authorityFor: () => activeAuthority,
    startupSetRecovery: { recoverSetAtStartup: async () => ({ kind: 'authority', authority: activeAuthority }) },
    registry,
    materializePrepare: () => ({ state: 'prepared', prepared: PREPARED }),
    recoverLocalJob: async () => undefined,
    completeLocalRecovery: () => undefined,
    terminalization: {
      terminalize: () => {
        throw new Error('integration publication unexpectedly requested coordinator terminalization');
      },
    },
    recoveryDispatcher: createTestProviderProxyRecoveryDispatcher({}),
    backendNamespace: 'tests',
    onFatal: (error) => {
      throw error;
    },
    time,
  });
  reconciler.start();
  cleanups.push(() => reconciler.stop());
  const route = createAppServerProxyRoute({
    hostManager: { routeAppServerOperation: () => authority },
    reconciler,
    now: () => time.now(),
  });
  const localExecution = vi.fn();

  const placementPromise = route.activate(
    {
      jobId,
      operationId,
      jobLaunchEventSeq: 1,
      sessionId,
      sessionVersion: 1,
      hostSpec: {
        provider: 'codex',
        command: 'codex',
        args: ['app-server'],
        cwd: fixtureCanonicalWorkDir('/workspace'),
        leaseMode: 'job-exclusive',
      },
      provider: PREPARED.provider,
      binding: PREPARED.binding,
      request: PREPARED.request,
      persistedContinuity: null,
      baseEnv: PREPARED.baseEnv,
      protectedEnv: PREPARED.protectedEnv,
      platform: PREPARED.platform,
      childAuthorization: {
        principalWire: {
          subject: 'agent',
          binding: { kind: 'project', root: fixtureCanonicalWorkDir('/project') },
          attenuatedCaps: ['liveness', 'jobs:read'],
        },
        namespace: 'tests',
        expiresAtMs: WALL_CLOCK_EPOCH_MS + 60_000,
      },
    },
    new AbortController().signal,
  );
  const placement = options.leavePlacementPending === true ? undefined : await placementPromise;
  if (placement?.kind === 'local-authorized') localExecution();

  return {
    get prepareCalls() {
      return prepareCalls;
    },
    get prepareInspectCalls() {
      return prepareInspectCalls;
    },
    get guardianActivationCalls() {
      return guardianActivationCalls;
    },
    get activationCalls() {
      return activationCalls;
    },
    get cancelCalls() {
      return cancelCalls;
    },
    guardianCalls,
    jobId,
    operationId,
    localExecution,
    placement,
    placementPromise,
    registry,
    db,
    reconciler,
    authority,
    replaceAuthority: (client: Pick<ControlClient, 'exchange'>) => {
      activeAuthority = authorityForClient(client);
      return activeAuthority;
    },
    allowCancel: () => allowCancel?.(),
    runtimeStarted,
  };
}

function activationDepsFor(set: ProxyUnderTest): ProviderProxyOperationActivationDeps {
  return {
    proxyClient: set.control,
    guardianClient: set.control,
    faultAuthority: () => undefined,
    reportIncident: () => undefined,
    setIdentity: {
      buildSetId: set.shared.buildSetId,
      hostFingerprint: FINGERPRINT,
      guardianInstanceId: set.shared.guardianInstanceId,
      guardianPid: 5_000,
      guardianIncarnation: testIncarnation(700),
      guardianControlEndpoint: '/tmp/guardian.sock',
      proxyInstanceId: set.shared.proxyInstanceId,
      proxyPid: set.identity.pid,
      reaperInstanceId: set.shared.reaperInstanceId,
      reaperPid: 5_500,
      reaperIncarnation: testIncarnation(750),
      reaperControlEndpoint: '/tmp/reaper.sock',
      containmentKind: 'detached-group',
      proxyIncarnation: set.identity.incarnation,
      proxyProcessGroupId: set.identity.processGroupId,
      canonicalEndpoint: set.endpoint,
    },
    mutationRpcTimeoutMs: 5_000,
  };
}

async function prepare(
  set: ProxyUnderTest,
  operation = set.operationFor(),
): Promise<{ operation: ReturnType<ProxyUnderTest['operationFor']>; reserved: Record<string, string> }> {
  const reserved = (await strictTestExchange(
    set.control,
    'operation.prepare.v1',
    { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
    5_000,
  )) as Record<string, string>;
  return { operation, reserved };
}

async function activate(set: ProxyUnderTest, operation: unknown, reserved: Record<string, string>): Promise<unknown> {
  const result = await strictTestExchange(
    set.control,
    'operation.activate.v1',
    {
      operation,
      reservation: reserved.reservation,
      jointContainmentReceipt: reserved.jointContainmentReceipt,
      jointActivationReceipt: 'joint-activation-1',
    },
    5_000,
  );
  await strictTestExchange(set.control, 'operation.attach.v1', { operation, committedThroughProviderSeq: 0 }, 5_000);
  return result;
}

async function installGrantForOperations(
  set: ProxyUnderTest,
  operations: readonly ReturnType<ProxyUnderTest['operationFor']>[],
): Promise<Record<string, unknown>> {
  const grantId = randomUUID();
  const set_ = {
    grantId,
    generation: set.shared.generation,
    hostFingerprint: FINGERPRINT,
    buildSetId: set.shared.buildSetId,
    proxyInstanceId: set.shared.proxyInstanceId,
  };
  await strictTestExchange(
    set.control,
    'handoff.install.v1',
    {
      ...set_,
      operations,
      secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
      orphanTimeoutMs: 30_000,
    },
    5_000,
  );
  // A redeemer never names the timeout or the operation set: both are bound where the grant is installed, so
  // the redeem request is the set tuple plus the credential and nothing else.
  return { ...set_, secret: GRANT_SECRET, successor: set.coordinator };
}

describe('provider-proxy operation lifecycle', () => {
  it('rejects a real prepare that crosses the semantic shutdown gate without staging or spawning a root', async () => {
    const set = await startProxy({ blockFirstProviderCreation: true });
    if (set.semantic === null) throw new Error('expected the semantic runtime');
    const first = set.operationFor();
    const firstPrepare = strictTestExchange(
      set.control,
      'operation.prepare.v1',
      { operation: first, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
      5_000,
    );
    await set.firstProviderCreationEntered;

    const shutdown = set.semantic.shutdown('signal_abort');
    const postGate = set.operationFor();
    let postGateResult: unknown;
    let postGateError: unknown;
    try {
      postGateResult = await strictTestExchange(
        set.control,
        'operation.prepare.v1',
        { operation: postGate, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
        5_000,
      );
    } catch (error: unknown) {
      postGateError = error;
    } finally {
      set.releaseFirstProviderCreation();
    }
    await Promise.allSettled([firstPrepare, shutdown]);

    expect(postGateResult, 'post-gate prepare was accepted after the shutdown snapshot').toBeUndefined();
    expect(postGateError).toMatchObject({
      message: expect.stringContaining('semantic_operation_admission_closed'),
    });
    expect(set.providerCreationJobs).toEqual([first.jobId]);
    await expect(shutdown).resolves.toBeUndefined();
    await expect(
      set.semantic.host.stop({
        key: { jobId: postGate.jobId, operationId: postGate.operationId },
        cause: 'signal_abort',
      }),
    ).rejects.toThrow(/No staged provider root/u);
  });

  it('reserves, stages the root with both authorities, and starts the kernel exactly once', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);

    expect(reserved.state).toBe('pending-activation');
    expect(reserved.jointContainmentReceipt).toBe('joint-1');
    expect(reserved.providerRoot).toEqual({ pid: 7_001, incarnation: testIncarnation(800) });
    // Staging precedes the reservation being reported, so a reservation the coordinator goes on to commit
    // always names a root the containment can already reach.
    expect(set.started).toEqual([]);

    expect(await activate(set, operation, reserved)).toMatchObject({
      state: 'executing',
      startedAt: new Date(WALL_CLOCK_EPOCH_MS).toISOString(),
      hostRef: hostRefFor(operation.jobId),
      committedThroughProviderSeq: 0,
    });
    // The host must receive the envelope prepare validated, not activate's own request params.
    expect(set.started).toEqual([{ jobId: operation.jobId, operationId: operation.operationId, prepared: PREPARED }]);
  });

  it('treats a repeated activation as the same request, not a second kernel', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);

    expect(await activate(set, operation, reserved)).toMatchObject({
      state: 'executing',
      hostRef: hostRefFor(operation.jobId),
      committedThroughProviderSeq: 0,
    });

    // Starting a second kernel would fork the carrier this proxy exists to own.
    expect(set.started).toHaveLength(1);
  });

  it('keeps proxy placement when the activation reply is lost after the proxy starts', async () => {
    const set = await startProxy();
    const launched = await launchThroughRoute(set, { dropActivationReplies: 1 });

    expect(launched.placement).toEqual({ kind: 'remote-executing' });
    expect(launched.localExecution).not.toHaveBeenCalled();
    expect(launched.activationCalls).toBe(2);
    expect(set.started).toEqual([{ jobId: launched.jobId, operationId: launched.operationId, prepared: PREPARED }]);
    expect(launched.registry.stateForJob(launched.jobId)).toBe('activated');
  });

  it('reconnects settlement after the activation-time control closed and releases ledger plus membership', async () => {
    const set = await startProxy();
    const launched = await launchThroughRoute(set);
    const operation = {
      jobId: launched.jobId,
      operationId: launched.operationId,
      proxyInstanceId: set.shared.proxyInstanceId,
      buildSetId: set.shared.buildSetId,
    };
    const grant = await installGrantForOperations(set, [operation]);
    await strictTestExchange(set.control, 'operation.stop.v1', { operation, cause: 'signal_abort' }, 5_000);
    await vi.waitFor(() => expect(set.proxy.ledger().get(operation)?.state).toBe('terminal-awaiting-settlement'));

    set.control.close();
    set.advanceSilently(5_001);
    const executing = readProviderOperation(launched.db, operation);
    if (executing?.phase !== 'executing') throw new Error('expected executing journal row');
    const { controlIntent: _controlIntent, ...settlementRecord } = executing;
    const settlement = providerOperationRecordSchema.parse({
      ...settlementRecord,
      phase: 'settlement-pending',
      committedThroughProviderSeq: 0,
      terminalProviderSeq: 0,
      settlementIntent: 'release-after-terminal',
      revision: executing.revision + 1,
      retryNotBeforeMs: Date.now(),
    });
    expect(compareAndSwapProviderOperation(launched.db, executing, settlement).kind).toBe('updated');

    launched.reconciler.settlementPending(operation);
    await vi.waitFor(() => expect(readProviderOperation(launched.db, operation)?.retryCount).toBeGreaterThan(0));
    expect(readProviderOperation(launched.db, operation)?.phase).toBe('settlement-pending');
    expect(set.proxy.ledger().get(operation)).not.toBeNull();
    expect(set.releasedMemberships).toEqual([]);

    const successor = await connectControlClient(set.endpoint, timer, 5_000);
    cleanups.push(() => successor.close());
    const redeemed = (await strictTestExchange(successor, 'handoff.redeem.v1', grant, 5_000)) as {
      controlEpoch: number;
      heartbeatChallenge: string;
    };
    expect(proxyHandoffRedeemResultSchema.parse(redeemed).proxy).toEqual(set.identity);
    await strictTestExchange(
      successor,
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    );
    const successorAuthority = launched.replaceAuthority(successor);
    launched.reconciler.onControlEstablished(successorAuthority);

    await vi.waitFor(() => expect(readProviderOperation(launched.db, operation)).toBeNull());
    expect(set.proxy.ledger().get(operation)).toBeNull();
    expect(set.releasedMemberships).toEqual([{ jobId: operation.jobId, operationId: operation.operationId }]);
  });

  it('keeps proxy placement when both activation attempts lose their replies', async () => {
    const set = await startProxy();
    const launched = await launchThroughRoute(set, { dropActivationReplies: 2 });

    expect(launched.placement).toEqual({ kind: 'remote-executing' });
    expect(launched.localExecution).not.toHaveBeenCalled();
    expect(launched.activationCalls).toBe(3);
    expect(set.started).toEqual([{ jobId: launched.jobId, operationId: launched.operationId, prepared: PREPARED }]);
    expect(launched.registry.stateForJob(launched.jobId)).toBe('activated');
  });

  it('continues activation after both prepare replies are lost and starts one kernel', async () => {
    const set = await startProxy();
    const launched = await launchThroughRoute(set, { dropPrepareReplies: 2, preparingInspectReplies: 1 });
    const key = { jobId: launched.jobId, operationId: launched.operationId };

    expect(launched.placement).toEqual({ kind: 'remote-executing' });
    expect(launched.localExecution).not.toHaveBeenCalled();
    expect(launched.prepareCalls).toBe(2);
    expect(launched.prepareInspectCalls).toBe(2);
    expect(launched.activationCalls).toBe(1);
    expect(set.startAttempts()).toBe(1);
    expect(set.started).toEqual([{ jobId: launched.jobId, operationId: launched.operationId, prepared: PREPARED }]);
    const owned = set.proxy.ledger().get(key);
    expect(owned?.state).toBe('executing');
    expect(launched.registry.stateForJob(launched.jobId)).toBe('activated');
  });

  it('replays two lost guardian activation replies before publishing exactly one kernel start', async () => {
    const set = await startProxy();
    const launched = await launchThroughRoute(set, {
      dropGuardianActivationReplies: 2,
    });
    const key = { jobId: launched.jobId, operationId: launched.operationId };

    expect(launched.placement).toEqual({ kind: 'remote-executing' });
    expect(launched.localExecution).not.toHaveBeenCalled();
    expect(launched.prepareInspectCalls).toBe(0);
    expect(launched.guardianActivationCalls).toBe(3);
    expect(launched.activationCalls).toBe(1);
    expect(set.startAttempts()).toBe(1);
    expect(set.proxy.ledger().get(key)?.state).toBe('executing');
    expect(set.started).toEqual([{ jobId: launched.jobId, operationId: launched.operationId, prepared: PREPARED }]);
    expect(launched.runtimeStarted).toEqual([expect.objectContaining({ type: 'job.runtime.started' })]);
    expect(launched.registry.stateForJob(launched.jobId)).toBe('activated');
  });

  it('does not let a guardian activation timeout authorise local placement', async () => {
    const set = await startProxy();
    const launched = await launchThroughRoute(set, { dropGuardianActivationReplies: 1 });

    expect(launched.placement).toEqual({ kind: 'remote-executing' });
    expect(launched.localExecution).not.toHaveBeenCalled();
    expect(launched.guardianActivationCalls).toBe(2);
    expect(launched.activationCalls).toBe(1);
    expect(set.started).toEqual([{ jobId: launched.jobId, operationId: launched.operationId, prepared: PREPARED }]);
  });

  it('keeps placement unresolved when the semantic kernel may have begun activation', async () => {
    const set = await startProxy({ failStart: true });
    const launched = await launchThroughRoute(set, { leavePlacementPending: true });
    const key = { jobId: launched.jobId, operationId: launched.operationId };
    let placementSettled = false;
    void launched.placementPromise.then(() => {
      placementSettled = true;
    });

    await vi.waitFor(() => expect(set.startAttempts()).toBe(1));
    await vi.waitFor(() => expect(set.released).toContainEqual(key));

    expect(placementSettled).toBe(false);
    expect(launched.localExecution).not.toHaveBeenCalled();
    expect(launched.activationCalls).toBe(1);
    expect(set.started).toEqual([]);
    expect(set.proxy.ledger().get(key)).toBeNull();
    expect(set.released).toContainEqual(key);
  });

  it('refuses activation that presents a containment receipt nobody staged, and starts no kernel', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);

    await expect(activate(set, operation, { ...reserved, jointContainmentReceipt: 'forged-receipt' })).rejects.toThrow(
      /different containment receipt/u,
    );
    expect(set.started).toEqual([]);
  });

  it('refuses activation the guardian does not confirm, and starts no kernel', async () => {
    const set = await startProxy({ failConfirmActivation: true });
    const { operation, reserved } = await prepare(set);

    await expect(activate(set, operation, reserved)).resolves.toMatchObject({
      state: 'released-never-started',
      operation,
      prepareAttemptNumber: 1,
    });
    expect(set.started).toEqual([]);
  });

  it('refuses a prepare naming a different host fingerprint', async () => {
    const set = await startProxy();

    await expect(
      strictTestExchange(
        set.control,
        'operation.prepare.v1',
        {
          operation: set.operationFor(),
          hostFingerprint: 'c'.repeat(64),
          prepareAttemptNumber: 1,
          prepared: PREPARED,
        },
        5_000,
      ),
    ).rejects.toThrow(/different host fingerprint/u);
  });

  it('returns one canonical refusal through prepare, inspect, and an exact same-attempt retry', async () => {
    const refusal = {
      state: 'permanent-refusal',
      code: 'provider_creation_refused',
      disposition: 'local-fallback',
      reason: 'The provider root could not be created.',
    } as const;
    const set = await startProxy({ prepareRefusal: refusal });
    const operation = set.operationFor();
    const deps = activationDepsFor(set);
    const attempt = providerOperationPrepareAttempt(deps, operation, PREPARED);

    const direct = await prepareProviderOperation(deps, attempt);
    const inspected = await inspectProviderOperation(deps, operation, attempt.prepareAttemptKey);
    const retry = await prepareProviderOperation(deps, attempt);

    const key = { jobId: operation.jobId, operationId: operation.operationId };
    expect(JSON.stringify(direct)).toBe(JSON.stringify(refusal));
    expect(JSON.stringify(inspected)).toBe(JSON.stringify(refusal));
    expect(JSON.stringify(retry)).toBe(JSON.stringify(refusal));
    expect(set.stageAttempts()).toBe(1);
    expect(set.proxy.ledger().get(key)).toBeNull();
    expect(set.released).toEqual([key]);
    expect(set.releasedMemberships).toEqual([]);
  });

  it('persists a deterministic provider-creation refusal before cancellation and never rotates the attempt', async () => {
    const set = await startProxy({ failProviderCreation: true });
    const launched = await launchThroughRoute(set, {
      ambiguatePrepareRejections: true,
      blockCancel: true,
      leavePlacementPending: true,
    });

    await vi.waitFor(() => {
      const record = readProviderOperation(launched.db, {
        jobId: launched.jobId,
        operationId: launched.operationId,
        proxyInstanceId: set.shared.proxyInstanceId,
        buildSetId: set.shared.buildSetId,
      });
      expect(record).toMatchObject({
        prepareAttemptNumber: 1,
        phase: 'prestart-cleanup-pending',
      });
    });
    expect(launched.prepareCalls).toBe(1);
    expect(launched.cancelCalls).toBe(1);
    expect(set.stageAttempts()).toBe(1);

    launched.allowCancel();
    await expect(launched.placementPromise).resolves.toMatchObject({ kind: 'local-authorized' });
    await vi.waitFor(() =>
      expect(
        readProviderOperation(launched.db, {
          jobId: launched.jobId,
          operationId: launched.operationId,
          proxyInstanceId: set.shared.proxyInstanceId,
          buildSetId: set.shared.buildSetId,
        }),
      ).toBeNull(),
    );
  });

  it('returns the original prepare result when its successful reply is retried', async () => {
    const set = await startProxy();
    const operation = set.operationFor();
    const request = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };

    const first = await strictTestExchange(set.control, 'operation.prepare.v1', request, 5_000);
    const retry = await strictTestExchange(set.control, 'operation.prepare.v1', request, 5_000);

    expect(retry).toEqual(first);
    expect(set.stageAttempts()).toBe(1);
  });

  it('answers capacity exhaustion as a typed retryable state rather than an error', async () => {
    const set = await startProxy();
    for (let index = 0; index < MAX_PROXY_OPERATION_LEDGERS; index += 1) {
      await prepare(set);
    }

    const { reserved } = await prepare(set);

    // Admission stays with the coordinator: the proxy reports it cannot take the work instead of queueing
    // it, and writes nothing it would then have to unwind.
    expect(reserved).toEqual({
      state: 'capacity',
      retryable: true,
      code: 'operation_ledger_capacity',
      reason: 'operation-ledgers',
    });
  });

  it('renews a pending-activation reservation, extending its lease from the call’s own now', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await set.advanceWithHeartbeat(1_000);

    const renewed = (await strictTestExchange(
      set.control,
      'operation.renew-activation.v1',
      { operation, reservation: reserved.reservation },
      5_000,
    )) as { state: string; leaseExpiresInMs: number };

    expect(renewed.state).toBe('pending-activation');
    // Renewed from *this* call's own now, not the original prepare's, so the fresh budget is the same full
    // lease again rather than the original lease minus the second that already elapsed.
    expect(renewed.leaseExpiresInMs).toBe(reserved.leaseExpiresInMs);

    // The renewed lease actually took effect: activating well past the original (unrenewed) deadline still
    // succeeds rather than being refused as expired.
    await set.advanceWithHeartbeat(14_500);
    expect(await activate(set, operation, reserved)).toMatchObject({ state: 'executing' });
  });

  it('refuses operation.renew-activation.v1 presenting a different reservation for a known operation', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);

    await expect(
      strictTestExchange(
        set.control,
        'operation.renew-activation.v1',
        { operation, reservation: asReservation(randomUUID()) },
        5_000,
      ),
    ).rejects.toThrow(/different reservation/u);

    // The same call with the reservation this operation actually holds still renews, so the refusal above is
    // about the value and not about the method. Renew once compared only half of a two-field reservation
    // while its schema demanded both, so a wrong second half renewed successfully; with one value there is
    // no half to get wrong.
    expect(
      await strictTestExchange(
        set.control,
        'operation.renew-activation.v1',
        { operation, reservation: reserved.reservation },
        5_000,
      ),
    ).toMatchObject({ state: 'pending-activation' });
  });

  it.each([
    ['restart', 'suspended-awaiting-durable-decision'],
    ['handoff', 'suspended-awaiting-durable-decision'],
    ['user_abort', 'terminal-awaiting-journal-ack'],
    ['signal_abort', 'terminal-awaiting-journal-ack'],
    ['queue_shutdown', 'terminal-awaiting-journal-ack'],
  ])('stops on %s into %s, awaiting the coordinator’s durable decision', async (cause, expected) => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);

    const stopped = (await strictTestExchange(set.control, 'operation.stop.v1', { operation, cause }, 5_000)) as {
      state: string;
    };

    // Only a recorded restart or handoff suspends. Claiming the abort causes interrupted the operation
    // would write an interruption the user never suffered.
    expect(stopped.state).toBe(expected);
    expect(set.stopped).toEqual([{ jobId: operation.jobId, operationId: operation.operationId, cause }]);
  });

  it('releases a pending-activation entry on stop without calling a kernel that never started', async () => {
    const set = await startProxy();
    const { operation } = await prepare(set);

    const stopped = (await strictTestExchange(
      set.control,
      'operation.stop.v1',
      { operation, cause: 'user_abort' },
      5_000,
    )) as {
      state: string;
    };

    // `SemanticOperationHost.stop`'s contract is "stops a running kernel" — this one was never started.
    expect(stopped.state).toBe('released');
    expect(set.stopped).toEqual([]);
  });

  it('attaches only operations inside the redeemed set', async () => {
    const set = await startProxy();
    const inside = await prepare(set);
    const outside = await prepare(set);
    await activate(set, inside.operation, inside.reserved);
    await activate(set, outside.operation, outside.reserved);
    const redeem = await installGrantForOperations(set, [inside.operation]);
    set.control.close();
    set.advanceSilently(5_001);

    const successor = await connectControlClient(set.endpoint, timer, 5_000);
    cleanups.push(() => successor.close());
    const redeemed = (await strictTestExchange(successor, 'handoff.redeem.v1', redeem, 5_000)) as {
      state: string;
      operations: Record<string, string>[];
      controlEpoch: number;
      heartbeatChallenge: string;
    };
    expect(redeemed.state).toBe('redeemed-provisional');
    await strictTestExchange(
      successor,
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    );

    expect(
      await strictTestExchange(
        successor,
        'operation.attach.v1',
        { operation: inside.operation, committedThroughProviderSeq: 0 },
        5_000,
      ),
    ).toEqual({ state: 'attached', replayFromProviderSeq: 1 });
    // An otherwise valid, executing operation outside the redeemed set is one this successor never earned,
    // however good its control tenancy is.
    await expect(
      strictTestExchange(
        successor,
        'operation.attach.v1',
        { operation: outside.operation, committedThroughProviderSeq: 0 },
        5_000,
      ),
    ).rejects.toThrow(/outside the redeemed set/u);
  });

  it('refuses a grant installed against another proxy instance', async () => {
    const set = await startProxy();

    await expect(
      strictTestExchange(
        set.control,
        'handoff.install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          generation: set.shared.generation,
          hostFingerprint: FINGERPRINT,
          buildSetId: set.shared.buildSetId,
          proxyInstanceId: randomUUID(),
          operations: [],
          orphanTimeoutMs: 30_000,
        },
        5_000,
      ),
    ).rejects.toThrow(/not this proxy/u);
  });

  it('refuses an unsorted or duplicated operation set at handoff.install.v1 ingress', async () => {
    const set = await startProxy();
    const opA = set.operationFor();
    const opB = set.operationFor();
    const [first, second] = opA.operationId < opB.operationId ? [opB, opA] : [opA, opB];
    const install = (operations: ReturnType<typeof set.operationFor>[]): Promise<unknown> =>
      strictTestExchange(
        set.control,
        'handoff.install.v1',
        {
          grantId: randomUUID(),
          secretSha256: createHash('sha256').update(GRANT_SECRET, 'utf8').digest('hex'),
          generation: set.shared.generation,
          hostFingerprint: FINGERPRINT,
          buildSetId: set.shared.buildSetId,
          proxyInstanceId: set.shared.proxyInstanceId,
          operations,
          orphanTimeoutMs: 30_000,
        },
        5_000,
      );

    // The wire schema this method parses carries the byte-sort refinement, so an unsorted or duplicated set
    // is refused right here, at ingress.
    await expect(install([first, second])).rejects.toMatchObject({
      remoteFailure: { protocolCode: 'protocol_violation' },
    });
    // Duplicated is refused for the same reason, not merely unsorted.
    await expect(install([first, first])).rejects.toMatchObject({
      remoteFailure: { protocolCode: 'protocol_violation' },
    });
  });

  it('accepts the standalone proxy first challenge after ordinary construction-anchored control loss', async () => {
    const set = await startProxy({ openingDelayMs: 1_000, skipInitialHeartbeat: true });
    set.advanceSilently(PROXY_CONTROL_LEASE_MS - 500);

    await expect(
      strictTestExchange(
        set.control,
        'control.heartbeat.v1',
        {
          controlEpoch: set.opened.controlEpoch,
          heartbeatChallenge: set.opened.heartbeatChallenge,
        },
        5_000,
      ),
    ).resolves.toMatchObject({ state: 'active' });
  });

  it("keeps a redeemed successor's matching challenge answerable after the lease", async () => {
    const set = await startProxy();
    // A grant that names no operations is enough: only the tenancy this redemption opens is under test.
    const redeem = await installGrantForOperations(set, []);
    set.control.close();
    set.advanceSilently(5_001);

    const successor = await connectControlClient(set.endpoint, timer, 5_000);
    cleanups.push(() => successor.close());
    const redeemed = (await strictTestExchange(successor, 'handoff.redeem.v1', redeem, 5_000)) as {
      controlEpoch: number;
      heartbeatChallenge: string;
    };

    set.advanceSilently(PROXY_CONTROL_LEASE_MS + 1);
    const stillLive = (await strictTestExchange(
      successor,
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    )) as { state: string };
    expect(stillLive.state).toBe('active');
  });
});

describe('provider-proxy provider.event.v1 emission', () => {
  it('pushes an emitted event to active control and advances the ledger watermark on ack', async () => {
    const received: unknown[] = [];
    const set = await startProxy({
      onProviderEvent: (request) => {
        received.push(request);
        return { kind: 'ack', committedThroughProviderSeq: request.providerSeq };
      },
    });
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);
    const key = { jobId: operation.jobId, operationId: operation.operationId };

    set.proxy.emitProviderEvent(key, { kind: 'progress', message: 'tick' });

    await vi.waitFor(() => expect(set.proxy.ledger().get(key)?.committedThroughProviderSeq).toBe(1));
    expect(received).toEqual([
      {
        operation: {
          jobId: operation.jobId,
          operationId: operation.operationId,
          proxyInstanceId: set.shared.proxyInstanceId,
          buildSetId: set.shared.buildSetId,
        },
        providerSeq: 1,
        event: { kind: 'progress', message: 'tick' },
      },
    ]);
    // Acknowledged through: nothing is left buffered for a replay nobody will ask for.
    expect(set.proxy.ledger().get(key)?.bufferedEvents).toEqual([]);
  });

  it('resends the identical retained event when a fresh attach requests replay', async () => {
    const receivedSeqs: number[] = [];
    const set = await startProxy({
      onProviderEvent: (request) => {
        receivedSeqs.push(request.providerSeq);
        if (receivedSeqs.length === 1) {
          return { kind: 'replay', replayFromProviderSeq: request.providerSeq, reason: 'not yet durable' };
        }
        return { kind: 'ack', committedThroughProviderSeq: request.providerSeq };
      },
    });
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);
    const key = { jobId: operation.jobId, operationId: operation.operationId };

    set.proxy.emitProviderEvent(key, { kind: 'progress', message: 'tick' });

    await vi.waitFor(() => expect(receivedSeqs).toEqual([1]));
    await strictTestExchange(set.control, 'operation.attach.v1', { operation, committedThroughProviderSeq: 0 }, 5_000);
    await vi.waitFor(() => expect(set.proxy.ledger().get(key)?.committedThroughProviderSeq).toBe(1));
    // The same event, sent twice — a `replay` reply does not advance providerSeq allocation.
    expect(receivedSeqs).toEqual([1, 1]);
  });

  it('records a proxy-origin terminal synchronously once the per-operation event ceiling is reached', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);
    const key = { jobId: operation.jobId, operationId: operation.operationId };

    for (let index = 0; index < MAX_PROVIDER_REPLAY_EVENTS; index += 1) {
      set.proxy.emitProviderEvent(key, { kind: 'progress', message: `tick-${index}` });
    }

    expect(set.proxy.emitProviderEvent(key, { kind: 'progress', message: 'refused' })).toEqual({
      kind: 'proxy-emergency-terminal',
    });
    const entry = set.proxy.ledger().get(key);
    expect(entry?.state).toBe('terminal-awaiting-settlement');
    expect(entry?.bufferedEvents).toHaveLength(MAX_PROVIDER_REPLAY_EVENTS + 1);
    const emergency = entry?.bufferedEvents.at(-1);
    if (emergency === undefined) throw new Error('Expected a proxy-emergency terminal.');
    const decoded = decodeProxyControlFrame(emergency.frame);
    if (!('params' in decoded)) throw new Error('Expected a provider event request.');
    expect(providerEventRequestSchema.parse(decoded.params)).toMatchObject({
      providerSeq: MAX_PROVIDER_REPLAY_EVENTS + 1,
      event: {
        kind: 'terminal',
        failureCause: {
          body: {
            provider: '@coral/provider-proxy',
            message: 'Replay event count reached 4,096 for this operation.',
          },
        },
      },
    });
  });

  it('preflights an oversized event into a proxy-origin terminal without buffering the offending frame', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);
    const key = { jobId: operation.jobId, operationId: operation.operationId };

    expect(
      set.proxy.emitProviderEvent(key, { kind: 'progress', message: 'x'.repeat(MAX_PROVIDER_REPLAY_BYTES) }),
    ).toEqual({ kind: 'proxy-emergency-terminal' });
    const [emergency] = set.proxy.ledger().get(key)?.bufferedEvents ?? [];
    if (emergency === undefined) throw new Error('Expected a proxy-emergency terminal.');
    const decoded = decodeProxyControlFrame(emergency.frame);
    if (!('params' in decoded)) throw new Error('Expected a provider event request.');
    expect(providerEventRequestSchema.parse(decoded.params)).toMatchObject({
      providerSeq: 1,
      event: {
        failureCause: {
          body: {
            provider: '@coral/provider-proxy',
            message: 'Replay bytes reached 16,777,216 for this operation.',
          },
        },
      },
    });
  });

  it('keeps an unacknowledged event buffered through control loss and delivers it once a successor attaches', async () => {
    // No handler on this first connection: the proxy's own push is refused, so the event stays buffered
    // exactly as it would if control had gone genuinely unreachable — the recovery path under test does not
    // depend on which failure mode left the event unacknowledged.
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);
    const key = { jobId: operation.jobId, operationId: operation.operationId };

    set.proxy.emitProviderEvent(key, { kind: 'progress', message: 'first' });
    await vi.waitFor(() => expect(set.proxy.ledger().get(key)?.bufferedEvents).toHaveLength(1));

    const redeem = await installGrantForOperations(set, [operation]);
    set.control.close();
    set.advanceSilently(5_001);

    const received: unknown[] = [];
    let resolveSuccessorAck!: (value: { kind: 'ack'; committedThroughProviderSeq: number }) => void;
    const successorAck = new Promise<{ kind: 'ack'; committedThroughProviderSeq: number }>((resolve) => {
      resolveSuccessorAck = resolve;
    });
    const successor = await connectControlClient(set.endpoint, timer, 5_000, (request) => {
      received.push(request);
      return successorAck;
    });
    cleanups.push(() => successor.close());
    const redeemed = (await strictTestExchange(successor, 'handoff.redeem.v1', redeem, 5_000)) as {
      controlEpoch: number;
      heartbeatChallenge: string;
    };
    await strictTestExchange(
      successor,
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    );

    const attached = (await strictTestExchange(
      successor,
      'operation.attach.v1',
      { operation, committedThroughProviderSeq: 0 },
      5_000,
    )) as { replayFromProviderSeq: number };
    expect(attached.replayFromProviderSeq).toBe(1);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    resolveSuccessorAck({ kind: 'ack', committedThroughProviderSeq: 1 });

    // Waiting on the ledger's own watermark, not `received.length`: the handler runs (and pushes into
    // `received`) before its `ack` reply has even been written back, let alone round-tripped through
    // `pushOnTenancy` to `ledger.acknowledge` — asserting on `received` alone would race that continuation.
    await vi.waitFor(() => expect(set.proxy.ledger().get(key)?.committedThroughProviderSeq).toBe(1));
    expect(received).toEqual([
      expect.objectContaining({ providerSeq: 1, event: { kind: 'progress', message: 'first' } }),
    ]);
  });

  it('resumes draining every held operation on a same-successor redeem retry before operation attachment', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);
    const key = { jobId: operation.jobId, operationId: operation.operationId };
    set.proxy.emitProviderEvent(key, { kind: 'progress', message: 'first' });
    await vi.waitFor(() => expect(set.proxy.ledger().get(key)?.bufferedEvents).toHaveLength(1));

    const redeem = await installGrantForOperations(set, [operation]);
    set.control.close();
    set.advanceSilently(5_001);

    const received: number[] = [];
    const successor = await connectControlClient(set.endpoint, timer, 5_000, (request) => {
      received.push(request.providerSeq);
      return { kind: 'ack', committedThroughProviderSeq: request.providerSeq };
    });
    cleanups.push(() => successor.close());
    const redeemed = (await strictTestExchange(successor, 'handoff.redeem.v1', redeem, 5_000)) as {
      controlEpoch: number;
      heartbeatChallenge: string;
    };
    await strictTestExchange(
      successor,
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    );

    // A retry of the identical redeem, on the same connection — the only branch that ever reaches
    // `reattachControl` for this proxy: `control.open.v1`'s own bootstrap nonce is single-use, so the
    // original coordinator's own tenancy can never re-enter it this way.
    await strictTestExchange(successor, 'handoff.redeem.v1', redeem, 5_000);

    await vi.waitFor(() => expect(received).toHaveLength(1));
  });
});
