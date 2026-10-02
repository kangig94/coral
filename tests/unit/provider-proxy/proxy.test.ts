import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import { proxyOperationPrepareResultSchema, type OperationIdentity } from '#src/provider-proxy/protocol.js';
import { attachContinuityCommit } from '#src/providers/internal/continuity-commit.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';
import type * as MockedNodeNetModule from 'node:net';
vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof MockedNodeNetModule>();
  const { EventEmitter } = await import('node:events');
  const listeners = new Map<string, (socket: MemorySocket) => void>();
  class MemorySocket extends EventEmitter {
    destroyed = false;
    peer!: MemorySocket;
    write(data: string, done?: () => void): boolean {
      done?.();
      setImmediate(() => {
        if (!this.peer.destroyed) this.peer.emit('data', Buffer.from(data));
      });
      return true;
    }
    destroy(): this {
      if (this.destroyed) return this;
      this.destroyed = true;
      queueMicrotask(() => this.emit('close'));
      this.peer.destroy();
      return this;
    }
    end(data?: string, done?: () => void): this {
      if (data !== undefined) this.write(data);
      setImmediate(() => {
        done?.();
        this.destroy();
      });
      return this;
    }
  }
  return {
    ...actual,
    createServer: (accept: (socket: MemorySocket) => void) => {
      const server = new EventEmitter();
      let path = '';
      return Object.assign(server, {
        listen: (socketPath: string) => {
          path = socketPath;
          listeners.set(path, accept);
          queueMicrotask(() => server.emit('listening'));
        },
        close: (done: () => void) => {
          listeners.delete(path);
          done();
        },
      });
    },
    createConnection: (path: string) => {
      const client = new MemorySocket();
      const server = new MemorySocket();
      client.peer = server;
      server.peer = client;
      queueMicrotask(() => {
        const accept = listeners.get(path);
        if (accept === undefined) throw new Error(`No in-memory endpoint at ${path}`);
        accept(server);
        client.emit('connect');
      });
      return client;
    },
  };
});
import { strictControlExchangeResult as strictTestExchange } from '#tests/support/control-exchange.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { HostRef } from '#src/providers/contract.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import { connectControlClient, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  OPERATION_RELEASE_RETRY_MS,
  type OperationStageResult,
  type SemanticOperationHost,
  type SemanticOperationStartHandle,
} from '#src/provider-proxy/operation-supervisor.js';
import {
  PROXY_PENDING_ACTIVATION_LEASE_MS,
  operationActivationFingerprint,
  operationPrepareAttemptKey,
  type ProviderOperationKey,
} from '#src/provider-proxy/ledger.js';
import type { ProxyBootstrapCapsule } from '#src/provider-proxy/bootstrap-capsule.js';
import {
  proxyOperationActivationOutcomeSchema,
  type JointContainmentReceipt,
  type Reservation,
  type ProxyIdentity,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';

const timer: ControlEndpointTimer = {
  setTimeout: () => ({}),
  clearTimeout: () => {},
};

const NONCE = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(64);
const STARTED_AT_MS = Date.parse('2026-08-09T12:34:56.000Z');

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PREPARED: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'claude',
  binding: { provider: 'claude', kind: 'account', binding: {} },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'hi',
    cwd: fixtureCanonicalWorkDir('/tmp'),
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: {},
  protectedEnv: {},
  platform: 'linux',
};

function hostRefFor(jobId: string): HostRef {
  return {
    provider: PREPARED.provider,
    fingerprint: FINGERPRINT,
    instanceId: 'host-instance-1',
    leaseMode: 'job-exclusive',
    ownerJobId: jobId,
  };
}

function fakeHost(): SemanticOperationHost & {
  released: ProviderOperationKey[];
  settled: ProviderOperationKey[];
  starts: number;
  stops: number;
} {
  const released: ProviderOperationKey[] = [];
  const settled: ProviderOperationKey[] = [];
  return {
    released,
    settled,
    starts: 0,
    stops: 0,
    start({ key }) {
      this.starts += 1;
      return startHandle(Promise.resolve({ kind: 'started', hostRef: hostRefFor(key.jobId) }));
    },
    stop() {
      this.stops += 1;
    },
  };
}

