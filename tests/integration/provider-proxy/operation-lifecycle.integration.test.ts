import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { createRealTimePort } from '#src/infra/time.js';
import type { HostRef } from '#src/providers/contract.js';
import { heartbeatOnce } from '#src/coordinator/live/provider-proxy/heartbeat.js';
import {
  connectControlClient,
  ControlClientError,
  type ProviderEventHandler,
} from '#src/provider-proxy/control-client.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { compareAndSwapProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { ProviderOperationReconciler } from '#src/coordinator/services/provider-operation-reconciler.js';
import { createAppServerProxyRoute } from '#src/coordinator/services/provider-proxy-launch-route.js';
import { LocalOperationRegistry } from '#src/coordinator/services/operation-registry.js';
import { createProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import type { JobProgressStore } from '#src/jobs/contracts/job-store.js';
import {
  MAX_PROXY_OPERATION_LEDGERS,
  MAX_PROVIDER_REPLAY_BYTES,
  MAX_PROVIDER_REPLAY_EVENTS,
  PROXY_PENDING_ACTIVATION_LEASE_MS,
} from '#src/provider-proxy/ledger.js';
import { PROXY_CONTROL_HEARTBEAT_MS, PROXY_CONTROL_LEASE_MS } from '#src/provider-proxy/orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  PROXY_STATUS_RPC_TIMEOUT_MS,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';
import { createProxy, type SemanticOperationHost } from '#src/provider-proxy/proxy.js';
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
});

const timer: ControlEndpointTimer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
};

/** Wraps the real timer, recording every budget `serveRequest` actually schedules — the only way to observe
 *  which `budgetMs` a method was dispatched under without reaching into the endpoint's own closure. */
function recordingTimer(observedBudgetsMs: number[]): ControlEndpointTimer {
  return {
    setTimeout: (callback, ms) => {
      observedBudgetsMs.push(ms);
      return timer.setTimeout(callback, ms);
    },
    clearTimeout: (handle) => timer.clearTimeout(handle),
  };
}

type Started = { jobId: string; operationId: string };

