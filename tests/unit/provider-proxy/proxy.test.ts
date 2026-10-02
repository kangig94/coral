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

import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { strictControlExchangeResult as strictTestExchange } from '#tests/support/control-exchange.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createHash, randomUUID } from 'node:crypto';
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
  proxyOperationSettleParamsSchema,
  proxyOperationSettleResultSchema,
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

describe('provider-proxy proxy: staged-but-never-executed release (BLOCKING B4)', () => {
  it('releases a staged provider root when operation.stop.v1 stops before activation', async () => {
    const host = fakeHost();
    const { control, operation } = await startProxy(host);

    const prepared = (await strictTestExchange(
      control,
      'operation.prepare.v1',
      { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
      5_000,
    )) as { state: string };
    expect(prepared.state).toBe('pending-activation');

    const stopped = (await strictTestExchange(
      control,
      'operation.stop.v1',
      { operation, cause: 'signal_abort' },
      5_000,
    )) as {
      state: string;
    };

    expect(stopped.state).toBe('released');
    expect(host.starts).toBe(0);
    expect(host.stops).toBe(0);
    expect(host.released).toEqual([{ jobId: operation.jobId, operationId: operation.operationId }]);
  });
});

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

  it('aborts unresolved staging as soon as its activation lease expires', async () => {
    const controlled = controlledTimer();
    const staging = deferred<{
      state: 'staged';
      providerRoot: { pid: number; incarnation: ProcessIncarnation };
      receipt: JointContainmentReceipt;
    }>();
    const stageStarted = deferred();
    const stageAbort = deferred();
    const stageAborted = vi.fn(() => {
      stageAbort.resolve();
    });
    const host = fakeHost();
    const { control, operation, proxy } = await startProxy(host, controlled.timer, {
      readMilliseconds: controlled.readMilliseconds,
      stageProviderRoot: (signal) => {
        stageStarted.resolve();
        signal.addEventListener('abort', stageAborted, { once: true });
        return staging.promise;
      },
    });
    const prepareRequest = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    const preparing = strictTestExchange(control, 'operation.prepare.v1', prepareRequest, 5_000);
    await stageStarted.promise;

    controlled.advance(PROXY_PENDING_ACTIVATION_LEASE_MS);

    await stageAbort.promise;
    expect(stageAborted).toHaveBeenCalledOnce();
    expect(proxy.ledger().get(operation)?.state).toBe('releasing');
    await expect(
      strictTestExchange(control, 'operation.inspect.v1', { operation, prepareAttemptKey }, 5_000),
    ).resolves.toMatchObject({
      state: 'releasing',
      releaseKind: 'never-started',
    });

    staging.resolve({
      state: 'staged',
      providerRoot: { pid: 7_000, incarnation: testIncarnation(900) },
      receipt: asJointContainmentReceipt('joint-late'),
    });
    await expect(preparing).rejects.toThrow(/lease expired/u);
    await expect(
      strictTestExchange(control, 'operation.inspect.v1', { operation, prepareAttemptKey }, 5000),
    ).resolves.toMatchObject({ state: 'released-never-started' });
    expect(proxy.ledger().get(operation)).toBeNull();
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

  it('settles cumulatively and releases proxy-local and guardian membership state once', async () => {
    const releaseMembership = vi.fn(async () => {});
    const host = fakeHost();
    const { control, operation, proxy } = await startProxy(host, timer, {
      releaseMembership,
      onProviderEvent: (request) => ({ kind: 'ack', committedThroughProviderSeq: request.providerSeq }),
    });
    const prepared = (await strictTestExchange(
      control,
      'operation.prepare.v1',
      { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
      5_000,
    )) as { reservation: Reservation; jointContainmentReceipt: JointContainmentReceipt };
    await strictTestExchange(
      control,
      'operation.activate.v1',
      {
        operation,
        reservation: prepared.reservation,
        jointContainmentReceipt: prepared.jointContainmentReceipt,
        jointActivationReceipt: asJointActivationReceipt('activation-1'),
      },
      5_000,
    );
    await strictTestExchange(control, 'operation.attach.v1', { operation, committedThroughProviderSeq: 0 }, 5_000);
    proxy.emitProviderEvent(operation, { kind: 'progress', message: 'final' });
    await strictTestExchange(control, 'operation.stop.v1', { operation, cause: 'signal_abort' }, 5_000);

    const settleRequest = proxyOperationSettleParamsSchema.parse({ operation, finalProviderSeq: 1 });
    const settled = proxyOperationSettleResultSchema.parse(
      await strictTestExchange(control, 'operation.settle.v1', settleRequest, 5_000),
    );
    expect(settled).toEqual({ state: 'released-after-terminal', settledThroughProviderSeq: 1 });
    const replayRequest = proxyOperationSettleParamsSchema.parse({ operation, finalProviderSeq: 0 });
    const replay = proxyOperationSettleResultSchema.parse(
      await strictTestExchange(control, 'operation.settle.v1', replayRequest, 5_000),
    );
    expect(replay).toEqual({ state: 'released-after-terminal', settledThroughProviderSeq: 1 });
    expect(proxy.ledger().get(operation)).toBeNull();
    expect(host.settled).toEqual([{ jobId: operation.jobId, operationId: operation.operationId }]);
    expect(releaseMembership).toHaveBeenCalledOnce();
  });
});

describe('provider-proxy proxy: controller succession', () => {
  const SECRET = 'd'.repeat(64);

  async function installRecoveryGrant(
    control: ControlClient,
    capsule: ProxyBootstrapCapsule,
  ): Promise<Readonly<{ grantId: string; set: Record<string, string> }>> {
    const grantId = randomUUID();
    const set = {
      generation: capsule.generation,
      hostFingerprint: capsule.hostFingerprint,
      buildSetId: capsule.buildSetId,
      proxyInstanceId: capsule.proxyInstanceId,
    };
    await strictTestExchange(
      control,
      'handoff.install.v1',
      {
        grantId,
        secretSha256: createHash('sha256').update(SECRET, 'utf8').digest('hex'),
        ...set,
        operations: [],
        orphanTimeoutMs: 30_000,
      },
      5_000,
    );
    return { grantId, set };
  }

  function successorOf(buildSetId: string) {
    return {
      instanceId: randomUUID(),
      pid: 2,
      incarnation: testIncarnation(2),
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId,
    };
  }

  async function redeem(
    endpoint: string,
    grantId: string,
    set: Record<string, string>,
    successor: ReturnType<typeof successorOf>,
  ): Promise<unknown> {
    const client = await connectControlClient(endpoint, timer, 5_000);
    cleanups.push(() => client.close());
    return strictTestExchange(client, 'handoff.redeem.v1', { grantId, secret: SECRET, successor, ...set }, 5_000);
  }
  it('redeems a cross-build grant only for the successor the controller authorized', async () => {
    const { control, capsule } = await startProxy(fakeHost());
    const { grantId, set } = await installRecoveryGrant(control, capsule);
    const successorBuild = { generation: 'gen2' as const, flavor: 'prod' as const, buildSetId: randomUUID() };
    await strictTestExchange(
      control,
      'controller-transfer.v1',
      {
        grantId,
        attemptId: 'attempt-1',
        successor: successorBuild,
        controlGeneration: 1,
      },
      5000,
    );
    control.close();
    await expect(redeem(capsule.canonicalEndpoint, grantId, set, successorOf(randomUUID()))).rejects.toThrow(
      /build this grant does not authorize/u,
    );
    await expect(
      redeem(capsule.canonicalEndpoint, grantId, set, successorOf(successorBuild.buildSetId)),
    ).resolves.toMatchObject({ state: 'redeemed-provisional' });
  });
});