function startHandle(
  result: SemanticOperationStartHandle['result'],
  abortAndRelease: SemanticOperationStartHandle['abortAndRelease'] = async () => {},
): SemanticOperationStartHandle {
  return { result, abortAndRelease };
}

function controlledTimer(): {
  timer: ControlEndpointTimer;
  readMilliseconds: () => bigint;
  pendingCount(): number;
  advance(ms: number): void;
} {
  let elapsedMs = 0;
  let nextId = 0;
  type Handle = { id: number; dueAtMs: number; callback: () => void; unref(): void };
  const pending = new Map<number, Handle>();
  return {
    readMilliseconds: () => BigInt(elapsedMs),
    pendingCount: () => pending.size,
    timer: {
      setTimeout: (callback, ms) => {
        const handle: Handle = {
          id: (nextId += 1),
          dueAtMs: elapsedMs + ms,
          callback,
          unref: () => {},
        };
        pending.set(handle.id, handle);
        return handle;
      },
      clearTimeout: (rawHandle) => {
        const handle = rawHandle as Handle;
        pending.delete(handle.id);
      },
    },
    advance: (ms) => {
      elapsedMs += ms;
      while (true) {
        const due = [...pending.values()]
          .filter((handle) => handle.dueAtMs <= elapsedMs)
          .sort((left, right) => left.dueAtMs - right.dueAtMs)[0];
        if (due === undefined) return;
        pending.delete(due.id);
        due.callback();
      }
    },
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = (value) => settle(value as T);
  });
  return { promise, resolve };
}

type PreparedOperation = ProviderOperationKey & { proxyInstanceId: string; buildSetId: string };

