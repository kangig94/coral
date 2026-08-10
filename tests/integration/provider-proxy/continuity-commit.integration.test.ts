import { mkdtempSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const providerRegistryDouble = vi.hoisted(() => ({ rehydrateBinding: vi.fn() }));
vi.mock('#src/providers/bootstrap.js', () => ({
  createBuiltInProviderRegistry: () => ({
    connectAppServerHost: () => undefined,
    rehydrateBinding: (binding: unknown) => providerRegistryDouble.rehydrateBinding(binding),
    sealPersistedCodecComponents: () => [],
  }),
}));

import { createProviderEventHandler } from '#src/coordinator/services/provider-event-application.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { TimerHandle } from '#src/infra/port-types.js';
import { JobStore } from '#src/jobs/store.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { SessionManager } from '#src/sessions/shell.js';
import type { BoundProvider, BoundProviderAppServerExecutionRuntime } from '#src/providers/bound-provider-contract.js';
import type { AppServerSession, HostRef, ProviderAppServerRuntime } from '#src/providers/contract.js';
import { codexThreadProvider } from '#src/providers/codex/thread-provider.js';
import type { CodexExecutionPlan } from '#src/providers/codex/execution-plan.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { ProxyAppServerHostAuthority } from '#src/provider-proxy/provider-root-authority.js';
import {
  connectControlClient,
  ControlClientError,
  type ControlClient,
  type ProviderEventHandler,
} from '#src/provider-proxy/control-client.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import { createProxy, type Proxy } from '#src/provider-proxy/proxy.js';
import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import {
  createSemanticOperationRuntime,
  SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS,
} from '#src/provider-proxy/semantic-operation-runner.js';
import type { ProxyBootstrapCapsule } from '#src/provider-proxy/bootstrap-capsule.js';
import {
  operationActivationFingerprint,
  operationPrepareAttemptKey,
  type ProviderOperationKey,
} from '#src/provider-proxy/ledger.js';
import { PROXY_PENDING_ACTIVATION_LEASE_MS } from '#src/provider-proxy/ledger.js';
import {
  type OperationIdentity,
  type ProxyIdentity,
  type ProxyPreparedAppServerOperation,
  type Reservation,
} from '#src/provider-proxy/protocol.js';
import {
  createFrameReader,
  decodeProxyControlFrame,
  encodeProxyControlFrame,
  providerEventRequestSchema,
} from '#src/provider-proxy/protocol.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { insertProviderOperation, readProviderOperation } from '#src/store/provider-operation-journal.js';
import { allocateTestSession } from '#tests/helpers/session.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { TEST_CODEX_PLAN } from '#tests/helpers/provider-credentials.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';

const NONCE = 'a'.repeat(64);
const HOST_FINGERPRINT = 'b'.repeat(64);

function deferred<T = void>(): Readonly<{ promise: Promise<T>; resolve(value?: T): void }> {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = (value) => accept(value as T);
  });
  return { promise, resolve };
}