async function startProxy(
  options: {
    failStage?: boolean;
    failStageOnce?: boolean;
    failConfirmActivation?: boolean;
    failStart?: boolean;
    timer?: ControlEndpointTimer;
    onProviderEvent?: ProviderEventHandler;
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
    processStartedAtSeconds: 700,
    generation: shared.generation,
    flavor: shared.flavor,
    buildSetId: shared.buildSetId,
  };
  const identity = {
    proxyInstanceId: shared.proxyInstanceId,
    pid: 6_000,
    processStartedAtSeconds: 850,
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
      if (options.failStart === true) throw new Error('the semantic kernel failed to start');
      started.push({ ...key, prepared });
      return hostRefFor(key.jobId);
    },
    stop: ({ key, cause }) => {
      stopped.push({ ...key, cause });
    },
    releaseStaged: (key) => {
      released.push(key);
    },
  };

  let receipts = 0;
  let stageAttempts = 0;
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
    host,
    timer: options.timer ?? timer,
    mintChallenge: () => randomUUID(),
    mintReceipt: () => {
      receipts += 1;
      return `receipt-${receipts}`;
    },
    mintReservation: () => asReservation(randomUUID()),
    wallClockNow: () => WALL_CLOCK_EPOCH_MS + Number(elapsed),
    containment: {
      stageProviderRoot: () => {
        stageAttempts += 1;
        if (options.failStage === true || (options.failStageOnce === true && stageAttempts === 1)) {
          throw new Error('the guardian refused to stage this root');
        }
        return Promise.resolve({
          providerRoot: { pid: 7_001, processStartedAtSeconds: 800 },
          receipt: asJointContainmentReceipt('joint-1'),
        });
      },
      confirmActivation: () => {
        if (options.failConfirmActivation === true) {
          throw new Error('the guardian did not recognise this activation pair');
        }
        return Promise.resolve();
      },
      releaseMembership: ({ key }) => {
        releasedMemberships.push(key);
        return Promise.resolve();
      },
    },
  });
  await proxy.listen();
  cleanups.push(() => proxy.close());

  const control = await connectControlClient(endpoint, timer, 5_000, options.onProviderEvent);
  cleanups.push(() => control.close());
  const opened = (await control.call('control.open.v1', { bootstrapNonce: NONCE, coordinator }, 5_000)) as {
    controlEpoch: number;
    heartbeatChallenge: string;
  };
  let heartbeatChallenge = (
    await heartbeatOnce(control, 'control.heartbeat.v1', opened.controlEpoch, opened.heartbeatChallenge)
  ).nextHeartbeatChallenge;

  const advanceWithHeartbeat = async (ms: number): Promise<void> => {
    let remainingMs = ms;
    while (remainingMs > 0) {
      const stepMs = Math.min(remainingMs, PROXY_CONTROL_HEARTBEAT_MS);
      elapsed += BigInt(stepMs);
      remainingMs -= stepMs;
      if (stepMs === PROXY_CONTROL_HEARTBEAT_MS) {
        heartbeatChallenge = (
          await heartbeatOnce(control, 'control.heartbeat.v1', opened.controlEpoch, heartbeatChallenge)
        ).nextHeartbeatChallenge;
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
    operationFor,
    started,
    stopped,
    released,
    releasedMemberships,
    startAttempts: () => startAttempts,
    stageAttempts: () => stageAttempts,
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
    cwd: '/project',
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
    dropPrepareInspectReplies?: number;
    preparingInspectReplies?: number;
    dropGuardianActivationReplies?: number;
    dropActivationReplies?: number;
    leavePlacementPending?: boolean;
  } = {},
) {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  cleanups.push(() => db.close());

  let prepareCalls = 0;
  let prepareInspectCalls = 0;
  let guardianActivationCalls = 0;
  let activationCalls = 0;
  const proxyClient = {
    call: async (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
      if (method === 'operation.prepare.v1') prepareCalls += 1;
      if (method === 'operation.inspect.v2') {
        prepareInspectCalls += 1;
        if (prepareInspectCalls <= (options.dropPrepareInspectReplies ?? 0)) {
          throw new ControlClientError('control_call_failed', 'The prepare inspect reply was dropped.');
        }
        if (prepareInspectCalls <= (options.dropPrepareInspectReplies ?? 0) + (options.preparingInspectReplies ?? 0)) {
          const inspected = (await set.control.call(method, params, timeoutMs)) as { reservation?: string };
          if (inspected.reservation === undefined) return inspected;
          return {
            state: 'preparing',
            reservation: inspected.reservation,
            leaseExpiresInMs: 15_000,
          };
        }
      }
      if (method === 'operation.activate.v1') activationCalls += 1;
      const result = await set.control.call(method, params, timeoutMs);
      if (method === 'operation.prepare.v1' && prepareCalls <= (options.dropPrepareReplies ?? 0)) {
        throw new ControlClientError('control_call_failed', 'The prepare reply was dropped.');
      }
      if (method === 'operation.activate.v1' && activationCalls <= (options.dropActivationReplies ?? 0)) {
        throw new ControlClientError('control_call_failed', 'The activation reply was dropped.');
      }
      return result;
    },
  };
  const guardianCalls: Array<{ method: string; params: unknown }> = [];
  const guardianClient = {
    call: async (method: string, params: unknown): Promise<unknown> => {
      guardianCalls.push({ method, params });
      if (method === 'guardian.operation-activate.v1') {
        guardianActivationCalls += 1;
        if (guardianActivationCalls <= (options.dropGuardianActivationReplies ?? 0)) {
          throw new ControlClientError('control_call_failed', 'The guardian activation reply was dropped.');
        }
        return { state: 'activation-authorized', jointActivationReceipt: 'joint-activation-1' };
      }
      return { state: 'membership-released' };
    },
  };
  const setIdentity = {
    buildSetId: set.shared.buildSetId,
    hostFingerprint: FINGERPRINT,
    guardianInstanceId: set.shared.guardianInstanceId,
    guardianPid: 5_000,
    guardianProcessStartedAtSeconds: 700,
    guardianControlEndpoint: '/tmp/guardian.sock',
    proxyInstanceId: set.shared.proxyInstanceId,
    proxyPid: set.identity.pid,
    reaperInstanceId: set.shared.reaperInstanceId,
    reaperPid: 5_500,
    reaperProcessStartedAtSeconds: 750,
    reaperControlEndpoint: '/tmp/reaper.sock',
    containmentKind: 'detached-group',
    proxyProcessStartedAtSeconds: set.identity.processStartedAtSeconds,
    proxyProcessGroupId: set.identity.processGroupId,
    canonicalEndpoint: set.endpoint,
  } as const;
  const base = {
    proxyInstanceId: set.shared.proxyInstanceId,
    snapshotOperations: async () => [],
    installHandoffGrant: async () => undefined,
    stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
    stopHeartbeats: () => undefined,
    initiateControlClose: async () => undefined,
  } as const;
  const authorityForClient = (client: { call(method: string, params: unknown, timeoutMs: number): Promise<unknown> }) =>
    createProviderProxyOperationAuthority({
      base,
      setIdentity,
      proxyClient: client,
      guardianClient,
      mutationRpcTimeoutMs: 5_000,
    });
  const authority = authorityForClient(proxyClient);
  let activeAuthority = authority;
  const registry = new LocalOperationRegistry();
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
    getProgressStore: () => ({ getDb: () => db, commit, readStatus: () => null }),
    authorityFor: () => activeAuthority,
    registry,
    backendNamespace: 'tests',
    time,
  });
  reconciler.start();
  cleanups.push(() => reconciler.stop());
  const route = createAppServerProxyRoute({
    hostManager: { routeAppServerOperation: () => authority },
    reconciler,
    now: () => time.now(),
  });
  const operationId = randomUUID();
  const jobId = randomUUID();
  const localExecution = vi.fn();

  const placementPromise = route.activate(
    {
      jobId,
      operationId,
      hostSpec: {
        provider: 'codex',
        command: 'codex',
        args: ['app-server'],
        cwd: '/workspace',
        leaseMode: 'job-exclusive',
      },
      provider: PREPARED.provider,
      binding: PREPARED.binding,
      request: PREPARED.request,
      persistedContinuity: null,
      baseEnv: PREPARED.baseEnv,
      protectedEnv: PREPARED.protectedEnv,
      platform: PREPARED.platform,
    },
    () => {},
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
    replaceAuthority: (client: { call(method: string, params: unknown, timeoutMs: number): Promise<unknown> }) => {
      activeAuthority = authorityForClient(client);
      return activeAuthority;
    },
    runtimeStarted,
  };
}