async function startProxy(
  host: SemanticOperationHost,
  endpointTimer: ControlEndpointTimer = timer,
  options: {
    readMilliseconds?: () => bigint;
    onProviderEvent?: Parameters<typeof connectControlClient>[3];
    stageProviderRoot?: (signal: AbortSignal) => Promise<OperationStageResult>;
    stageAbortAndRelease?: () => Promise<void>;
    confirmActivation?: () => Promise<void>;
    releaseMembership?: (input: Readonly<{ key: ProviderOperationKey; reservation: Reservation }>) => Promise<void>;
    wallClockNow?: () => number;
  } = {},
): Promise<{
  control: ControlClient;
  operation: PreparedOperation;
  proxy: ReturnType<typeof createProxy>;
  capsule: ProxyBootstrapCapsule;
}> {
  const directory = '/proxy-test';
  const endpoint = join(directory, 'p.sock');
  const buildSetId = randomUUID();
  const capsule: ProxyBootstrapCapsule = {
    role: 'proxy',
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: FINGERPRINT,
    guardianInstanceId: randomUUID(),
    reaperInstanceId: randomUUID(),
    proxyInstanceId: randomUUID(),
    bootstrapNonce: NONCE,
    canonicalEndpoint: endpoint,
    guardianControlEndpoint: join(directory, 'g.sock'),
    proxyGuardianAuthSecret: 'c'.repeat(64),
  };
  const identity: ProxyIdentity = {
    proxyInstanceId: capsule.proxyInstanceId,
    pid: 6_000,
    incarnation: testIncarnation(800),
    processGroupId: 6_000,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    generation: 'gen2',
    flavor: 'prod',
    buildSetId,
    hostFingerprint: FINGERPRINT,
    canonicalEndpoint: endpoint,
  };
  const clock =
    options.readMilliseconds === undefined
      ? createMonotonicClock(Symbol('proxy-test'))
      : createMonotonicClock(Symbol('proxy-test'), { readMilliseconds: options.readMilliseconds });
  let counter = 0;
  const proxy = createProxy({
    capsule,
    clock,
    identity,
    host,
    timer: endpointTimer,
    mintChallenge: () => `challenge-${(counter += 1)}`,
    mintReceipt: () => `receipt-${(counter += 1)}`,
    mintReservation: () => asReservation(randomUUID()),
    wallClockNow: options.wallClockNow ?? (() => STARTED_AT_MS),
    containment: {
      stageProviderRoot: (key, reserved) => {
        const abortController = new AbortController();
        const result = (
          options.stageProviderRoot ??
          (async () => ({
            state: 'staged' as const,
            providerRoot: { pid: 7_000, incarnation: testIncarnation(900) },
            receipt: asJointContainmentReceipt('joint-1'),
          }))
        )(abortController.signal);
        let localReleased = false;
        let membershipReleased = false;
        return {
          result,
          confirmActivation: options.confirmActivation ?? (async () => {}),
          abortAndRelease: async () => {
            abortController.abort();
            await options.stageAbortAndRelease?.();
            try {
              await result;
            } catch {
              return;
            }
            const tracked = host as Partial<{ released: ProviderOperationKey[]; settled: ProviderOperationKey[] }>;
            if (!localReleased) {
              localReleased = true;
              tracked.released?.push(key);
              if (tracked.settled !== undefined && proxy.ledger().get(key)?.state === 'releasing') {
                const entry = proxy.ledger().get(key);
                if (entry !== null && entry.activationAck !== null) tracked.settled.push(key);
              }
            }
            if (membershipReleased) return;
            await (options.releaseMembership ?? (async () => {}))({ key, reservation: reserved.reservation });
            membershipReleased = true;
          },
        };
      },
    },
  });
  await proxy.listen();
  cleanups.push(() => proxy.close());

  const control = await connectControlClient(endpoint, timer, 5_000, options.onProviderEvent);
  cleanups.push(() => control.close());
  const coordinatorIdentity = {
    instanceId: randomUUID(),
    pid: 1,
    incarnation: testIncarnation(1),
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId,
  };
  const opened = (await strictTestExchange(
    control,
    'control.open.v1',
    { bootstrapNonce: NONCE, coordinator: coordinatorIdentity },
    5_000,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  // Control is not "active" (able to call mutation methods) until the first heartbeat is echoed back.
  await strictTestExchange(
    control,
    'control.heartbeat.v1',
    { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
    5_000,
  );

  const operation = {
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: capsule.proxyInstanceId,
    buildSetId,
  };
  return { control, operation, proxy, capsule };
}

describe('provider-proxy truthful operation authority', () => {
  it('replays the stored activation ACK without starting the host twice', async () => {
    const host = fakeHost();
    const { control, operation } = await startProxy(host);
    const prepareRequest = {
      operation,
      hostFingerprint: FINGERPRINT,
      prepareAttemptNumber: 1,
      prepared: PREPARED,
    };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    const prepared = (await strictTestExchange(control, 'operation.prepare.v1', prepareRequest, 5_000)) as {
      reservation: Reservation;
      jointContainmentReceipt: JointContainmentReceipt;
    };
    const activation = {
      operation,
      reservation: prepared.reservation,
      jointContainmentReceipt: prepared.jointContainmentReceipt,
      jointActivationReceipt: asJointActivationReceipt('activation-1'),
    };

    const first = proxyOperationActivationOutcomeSchema.parse(
      await strictTestExchange(control, 'operation.activate.v1', activation, 5_000),
    );
    const replay = await strictTestExchange(control, 'operation.activate.v1', activation, 5_000);
    const awaitingPublication = await strictTestExchange(
      control,
      'operation.inspect.v1',
      { operation, prepareAttemptKey },
      5_000,
    );
    await strictTestExchange(control, 'operation.attach.v1', { operation, committedThroughProviderSeq: 0 }, 5_000);
    const attached = await strictTestExchange(control, 'operation.inspect.v1', { operation, prepareAttemptKey }, 5_000);

    expect(first).toEqual({
      state: 'executing',
      activationFingerprint: operationActivationFingerprint(activation),
      startedAt: new Date(STARTED_AT_MS).toISOString(),
      hostRef: hostRefFor(operation.jobId),
      committedThroughProviderSeq: 0,
    });
    expect(replay).toEqual(first);
    expect(awaitingPublication).toEqual({ ...first, state: 'started-awaiting-publication' });
    expect(attached).toEqual(first);
    expect(host.starts).toBe(1);
  });

  it('retains a failed guardian release and retries it from the releasing state', async () => {
    const controlled = controlledTimer();
    const firstRelease = deferred();
    const retriedRelease = deferred();
    const releaseMembership = vi
      .fn(async () => {
        retriedRelease.resolve();
      })
      .mockImplementationOnce(async () => {
        firstRelease.resolve();
        throw new Error('guardian unavailable');
      });
    const host = fakeHost();
    const { control, operation, proxy } = await startProxy(host, controlled.timer, {
      readMilliseconds: controlled.readMilliseconds,
      releaseMembership,
    });
    const prepareRequest = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    await strictTestExchange(control, 'operation.prepare.v1', prepareRequest, 5_000);

    controlled.advance(PROXY_PENDING_ACTIVATION_LEASE_MS);

    await firstRelease.promise;
    await expect(
      strictTestExchange(control, 'operation.inspect.v1', { operation, prepareAttemptKey }, 5000),
    ).resolves.toMatchObject({ state: 'releasing' });
    expect(releaseMembership).toHaveBeenCalledTimes(1);

    controlled.advance(OPERATION_RELEASE_RETRY_MS);

    await retriedRelease.promise;
    expect(releaseMembership).toHaveBeenCalledTimes(2);
    await expect(
      strictTestExchange(control, 'operation.inspect.v1', { operation, prepareAttemptKey }, 5000),
    ).resolves.toMatchObject({ state: 'released-never-started' });
    expect(proxy.ledger().get(operation)).toBeNull();
    await expect(
      strictTestExchange(control, 'operation.inspect.v1', { operation, prepareAttemptKey }, 5_000),
    ).resolves.toMatchObject({
      state: 'released-never-started',
    });
  });
});

const CONTINUITY_PREPARED: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: {} },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'hi',
    cwd: fixtureCanonicalWorkDir('/tmp'),
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: {},
  protectedEnv: {},
  platform: 'linux',
};

const supervisors: OperationSupervisor[] = [];
afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.close();
});