async function drainMicrotasks(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function withinDiagnosticDeadline<T>(label: string, operation: Promise<T>, diagnose: () => unknown): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} stalled: ${JSON.stringify(diagnose())}`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

class ControlledTimer implements ControlEndpointTimer {
  nowMs = 0;
  #nextId = 0;
  readonly #timers = new Map<number, { dueAtMs: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = (this.#nextId += 1);
    this.#timers.set(id, { dueAtMs: this.nowMs + ms, callback });
    return { id, unref: () => undefined } as TimerHandle;
  }

  clearTimeout(handle: TimerHandle | null): void {
    this.#timers.delete((handle as (TimerHandle & { id?: number }) | null)?.id ?? -1);
  }

  advance(ms: number): void {
    this.nowMs += ms;
    for (;;) {
      const due = [...this.#timers]
        .filter(([, timer]) => timer.dueAtMs <= this.nowMs)
        .sort(([, left], [, right]) => left.dueAtMs - right.dueAtMs)[0];
      if (due === undefined) return;
      this.#timers.delete(due[0]);
      due[1].callback();
    }
  }
}

async function connectRawProviderEventControlClient(
  socketPath: string,
  timer: ControlledTimer,
  onProviderEvent: (request: Parameters<ProviderEventHandler>[0]) => Promise<unknown> | unknown,
): Promise<ControlClient> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  let nextId = 1;
  let closed = false;
  const pending = new Map<
    number,
    Readonly<{
      resolve(value: unknown): void;
      reject(error: Error): void;
      budget: { unref?: () => void };
    }>
  >();
  let latchedFault: ControlClientError | null = null;
  let resolveFault!: (error: ControlClientError) => void;
  const faulted = new Promise<ControlClientError>((resolve) => {
    resolveFault = resolve;
  });
  const listeners = new Set<(error: ControlClientError) => void>();
  const latchFault = (): void => {
    if (latchedFault !== null) return;
    latchedFault = new ControlClientError('control_client_closed', 'The raw test control channel closed.', 'closed');
    resolveFault(latchedFault);
    for (const listener of listeners) listener(latchedFault);
    for (const waiter of pending.values()) waiter.reject(latchedFault);
    pending.clear();
  };

  const read = createFrameReader(
    (frame) => {
      const message = decodeProxyControlFrame(frame);
      if ('method' in message) {
        if (message.method !== 'provider.event.v1') {
          socket.destroy(new Error(`Unexpected raw control method ${message.method}`));
          return;
        }
        void Promise.resolve(onProviderEvent(providerEventRequestSchema.parse(message.params))).then(
          (result) => socket.write(encodeProxyControlFrame({ jsonrpc: '2.0', id: message.id, result })),
          (error: unknown) => socket.destroy(error instanceof Error ? error : new Error(String(error))),
        );
        return;
      }
      if (message.id === null) return;
      const waiter = pending.get(Number(message.id));
      if (waiter === undefined) return;
      pending.delete(Number(message.id));
      timer.clearTimeout(waiter.budget);
      if ('error' in message) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    },
    () => socket.destroy(),
  );
  socket.on('data', read);
  socket.on('error', () => socket.destroy());
  socket.on('close', latchFault);

  return {
    faulted,
    onFault(listener) {
      if (latchedFault !== null) {
        listener(latchedFault);
        return () => undefined;
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    call(method, params, timeoutMs) {
      if (closed) return Promise.reject(new Error('The raw test control channel is closed.'));
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        const budget = timer.setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} exceeded its ${timeoutMs}ms budget.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, budget });
        socket.write(encodeProxyControlFrame({ jsonrpc: '2.0', id, method, params }));
      });
    },
    close() {
      closed = true;
      socket.destroy();
    },
  };
}

type RpcTrace = {
  threadStarts: number;
  turnStarts: number;
};

type Harness = Readonly<{
  runtime: Runtime;
  progressStore: JobStore;
  sessionManager: SessionManager;
  sessionId: string;
  operation: OperationIdentity;
  prepareAttemptKey: string;
  proxy: Proxy;
  control: Awaited<ReturnType<typeof connectControlClient>>;
  timer: ControlledTimer;
  trace: RpcTrace;
  relinquishments: Error[];
  cancellationDeadline: Readonly<{ isArmed(): boolean; expire(): void }>;
  firstProviderEventSeen: Promise<void>;
  assumeHandoffControl(): Promise<void>;
  reattachHandoffControl(): Promise<Awaited<ReturnType<typeof connectControlClient>>>;
  activate(): Promise<void>;
  close(): Promise<void>;
}>;

function durableWatermark(harness: Harness): number {
  const record = readProviderOperation(harness.progressStore.getDb(), harness.operation);
  if (record === null || !('committedThroughProviderSeq' in record)) {
    throw new Error('continuity fixture lost its executing provider-operation watermark');
  }
  return record.committedThroughProviderSeq;
}

function ledgerEntry(harness: Harness) {
  const entry = harness.proxy.ledger().get(harness.operation);
  if (entry === null) throw new Error('continuity fixture lost its proxy ledger entry');
  return entry;
}

async function controlFaultDisposition(harness: Harness): Promise<'faulted' | 'route-available'> {
  return Promise.race([
    harness.control.faulted.then(() => 'faulted' as const),
    harness.control
      .call(
        'operation.inspect.v2',
        { operation: harness.operation, prepareAttemptKey: harness.prepareAttemptKey },
        5_000,
      )
      .then(
        () => 'route-available' as const,
        () => 'faulted' as const,
      ),
  ]);
}

const openHarnesses: Harness[] = [];

beforeEach(() => {
  providerRegistryDouble.rehydrateBinding.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const harness of openHarnesses.splice(0).reverse()) await harness.close();
  vi.restoreAllMocks();
});

function handlerCatalog(bound: BoundProvider) {
  return {
    rehydrateBinding: () => ({ ok: true as const, value: bound }),
    renderBindingFailure: () => 'binding failure',
  };
}

async function createHarness(
  providerEvent: (
    realHandler: ProviderEventHandler,
    request: Parameters<ProviderEventHandler>[0],
  ) => ReturnType<ProviderEventHandler>,
  options?: Readonly<{ rawProviderEventResponses?: boolean; controlledCancellationDeadline?: boolean }>,
): Promise<Harness> {
  const baseDir = mkdtempSync(join(tmpdir(), 'coral-continuity-commit-'));
  const runtime = createRealRuntime('dev', { baseDir });
  const progressStore = new JobStore('continuity-commit-integration', runtime, createEventBodyCodec(), {
    db: openTestStoreDb(runtime),
    eventBus: new TypedEventBus(),
    providers: permissiveProviderLookupPort,
    reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
  });
  const sessionManager = SessionManager.forProduction(
    '/workspace',
    runtime,
    (cb) => progressStore.commit(cb),
    () => undefined,
    { db: progressStore.getDb() },
  );
  const jobId = randomUUID();
  const session = allocateTestSession(
    sessionManager,
    'codex',
    'agent',
    undefined,
    '/workspace',
    '/workspace',
    'continuity-commit-integration',
  );
  sessionManager.claimForJobSync(session.sessionId, jobId);
  progressStore.initJob({
    jobId,
    sessionId: session.sessionId,
    provider: 'codex',
    projectRoot: '/workspace',
    backendNamespace: 'continuity-commit-integration',
  });

  const endpoint = join(baseDir, 'proxy.sock');
  const buildSetId = randomUUID();
  const proxyInstanceId = randomUUID();
  const operation: OperationIdentity = { jobId, operationId: randomUUID(), proxyInstanceId, buildSetId };
  insertProviderOperation(progressStore.getDb(), providerOperationRecord('executing', { operation }));

  const prepared: ProxyPreparedAppServerOperation = {
    version: 1,
    provider: 'codex',
    binding: { provider: 'codex', kind: 'account', binding: {} },
    request: {
      action: 'exec',
      sessionId: session.sessionId,
      prompt: 'Say done.',
      cwd: '/workspace',
      bypassPermissions: false,
      coralEnv: {},
    },
    persistedContinuity: null,
    baseEnv: {},
    protectedEnv: {},
    platform: 'linux',
  };
  const trace: RpcTrace = { threadStarts: 0, turnStarts: 0 };
  const notification = {
    handler: null as ((message: { method: string; params?: Record<string, unknown> }) => void) | null,
  };
  const lease: AppServerSession = {
    rpc: (async (method: string) => {
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') {
        trace.threadStarts += 1;
        return { thread: { id: 'real-checkpoint-thread' } };
      }
      if (method === 'turn/start') {
        trace.turnStarts += 1;
        return { turn: { id: 'real-checkpoint-turn', status: 'inProgress' } };
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected Codex RPC '${method}'.`);
    }) as AppServerSession['rpc'],
    subscribe: (listener) => {
      notification.handler = listener;
      return () => {
        notification.handler = null;
      };
    },
    closed: new Promise<never>(() => undefined),
    interrupt: async () => ({ kind: 'accepted' }),
  };
  const hostRef: HostRef = {
    provider: 'codex',
    fingerprint: HOST_FINGERPRINT,
    instanceId: 'continuity-commit-host',
    leaseMode: 'job-exclusive',
    ownerJobId: jobId,
  };
  const bound = {
    name: 'codex',
    envelope: prepared.binding,
    decodeContinuity: (raw: unknown) => ({ ok: true as const, value: raw === null ? undefined : raw }),
    prepareExecution: () => ({
      kind: 'app-server' as const,
      hostSpec: {
        provider: 'codex',
        command: 'codex',
        args: ['app-server'],
        cwd: '/workspace',
        leaseMode: 'job-exclusive' as const,
      },
      execute: (executionRuntime: BoundProviderAppServerExecutionRuntime) => {
        executionRuntime.onHostRef(hostRef);
        const codexRuntime: ProviderAppServerRuntime<CodexExecutionPlan> = {
          ...executionRuntime,
          transport: 'app-server',
          appServerSession: lease,
          continuityBridge: { checkpoint: () => undefined, transportClosed: () => undefined },
          executionPlan: TEST_CODEX_PLAN,
        };
        return codexThreadProvider(prepared.request, codexRuntime);
      },
    }),
    appServer: {
      supportsInterrupt: true,
      supportsProbe: false,
      openReplacement: async () => ({ hostRef, close: async () => undefined }),
      interrupt: async () => undefined,
      probe: async () => ({ state: 'unavailable' as const }),
    },
    artifacts: { kind: 'none' as const, reason: 'integration fixture' },
  } as unknown as BoundProvider;
  providerRegistryDouble.rehydrateBinding.mockReturnValue({ ok: true, value: bound });

  const hostAuthority: ProxyAppServerHostAuthority = {
    beginOperation: () => ({
      selectCancellationMode: () => undefined,
      openSession: (() => {
        throw new Error('the bound fixture opens its own faithful Codex session');
      }) as never,
      attachSession: async () => null,
    }),
    rootIdentity: () => ({ pid: 4_242, processStartedAtSeconds: 1_700_000_000 }),
    closed: () => new Promise<never>(() => undefined),
    forceClose: async () => undefined,
  };

  const timer = new ControlledTimer();
  const relinquishments: Error[] = [];
  const cancellationDeadlineGate = deferred();
  let cancellationDeadlineArmed = false;
  const semanticRuntime: Runtime =
    options?.controlledCancellationDeadline === true
      ? {
          ...runtime,
          time: {
            now: () => runtime.time.now(),
            sleep: (ms, sleepOptions) => {
              if (ms !== SEMANTIC_OPERATION_CANCELLATION_TIMEOUT_MS) {
                return runtime.time.sleep(ms, sleepOptions);
              }
              cancellationDeadlineArmed = true;
              return new Promise<void>((resolve) => {
                const settle = (): void => resolve();
                cancellationDeadlineGate.promise.then(settle);
                sleepOptions?.signal?.addEventListener('abort', settle, { once: true });
              });
            },
            setTimeout: (callback, ms) => runtime.time.setTimeout(callback, ms),
            clearTimeout: (handle) => runtime.time.clearTimeout(handle),
            setInterval: (callback, ms) => runtime.time.setInterval(callback, ms),
            clearInterval: (handle) => runtime.time.clearInterval(handle),
          },
        }
      : runtime;
  // Forward reference: the semantic event pump owns this proxy after createProxy returns.
  // eslint-disable-next-line prefer-const
  let proxy!: Proxy;
  const semantic = createSemanticOperationRuntime({
    runtime: semanticRuntime,
    hostAuthority,
    getProxy: () => proxy,
    onRelinquish: (error) => relinquishments.push(error),
  });
  const capsule: ProxyBootstrapCapsule = {
    role: 'proxy',
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: HOST_FINGERPRINT,
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId,
    bootstrapNonce: NONCE,
    canonicalEndpoint: endpoint,
    guardianControlEndpoint: join(baseDir, 'guardian.sock'),
    proxyGuardianAuthSecret: 'c'.repeat(64),
  };
  const identity: ProxyIdentity = {
    proxyInstanceId,
    pid: 6_000,
    processStartedAtSeconds: 800,
    processGroupId: 6_000,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: HOST_FINGERPRINT,
    canonicalEndpoint: endpoint,
  };
  proxy = createProxy({
    capsule,
    clock: createMonotonicClock(Symbol('continuity-commit'), { readMilliseconds: () => BigInt(timer.nowMs) }),
    identity,
    host: semantic.host,
    timer,
    mintChallenge: () => randomUUID(),
    mintReceipt: () => randomUUID(),
    mintReservation: () => asReservation(randomUUID()),
    wallClockNow: () => Date.parse('2026-08-10T00:00:00.000Z'),
    containment: {
      stageProviderRoot: (key: ProviderOperationKey) => {
        const staged = semantic.stage(key, prepared);
        return {
          result: staged.result.then((result) =>
            result.state === 'staged'
              ? {
                  ...result,
                  receipt: asJointContainmentReceipt('continuity-contained'),
                }
              : result,
          ),
          confirmActivation: async () => undefined,
          abortAndRelease: staged.abortAndRelease,
        };
      },
    },
  });
  await proxy.listen();

  const realHandler = createProviderEventHandler({
    db: progressStore.getDb(),
    progressStore,
    appendContext: {
      now: () => new Date(runtime.time.now()),
      reducers: composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry),
      bodyCodec: progressStore.bodyCodec,
      providers: permissiveProviderLookupPort,
    },
    providerRegistry: handlerCatalog(bound),
    runtime,
    emitSessionReleased: () => undefined,
    recordedStopCauseFor: () => null,
    operations: { settled: () => undefined },
  });
  const firstProviderEventSeen = deferred();
  const onProviderEvent: ProviderEventHandler = (request) => {
    if (request.providerSeq === 1) firstProviderEventSeen.resolve();
    return providerEvent(realHandler, request);
  };
  const connectHarnessControl = (): Promise<ControlClient> =>
    options?.rawProviderEventResponses === true
      ? connectRawProviderEventControlClient(endpoint, timer, onProviderEvent)
      : connectControlClient(endpoint, timer, 5_000, onProviderEvent);
  const initialControl = await connectHarnessControl();
  const controls = [initialControl];
  let activeControl = initialControl;
  let handoffRedeem: Record<string, unknown> | null = null;
  let outstandingHeartbeatChallenge: string | null = null;
  const coordinator = {
    instanceId: randomUUID(),
    pid: 1,
    processStartedAtSeconds: 1,
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId,
  };
  const opened = (await activeControl.call('control.open.v1', { bootstrapNonce: NONCE, coordinator }, 5_000)) as {
    controlEpoch: number;
    heartbeatChallenge: string;
  };
  await activeControl.call(
    'control.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

  const harness: Harness = {
    runtime,
    progressStore,
    sessionManager,
    sessionId: session.sessionId,
    operation,
    prepareAttemptKey: operationPrepareAttemptKey({
      operation,
      hostFingerprint: HOST_FINGERPRINT,
      prepareAttemptNumber: 1,
      prepared,
    }),
    proxy,
    get control() {
      return activeControl;
    },
    timer,
    trace,
    relinquishments,
    cancellationDeadline: {
      isArmed: () => cancellationDeadlineArmed,
      expire: () => cancellationDeadlineGate.resolve(),
    },
    firstProviderEventSeen: withinDiagnosticDeadline(
      'first continuity provider event',
      firstProviderEventSeen.promise,
      () => ({ trace, ledger: proxy.ledger().get(operation) }),
    ),
    assumeHandoffControl: async () => {
      const grantId = randomUUID();
      const grant = {
        grantId,
        generation: capsule.generation,
        hostFingerprint: HOST_FINGERPRINT,
        buildSetId,
        proxyInstanceId,
      };
      const secret = 'd'.repeat(64);
      await activeControl.call(
        'handoff.install.v1',
        {
          ...grant,
          operations: [operation],
          secretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
          orphanTimeoutMs: 30_000,
        },
        5_000,
      );
      handoffRedeem = { ...grant, secret, successor: coordinator };
      activeControl.close();
      await drainMicrotasks();
      const successor = await connectHarnessControl();
      controls.push(successor);
      const redeemed = (await successor.call('handoff.redeem.v1', handoffRedeem, 5_000)) as {
        controlEpoch: number;
        heartbeatChallenge: string;
      };
      const heartbeat = (await successor.call(
        'control.heartbeat.v1',
        { controlEpoch: redeemed.controlEpoch, heartbeatChallenge: redeemed.heartbeatChallenge },
        5_000,
      )) as { nextHeartbeatChallenge: string };
      activeControl = successor;
      outstandingHeartbeatChallenge = heartbeat.nextHeartbeatChallenge;
    },
    reattachHandoffControl: async () => {
      if (handoffRedeem === null || outstandingHeartbeatChallenge === null) {
        throw new Error('handoff control must be established before it can be reattached');
      }
      const stale = activeControl;
      const replacement = await connectHarnessControl();
      controls.push(replacement);
      const reattached = (await replacement.call('handoff.redeem.v1', handoffRedeem, 5_000)) as {
        controlEpoch: number;
      };
      const heartbeat = (await replacement.call(
        'control.heartbeat.v1',
        {
          controlEpoch: reattached.controlEpoch,
          heartbeatChallenge: outstandingHeartbeatChallenge,
        },
        5_000,
      )) as { nextHeartbeatChallenge: string };
      activeControl = replacement;
      outstandingHeartbeatChallenge = heartbeat.nextHeartbeatChallenge;
      return stale;
    },
    activate: async () => {
      const request = { operation, hostFingerprint: HOST_FINGERPRINT, prepareAttemptNumber: 1, prepared };
      const staged = (await withinDiagnosticDeadline(
        'continuity prepare',
        activeControl.call('operation.prepare.v1', request, 5_000),
        () => ({ trace, ledger: proxy.ledger().get(operation) }),
      )) as {
        reservation: Reservation;
        jointContainmentReceipt: string;
      };
      const activation = {
        operation,
        reservation: staged.reservation,
        jointContainmentReceipt: staged.jointContainmentReceipt,
        jointActivationReceipt: asJointActivationReceipt('continuity-activated'),
      };
      const result = (await withinDiagnosticDeadline(
        'continuity activation',
        activeControl.call('operation.activate.v1', activation, 5_000),
        () => ({ trace, ledger: proxy.ledger().get(operation) }),
      )) as {
        activationFingerprint: string;
      };
      if (result.activationFingerprint === undefined) {
        throw new Error(`continuity activation did not execute: ${JSON.stringify(result)}`);
      }
      expect(result.activationFingerprint).toBe(operationActivationFingerprint(activation));
      expect(operationPrepareAttemptKey(request)).toHaveLength(64);
      await withinDiagnosticDeadline(
        'continuity attach',
        activeControl.call(
          'operation.attach.v1',
          { operation, committedThroughProviderSeq: durableWatermark(harness) },
          5_000,
        ),
        () => ({ trace, ledger: proxy.ledger().get(operation) }),
      );
      timer.advance(0);
    },
    close: async () => {
      for (const client of controls) client.close();
      await proxy.close();
      progressStore.getDb().close();
    },
  };
  openHarnesses.push(harness);
  return harness;
}