async function prepare(
  set: ProxyUnderTest,
  operation = set.operationFor(),
): Promise<{ operation: ReturnType<ProxyUnderTest['operationFor']>; reserved: Record<string, string> }> {
  const reserved = (await set.control.call(
    'operation.prepare.v1',
    { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
    5_000,
  )) as Record<string, string>;
  return { operation, reserved };
}

async function activate(set: ProxyUnderTest, operation: unknown, reserved: Record<string, string>): Promise<unknown> {
  return set.control.call(
    'operation.activate.v1',
    {
      operation,
      reservation: reserved.reservation,
      jointContainmentReceipt: reserved.jointContainmentReceipt,
      jointActivationReceipt: 'joint-activation-1',
    },
    5_000,
  );
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
  await set.control.call(
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

async function installGrant(set: ProxyUnderTest, operationIds: readonly string[]): Promise<Record<string, unknown>> {
  const operations = [...operationIds].sort().map((operationId) => ({
    jobId: randomUUID(),
    operationId: operationId as ReturnType<typeof randomUUID>,
    proxyInstanceId: set.shared.proxyInstanceId,
    buildSetId: set.shared.buildSetId,
  }));
  return installGrantForOperations(set, operations);
}

describe('provider-proxy operation lifecycle', () => {
  it('reserves, stages the root with both authorities, and starts the kernel exactly once', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);

    expect(reserved.state).toBe('pending-activation');
    expect(reserved.jointContainmentReceipt).toBe('joint-1');
    expect(reserved.providerRoot).toEqual({ pid: 7_001, processStartedAtSeconds: 800 });
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

  it('does not fall back locally when the activation reply is lost after the proxy starts', async () => {
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
    await set.control.call('operation.stop.v1', { operation, cause: 'signal_abort' }, 5_000);
    await vi.waitFor(() => expect(set.proxy.ledger().get(operation)?.state).toBe('terminal-awaiting-settlement'));

    set.control.close();
    set.advanceSilently(5_001);
    const executing = readProviderOperation(launched.db, operation);
    if (executing?.phase !== 'executing') throw new Error('expected executing journal row');
    const settlement = providerOperationRecordSchema.parse({
      ...executing,
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
    const redeemed = (await successor.call('handoff.redeem.v1', grant, 5_000)) as {
      controlEpoch: number;
      heartbeatChallenge: string;
    };
    await successor.call(
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

  it('does not fall back locally when both activation attempts lose their replies', async () => {
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

  it('does not let a guardian activation timeout authorise local fallback', async () => {
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

    await expect(activate(set, operation, reserved)).rejects.toThrow(/did not recognise/u);
    expect(set.started).toEqual([]);
  });

  it('refuses a prepare naming a different host fingerprint', async () => {
    const set = await startProxy();

    await expect(
      set.control.call(
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

  it('fences a failed prepare so only a higher explicit attempt can retry', async () => {
    const set = await startProxy({ failStageOnce: true });
    const operation = set.operationFor();

    await expect(
      set.control.call(
        'operation.prepare.v1',
        { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
        5_000,
      ),
    ).rejects.toThrow(/the guardian refused to stage this root/u);

    const key = { jobId: operation.jobId, operationId: operation.operationId };
    expect(set.proxy.ledger().get(key)).toBeNull();
    expect(set.released).toEqual([key]);

    await expect(
      set.control.call(
        'operation.prepare.v1',
        { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
        5_000,
      ),
    ).rejects.toThrow(/attempt is fenced/u);
    await expect(
      set.control.call(
        'operation.prepare.v1',
        { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 2, prepared: PREPARED },
        5_000,
      ),
    ).resolves.toMatchObject({ state: 'pending-activation' });
  });

  it('returns the original prepare result when its successful reply is retried', async () => {
    const set = await startProxy();
    const operation = set.operationFor();
    const request = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };

    const first = await set.control.call('operation.prepare.v1', request, 5_000);
    const retry = await set.control.call('operation.prepare.v1', request, 5_000);

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
    expect(reserved).toEqual({ state: 'capacity', retryable: true, reason: 'operation-ledgers' });
  });

  it('moves an expired reservation to a state control can still cancel', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await set.advanceWithHeartbeat(15_001);

    await expect(activate(set, operation, reserved)).rejects.toThrow(/lease expired/u);

    // The reservation is not silently gone: durable meta may already name it, so it stays cancellable by
    // exactly the reservation that was authorized.
    expect(
      await set.control.call('operation.cancel-pending.v1', { operation, reservation: reserved.reservation }, 5_000),
    ).toEqual({ state: 'released' });
  });

  it('renews a pending-activation reservation, extending its lease from the call’s own now', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await set.advanceWithHeartbeat(1_000);

    const renewed = (await set.control.call(
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
      set.control.call('operation.renew-activation.v1', { operation, reservation: asReservation(randomUUID()) }, 5_000),
    ).rejects.toThrow(/different reservation/u);

    // The same call with the reservation this operation actually holds still renews, so the refusal above is
    // about the value and not about the method. Renew once compared only half of a two-field reservation
    // while its schema demanded both, so a wrong second half renewed successfully; with one value there is
    // no half to get wrong.
    expect(
      await set.control.call('operation.renew-activation.v1', { operation, reservation: reserved.reservation }, 5_000),
    ).toMatchObject({ state: 'pending-activation' });
  });

  it('reports a repeated cancel as released rather than not-found', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    const request = {
      operation,
      reservation: reserved.reservation,
    };
    await set.control.call('operation.cancel-pending.v1', request, 5_000);

    expect(await set.control.call('operation.cancel-pending.v1', request, 5_000)).toEqual({ state: 'released' });
  });

  it('refuses a cancel presenting a different reservation', async () => {
    const set = await startProxy();
    const { operation } = await prepare(set);

    await expect(
      set.control.call('operation.cancel-pending.v1', { operation, reservation: asReservation(randomUUID()) }, 5_000),
    ).rejects.toThrow(/different reservation/u);
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

    const stopped = (await set.control.call('operation.stop.v1', { operation, cause }, 5_000)) as { state: string };

    // Only a recorded restart or handoff suspends. Claiming the abort causes interrupted the operation
    // would write an interruption the user never suffered.
    expect(stopped.state).toBe(expected);
    expect(set.stopped).toEqual([{ jobId: operation.jobId, operationId: operation.operationId, cause }]);
  });

  it('releases a pending-activation entry on stop without calling a kernel that never started', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);

    const stopped = (await set.control.call('operation.stop.v1', { operation, cause: 'user_abort' }, 5_000)) as {
      state: string;
    };

    // `SemanticOperationHost.stop`'s contract is "stops a running kernel" — this one was never started.
    expect(stopped.state).toBe('released');
    expect(set.stopped).toEqual([]);
    // Released, not stuck: a cancel for the same reservation now reports it as already gone.
    expect(
      await set.control.call('operation.cancel-pending.v1', { operation, reservation: reserved.reservation }, 5_000),
    ).toEqual({ state: 'released' });
  });

  it('refuses adoption before any grant has been redeemed on this proxy', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);

    await expect(
      set.control.call('operation.adopt.v1', { operation, committedThroughProviderSeq: 0 }, 5_000),
    ).rejects.toThrow(/No grant has been redeemed/u);
  });

  it('adopts only operations inside the redeemed set', async () => {
    const set = await startProxy();
    const inside = await prepare(set);
    const outside = await prepare(set);
    await activate(set, inside.operation, inside.reserved);
    await activate(set, outside.operation, outside.reserved);
    const redeem = await installGrant(set, [inside.operation.operationId]);
    set.control.close();
    set.advanceSilently(5_001);

    const successor = await connectControlClient(set.endpoint, timer, 5_000);
    cleanups.push(() => successor.close());
    const redeemed = (await successor.call('handoff.redeem.v1', redeem, 5_000)) as {
      state: string;
      operations: Record<string, string>[];
      controlEpoch: number;
      heartbeatChallenge: string;
    };
    expect(redeemed.state).toBe('redeemed-provisional');
    await successor.call(
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    );

    expect(
      await successor.call(
        'operation.adopt.v1',
        { operation: inside.operation, committedThroughProviderSeq: 0 },
        5_000,
      ),
    ).toEqual({ state: 'executing', replayFromProviderSeq: 1 });
    // An otherwise valid, executing operation outside the redeemed set is one this successor never earned,
    // however good its control tenancy is.
    await expect(
      successor.call('operation.adopt.v1', { operation: outside.operation, committedThroughProviderSeq: 0 }, 5_000),
    ).rejects.toThrow(/outside the redeemed set/u);
  });

  it('refuses a grant installed against another proxy instance', async () => {
    const set = await startProxy();

    await expect(
      set.control.call(
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
    // Deliberately descending: whichever of the two sorts later goes first.
    const [first, second] = opA.operationId < opB.operationId ? [opB, opA] : [opA, opB];
    const install = (operations: ReturnType<typeof set.operationFor>[]): Promise<unknown> =>
      set.control.call(
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
    await expect(install([first, second])).rejects.toMatchObject({ protocolCode: 'protocol_violation' });
    // Duplicated is refused for the same reason, not merely unsorted.
    await expect(install([first, first])).rejects.toMatchObject({ protocolCode: 'protocol_violation' });
  });

  it("keeps a redeemed successor's first challenge answerable for the full lease, unclamped by any ceiling", async () => {
    const set = await startProxy();
    // A grant that names no operations is enough: only the tenancy this redemption opens is under test.
    const redeem = await installGrant(set, []);
    set.control.close();
    set.advanceSilently(5_001);

    const successor = await connectControlClient(set.endpoint, timer, 5_000);
    cleanups.push(() => successor.close());
    const redeemed = (await successor.call('handoff.redeem.v1', redeem, 5_000)) as {
      controlEpoch: number;
      heartbeatChallenge: string;
    };

    // Right up to — but not reaching — the bare lease boundary measured from redemption itself: operational
    // control carries no adoption-style ceiling to clamp this any earlier, unlike the enforcer's own first
    // challenge (see orphan-deadline.test.ts's "caps the first challenge at the adoption deadline").
    set.advanceSilently(PROXY_CONTROL_LEASE_MS - 1);
    const stillLive = (await successor.call(
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    )) as { state: string };
    expect(stillLive.state).toBe('active');
  });

  it('answers operation.status.v1 from a second connection while control stays with the incumbent', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);

    // A third party — e.g. a coordinator checking whether this proxy still holds an operation it lost
    // track of — connects without ever claiming control. Before the fix, `acceptConnection` destroyed this
    // socket at accept time purely because a live control tenancy already existed, so the one method the
    // observation authority exists for could never be reached while a tenancy was actually live: the normal
    // case, not the edge case.
    const observer = await connectControlClient(set.endpoint, timer, 5_000);
    cleanups.push(() => observer.close());

    const status = (await observer.call('operation.status.v1', { operations: [operation] }, 5_000)) as {
      proxyInstanceId: string;
      operations: unknown[];
    };

    expect(status.proxyInstanceId).toBe(set.shared.proxyInstanceId);
    expect(status.operations).toEqual([{ operation, held: true, state: 'executing', committedThroughProviderSeq: 0 }]);

    // The incumbent's own control tenancy is untouched by the observer's connection: it can still mutate.
    const another = await prepare(set);
    expect(another.reserved.state).toBe('pending-activation');
  });

  it('bounds operation.status.v1 to PROXY_STATUS_RPC_TIMEOUT_MS, unlike an ordinary mutation method', async () => {
    const observedBudgetsMs: number[] = [];
    const set = await startProxy({ timer: recordingTimer(observedBudgetsMs) });
    const { operation, reserved } = await prepare(set);

    observedBudgetsMs.length = 0;
    await set.control.call('operation.renew-activation.v1', { operation, reservation: reserved.reservation }, 5_000);
    // An ordinary mutation method declares no `budgetMs` of its own, so it inherits the endpoint default.
    expect(observedBudgetsMs).toEqual([PROXY_CONTROL_RPC_TIMEOUT_MS, PROXY_PENDING_ACTIVATION_LEASE_MS]);

    observedBudgetsMs.length = 0;
    await set.control.call('operation.status.v1', { operations: [operation] }, 5_000);
    // `operation.status.v1` declares its own, tighter budget: an observation call, not a mutation the caller
    // is blocked on, so it is bounded well below the ordinary control budget rather than inheriting it.
    expect(observedBudgetsMs).toEqual([PROXY_STATUS_RPC_TIMEOUT_MS]);
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

    const emitted = set.proxy.emitProviderEvent(key, { kind: 'progress', message: 'tick' });
    expect(emitted).toEqual({ paused: false });

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

  it('resends the identical event when told to replay, until it is genuinely acknowledged', async () => {
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

    await vi.waitFor(() => expect(set.proxy.ledger().get(key)?.committedThroughProviderSeq).toBe(1));
    // The same event, sent twice — a `replay` reply does not advance providerSeq allocation.
    expect(receivedSeqs).toEqual([1, 1]);
  });

  it('pauses once the per-operation event ceiling is crossed', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);
    const key = { jobId: operation.jobId, operationId: operation.operationId };

    let paused = false;
    for (let index = 0; index < MAX_PROVIDER_REPLAY_EVENTS; index += 1) {
      paused = set.proxy.emitProviderEvent(key, { kind: 'progress', message: `tick-${index}` }).paused;
    }

    expect(paused).toBe(true);
  });

  it('throws replay_capacity_exhausted for a single event too large to ever buffer, and buffers nothing', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);
    const key = { jobId: operation.jobId, operationId: operation.operationId };

    let caught: unknown;
    try {
      set.proxy.emitProviderEvent(key, { kind: 'progress', message: 'x'.repeat(MAX_PROVIDER_REPLAY_BYTES) });
    } catch (error: unknown) {
      caught = error;
    }

    expect((caught as { code?: string } | undefined)?.code).toBe('replay_capacity_exhausted');
    expect(set.proxy.ledger().get(key)?.bufferedEvents).toEqual([]);
  });

  it('keeps an unacknowledged event buffered through a control loss, and delivers it once a successor adopts', async () => {
    // No handler on this first connection: the proxy's own push is refused, so the event stays buffered
    // exactly as it would if control had gone genuinely unreachable — the recovery path under test does not
    // depend on which failure mode left the event unacknowledged.
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);
    const key = { jobId: operation.jobId, operationId: operation.operationId };

    set.proxy.emitProviderEvent(key, { kind: 'progress', message: 'first' });
    await vi.waitFor(() => expect(set.proxy.ledger().get(key)?.bufferedEvents).toHaveLength(1));

    const redeem = await installGrant(set, [operation.operationId]);
    set.control.close();
    set.advanceSilently(5_001);

    const received: unknown[] = [];
    const successor = await connectControlClient(set.endpoint, timer, 5_000, (request) => {
      received.push(request);
      return { kind: 'ack', committedThroughProviderSeq: request.providerSeq };
    });
    cleanups.push(() => successor.close());
    const redeemed = (await successor.call('handoff.redeem.v1', redeem, 5_000)) as {
      controlEpoch: number;
      heartbeatChallenge: string;
    };
    await successor.call(
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    );

    const adopted = (await successor.call(
      'operation.adopt.v1',
      { operation, committedThroughProviderSeq: 0 },
      5_000,
    )) as { replayFromProviderSeq: number };
    expect(adopted.replayFromProviderSeq).toBe(1);

    // Waiting on the ledger's own watermark, not `received.length`: the handler runs (and pushes into
    // `received`) before its `ack` reply has even been written back, let alone round-tripped through
    // `pushOnTenancy` to `ledger.acknowledge` — asserting on `received` alone would race that continuation.
    await vi.waitFor(() => expect(set.proxy.ledger().get(key)?.committedThroughProviderSeq).toBe(1));
    expect(received).toEqual([
      expect.objectContaining({ providerSeq: 1, event: { kind: 'progress', message: 'first' } }),
    ]);
  });

  it('resumes draining every held operation on a same-successor redeem retry, even without an explicit adopt', async () => {
    const set = await startProxy();
    const { operation, reserved } = await prepare(set);
    await activate(set, operation, reserved);
    const key = { jobId: operation.jobId, operationId: operation.operationId };
    set.proxy.emitProviderEvent(key, { kind: 'progress', message: 'first' });
    await vi.waitFor(() => expect(set.proxy.ledger().get(key)?.bufferedEvents).toHaveLength(1));

    const redeem = await installGrant(set, [operation.operationId]);
    set.control.close();
    set.advanceSilently(5_001);

    const received: number[] = [];
    const successor = await connectControlClient(set.endpoint, timer, 5_000, (request) => {
      received.push(request.providerSeq);
      return { kind: 'ack', committedThroughProviderSeq: request.providerSeq };
    });
    cleanups.push(() => successor.close());
    const redeemed = (await successor.call('handoff.redeem.v1', redeem, 5_000)) as {
      controlEpoch: number;
      heartbeatChallenge: string;
    };
    await successor.call(
      'control.heartbeat.v1',
      { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
      5_000,
    );

    // A retry of the identical redeem, on the same connection — the only branch that ever reaches
    // `reattachControl` for this proxy: `control.open.v1`'s own bootstrap nonce is single-use, so the
    // original coordinator's own tenancy can never re-enter it this way.
    await successor.call('handoff.redeem.v1', redeem, 5_000);

    await vi.waitFor(() => expect(received).toHaveLength(1));
  });
});