async function preparedOperation(
  pushProviderEvent: ConstructorParameters<typeof OperationSupervisor>[0]['pushProviderEvent'],
  startOverride?: SemanticOperationStartHandle,
) {
  const operation: OperationIdentity = {
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: randomUUID(),
    buildSetId: randomUUID(),
  };
  const time = new VirtualTime();
  const start = vi.fn(
    () =>
      startOverride ?? {
        result: Promise.resolve({
          kind: 'started' as const,
          hostRef: {
            provider: 'codex',
            fingerprint: 'a'.repeat(64),
            instanceId: 'host-1',
            leaseMode: 'shared' as const,
          },
        }),
        abortAndRelease: async () => {},
      },
  );
  const supervisor = new OperationSupervisor({
    host: { start, stop: async () => {} },
    timer: time,
    nowMs: () => time.now(),
    wallClockNow: () => 0,
    mintReservation: () => asReservation(randomUUID()),
    proxyInstanceId: operation.proxyInstanceId,
    buildSetId: operation.buildSetId,
    stageProviderRoot: () => ({
      result: Promise.resolve({
        state: 'staged' as const,
        providerRoot: { pid: 4242, incarnation: testIncarnation(1700000000) },
        receipt: asJointContainmentReceipt('containment'),
      }),
      confirmActivation: async () => {},
      abortAndRelease: async () => {},
    }),
    pushProviderEvent,
    faultProviderEventControl: () => {},
  });
  supervisors.push(supervisor);
  const prepareAttemptKey = operationPrepareAttemptKey({
    operation,
    hostFingerprint: 'a'.repeat(64),
    prepareAttemptNumber: 1,
    prepared: CONTINUITY_PREPARED,
  });
  const prepared = proxyOperationPrepareResultSchema.parse(
    await supervisor.prepare(operation, { prepareAttemptNumber: 1, prepareAttemptKey, prepared: CONTINUITY_PREPARED }),
  );
  if (prepared.state !== 'pending-activation') throw new Error('expected pending activation');
  const activation = {
    operation,
    reservation: prepared.reservation,
    jointContainmentReceipt: prepared.jointContainmentReceipt,
    jointActivationReceipt: asJointActivationReceipt('activation'),
  };
  return {
    supervisor,
    operation,
    time,
    start,
    activate: () =>
      supervisor.activate(operation, {
        ...activation,
        activationFingerprint: operationActivationFingerprint(activation),
      }),
  };
}