describe('provider proxy continuity commit bridge', () => {
  it('commits the original Codex checkpoint only after durable ACK', async () => {
    const enterTransaction = deferred();
    const releaseAck = deferred();
    const durableAckReady = deferred();
    const harness = await createHarness(async (handler, request) => {
      if (request.providerSeq === 1) {
        await enterTransaction.promise;
        const result = await handler(request);
        durableAckReady.resolve();
        await releaseAck.promise;
        return result;
      }
      return new Promise<never>(() => undefined);
    });
    await harness.activate();
    await harness.firstProviderEventSeen;

    expect(harness.trace).toEqual({ threadStarts: 1, turnStarts: 0 });
    expect(durableWatermark(harness)).toBe(0);

    enterTransaction.resolve();
    await durableAckReady.promise;
    expect(durableWatermark(harness)).toBe(1);
    expect(harness.trace.turnStarts).toBe(0);

    releaseAck.resolve();
    await vi.waitFor(() => expect(ledgerEntry(harness).committedThroughProviderSeq).toBe(1));
    await drainMicrotasks();

    expect(
      {
        threadStarts: harness.trace.threadStarts,
        durableWatermark: durableWatermark(harness),
        ledgerWatermark: ledgerEntry(harness).committedThroughProviderSeq,
        turnStarts: harness.trace.turnStarts,
      },
      'durable ACK must settle the exact kernel-owned checkpoint',
    ).toEqual({ threadStarts: 1, durableWatermark: 1, ledgerWatermark: 1, turnStarts: 1 });
  });

  it('does not commit continuity at replay admission', async () => {
    const enterTransaction = deferred();
    const harness = await createHarness(async (handler, request) => {
      if (request.providerSeq === 1) await enterTransaction.promise;
      return handler(request);
    });
    await harness.activate();
    await harness.firstProviderEventSeen;
    await drainMicrotasks();

    expect({
      durableWatermark: durableWatermark(harness),
      turnStarts: harness.trace.turnStarts,
    }).toEqual({ durableWatermark: 0, turnStarts: 0 });

    enterTransaction.resolve();
    await vi.waitFor(() => expect(harness.trace.turnStarts).toBe(1));
  });

  it('faults healthy control after one unanswered ACK budget', async () => {
    const harness = await createHarness(async () => new Promise<never>(() => undefined));
    await harness.activate();
    await harness.firstProviderEventSeen;

    harness.timer.advance(30_000);
    await expect(controlFaultDisposition(harness)).resolves.toBe('faulted');

    expect(harness.trace).toEqual({ threadStarts: 1, turnStarts: 0 });
    expect(ledgerEntry(harness).committedThroughProviderSeq).toBe(0);
    expect(ledgerEntry(harness).bufferedEvents).toHaveLength(1);
  });

  it('faults control on a malformed provider-event response', async () => {
    const harness = await createHarness(
      async (handler, request) => {
        await handler(request);
        return {} as never;
      },
      { rawProviderEventResponses: true },
    );
    await harness.activate();
    await harness.firstProviderEventSeen;
    await expect(controlFaultDisposition(harness)).resolves.toBe('faulted');

    expect(harness.trace).toEqual({ threadStarts: 1, turnStarts: 0 });
    expect(ledgerEntry(harness).committedThroughProviderSeq).toBe(0);
    expect(ledgerEntry(harness).bufferedEvents).toHaveLength(1);
  });

  it('carries a held push across same-holder socket reattachment', async () => {
    let continuityFrameCalls = 0;
    const harness = await createHarness((handler, request) => {
      if (request.providerSeq !== 1) return new Promise<never>(() => undefined);
      continuityFrameCalls += 1;
      if (continuityFrameCalls === 1) return new Promise<never>(() => undefined);
      if (continuityFrameCalls === 2) return handler(request);
      return new Promise<never>(() => undefined);
    });
    await harness.assumeHandoffControl();
    await harness.activate();
    await harness.firstProviderEventSeen;
    const stale = await harness.reattachHandoffControl();
    await expect(stale.faulted).resolves.toBeInstanceOf(Error);
    harness.timer.advance(0);

    await vi.waitFor(() => expect(ledgerEntry(harness).committedThroughProviderSeq).toBe(1));
    await vi.waitFor(() => expect(harness.trace.turnStarts).toBe(1));
    expect(continuityFrameCalls).toBe(2);
  });

  it('stop rejects a kernel waiting for continuity before awaiting done', async () => {
    const harness = await createHarness(async () => new Promise<never>(() => undefined), {
      controlledCancellationDeadline: true,
    });
    await harness.activate();
    await harness.firstProviderEventSeen;

    const stop = harness.control.call(
      'operation.stop.v1',
      { operation: harness.operation, cause: 'signal_abort' },
      5_000,
    );
    const stopFailure = stop.then(
      () => null,
      (error: unknown) => error,
    );
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(harness.cancellationDeadline.isArmed()).toBe(true);
    if (harness.relinquishments.length === 0) {
      harness.cancellationDeadline.expire();
      for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
    }

    expect(harness.relinquishments).toHaveLength(1);
    expect(harness.relinquishments[0]?.message).toContain(
      'The operation was cancelled before the continuity checkpoint was committed.',
    );

    expect(await stopFailure).toMatchObject({
      protocolCode: 'semantic_operation_cancellation_unconfirmed',
      message: expect.stringContaining('The operation was cancelled before the continuity checkpoint was committed.'),
    });
    expect(harness.trace).toEqual({ threadStarts: 1, turnStarts: 0 });
  });

  it('discards an ACK that arrives after beginRelease', async () => {
    const timer = new ControlledTimer();
    const startEntered = deferred();
    const startResult = deferred<{ kind: 'started'; hostRef: HostRef }>();
    const releaseGate = deferred();
    const pushed = deferred();
    const response = deferred<unknown>();
    const operation: OperationIdentity = {
      jobId: randomUUID(),
      operationId: randomUUID(),
      proxyInstanceId: randomUUID(),
      buildSetId: randomUUID(),
    };
    const prepared: ProxyPreparedAppServerOperation = {
      version: 1,
      provider: 'codex',
      binding: { provider: 'codex', kind: 'account', binding: {} },
      request: {
        action: 'exec',
        sessionId: randomUUID(),
        prompt: 'late ACK guard',
        cwd: '/workspace',
        bypassPermissions: false,
        coralEnv: {},
      },
      persistedContinuity: null,
      baseEnv: {},
      protectedEnv: {},
      platform: 'linux',
    };
    const supervisor = new OperationSupervisor({
      host: {
        start: () => {
          startEntered.resolve();
          return { result: startResult.promise, abortAndRelease: () => releaseGate.promise };
        },
        stop: async () => undefined,
      },
      timer,
      mintReservation: () => asReservation(randomUUID()),
      wallClockNow: () => Date.parse('2026-08-10T00:00:00.000Z'),
      nowMs: () => timer.nowMs,
      proxyInstanceId: operation.proxyInstanceId,
      buildSetId: operation.buildSetId,
      stageProviderRoot: () => ({
        result: Promise.resolve({
          state: 'staged' as const,
          providerRoot: { pid: 4_242, processStartedAtSeconds: 1_700_000_000 },
          receipt: asJointContainmentReceipt('late-ack-contained'),
        }),
        confirmActivation: async () => undefined,
        abortAndRelease: async () => undefined,
      }),
      pushProviderEvent: () => {
        pushed.resolve();
        return { controlEpoch: 1, response: response.promise };
      },
      faultProviderEventControl: () => undefined,
    });
    const request = {
      operation,
      hostFingerprint: HOST_FINGERPRINT,
      prepareAttemptNumber: 1,
      prepared,
    };
    const attemptKey = operationPrepareAttemptKey(request);
    const staged = (await supervisor.prepare(operation, {
      prepareAttemptNumber: 1,
      prepareAttemptKey: attemptKey,
      prepared,
    })) as { reservation: Reservation; jointContainmentReceipt: string };
    const activation = {
      operation,
      reservation: staged.reservation,
      jointContainmentReceipt: asJointContainmentReceipt(staged.jointContainmentReceipt),
      jointActivationReceipt: asJointActivationReceipt('late-ack-activation'),
    };
    void supervisor.activate(operation, {
      ...activation,
      activationFingerprint: operationActivationFingerprint(activation),
    });
    await startEntered.promise;

    const emission = supervisor.emitProviderEvent(operation, {
      kind: 'continuity',
      conversationRef: 'late-ack-thread',
      resumable: true,
      providerContinuity: { cwd: '/workspace', threadId: 'late-ack-thread' },
    });
    if (emission.kind !== 'continuity-recorded') throw new Error('expected a pending continuity settlement');
    const settlementFailure = emission.settlement.committed.then(
      () => null,
      (error: unknown) => error,
    );

    timer.advance(PROXY_PENDING_ACTIVATION_LEASE_MS);
    await drainMicrotasks();
    expect(await settlementFailure).toMatchObject({ code: 'continuity_commit_operation_released' });
    expect(supervisor.ledger().get(operation)).toMatchObject({
      state: 'releasing',
      committedThroughProviderSeq: 0,
      bufferedEvents: [{ providerSeq: 1 }],
    });

    supervisor.controlActivated(1);
    timer.advance(0);
    await pushed.promise;
    response.resolve({ kind: 'ack', committedThroughProviderSeq: 1 });
    await drainMicrotasks();

    expect(
      supervisor.ledger().get(operation),
      'a response from the released ownership epoch must not mutate replay state',
    ).toMatchObject({
      state: 'releasing',
      committedThroughProviderSeq: 0,
      bufferedEvents: [{ providerSeq: 1 }],
    });
    supervisor.close();
  });
});