it('commits provider continuity only after a durable ACK', async () => {
  const ack = createDeferred<unknown>();
  const { supervisor, operation, time, activate } = await preparedOperation(() => ({
    controlEpoch: 1,
    response: ack.promise,
  }));
  await activate();
  await supervisor.attach(operation, 0);
  const commit = vi.fn();
  const reject = vi.fn();
  const emission = supervisor.emitProviderEvent(
    operation,
    attachContinuityCommit(
      {
        kind: 'continuity',
        conversationRef: 'thread-1',
        resumable: true,
        providerContinuity: { provider: 'codex', state: { threadId: 'thread-1' } },
      },
      { commit, reject },
    ),
  );
  if (emission.kind !== 'continuity-recorded') throw new Error('expected continuity settlement');
  time.tick(1);
  expect(commit).not.toHaveBeenCalled();
  expect(supervisor.ledger().get(operation)?.committedThroughProviderSeq).toBe(0);

  ack.resolve({ kind: 'ack', committedThroughProviderSeq: 1 });
  await emission.settlement.committed;
  expect(commit).toHaveBeenCalledOnce();
  expect(reject).not.toHaveBeenCalled();
  expect(supervisor.ledger().get(operation)?.committedThroughProviderSeq).toBe(1);
});

it('discards an ACK that arrives after beginRelease', async () => {
  const response = createDeferred<unknown>();
  const pushed = createDeferred<void>();
  const startResult = createDeferred<{ kind: 'started'; hostRef: HostRef }>();
  const releaseGate = createDeferred<void>();
  const { supervisor, operation, time, start, activate } = await preparedOperation(
    () => {
      pushed.resolve();
      return { controlEpoch: 1, response: response.promise };
    },
    { result: startResult.promise, abortAndRelease: () => releaseGate.promise },
  );
  void activate();
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  const emission = supervisor.emitProviderEvent(operation, {
    kind: 'continuity',
    conversationRef: 'late-ack-thread',
    resumable: true,
    providerContinuity: { cwd: '/workspace', threadId: 'late-ack-thread' },
  });
  if (emission.kind !== 'continuity-recorded') throw new Error('expected a pending continuity settlement');
  const settlementFailure = emission.settlement.committed.catch((error: unknown) => error);
  time.tick(PROXY_PENDING_ACTIVATION_LEASE_MS);
  expect(await settlementFailure).toMatchObject({ code: 'continuity_commit_operation_released' });
  supervisor.controlActivated(1);
  time.tick(1);
  await pushed.promise;
  response.resolve({ kind: 'ack', committedThroughProviderSeq: 1 });
  await flushMicrotasks();
  expect(supervisor.ledger().get(operation)).toMatchObject({
    state: 'releasing',
    committedThroughProviderSeq: 0,
    bufferedEvents: [{ providerSeq: 1 }],
  });
});
