import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { HostRef } from '#src/providers/contract.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import { connectControlClient, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createProxy, type SemanticOperationHost } from '#src/provider-proxy/proxy.js';
import {
  PROXY_PENDING_ACTIVATION_LEASE_MS,
  operationActivationFingerprint,
  operationPrepareAttemptKey,
  type ProviderOperationKey,
} from '#src/provider-proxy/ledger.js';
import type { ProxyBootstrapCapsule } from '#src/provider-proxy/bootstrap-capsule.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  proxyOperationCancelParamsSchema,
  proxyOperationCancelResultSchema,
  proxyOperationInspectParamsSchema,
  proxyOperationInspectResultSchema,
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

/**
 * `proxy.ts`'s own control endpoint, driven over a real Unix socket with a fake `SemanticOperationHost` and a
 * fake `containment` (no real app-server child, no real guardian). Keeping the serializer races here makes
 * them deterministic without weakening the broader lifecycle coverage over a real control connection.
 */

const timer: ControlEndpointTimer = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
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
    cwd: '/tmp',
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
      return hostRefFor(key.jobId);
    },
    stop() {
      this.stops += 1;
    },
    releaseStaged(key) {
      released.push(key);
    },
    releaseSettled(key) {
      settled.push(key);
    },
  };
}

/** Records every `setTimeout` call the endpoint's own per-request budget timer makes, tagged with `ms`, while
 *  still actually scheduling it — so a request that is genuinely meant to time out still does. */
function recordingTimer(): { timer: ControlEndpointTimer; budgets: number[] } {
  const budgets: number[] = [];
  return {
    budgets,
    timer: {
      setTimeout: (callback: () => void, ms: number) => {
        budgets.push(ms);
        return setTimeout(callback, ms);
      },
      clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as unknown as NodeJS.Timeout),
    },
  };
}

function controlledTimer(): {
  timer: ControlEndpointTimer;
  readMilliseconds: () => bigint;
  advance(ms: number): void;
} {
  let elapsedMs = 0;
  let nextId = 0;
  type Handle = { id: number; dueAtMs: number; callback: () => void; unref(): void };
  const pending = new Map<number, Handle>();
  return {
    readMilliseconds: () => BigInt(elapsedMs),
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
    stageProviderRoot?: () => Promise<{
      providerRoot: { pid: number; processStartedAtSeconds: number };
      receipt: JointContainmentReceipt;
    }>;
    confirmActivation?: () => Promise<void>;
    releaseMembership?: (input: Readonly<{ key: ProviderOperationKey; reservation: Reservation }>) => Promise<void>;
    wallClockNow?: () => number;
  } = {},
): Promise<{ control: ControlClient; operation: PreparedOperation; proxy: ReturnType<typeof createProxy> }> {
  const directory = mkdtempSync(join(tmpdir(), 'coral-proxy-test-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
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
    processStartedAtSeconds: 800,
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
      // No real guardian: a fixed root/receipt is all `operation.prepare.v1` needs to stage.
      stageProviderRoot:
        options.stageProviderRoot ??
        (async () => ({
          providerRoot: { pid: 7_000, processStartedAtSeconds: 900 },
          receipt: asJointContainmentReceipt('joint-1'),
        })),
      confirmActivation: options.confirmActivation ?? (async () => {}),
      releaseMembership: options.releaseMembership ?? (async () => {}),
    },
  });
  await proxy.listen();
  cleanups.push(() => proxy.close());

  const control = await connectControlClient(endpoint, timer, 5_000, options.onProviderEvent);
  cleanups.push(() => control.close());
  const coordinatorIdentity = {
    instanceId: randomUUID(),
    pid: 1,
    processStartedAtSeconds: 1,
    generation: 'gen2' as const,
    flavor: 'prod' as const,
    buildSetId,
  };
  const opened = (await control.call(
    'control.open.v1',
    { bootstrapNonce: NONCE, coordinator: coordinatorIdentity },
    5_000,
  )) as { controlEpoch: number; heartbeatChallenge: string };
  // Control is not "active" (able to call mutation methods) until the first heartbeat is echoed back.
  await control.call(
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
  return { control, operation, proxy };
}

describe('provider-proxy proxy: staged-but-never-executed release (BLOCKING B4)', () => {
  it('releases a staged provider root when operation.stop.v1 stops before activation', async () => {
    const host = fakeHost();
    const { control, operation } = await startProxy(host);

    const prepared = (await control.call(
      'operation.prepare.v1',
      { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
      5_000,
    )) as { state: string };
    expect(prepared.state).toBe('pending-activation');

    const stopped = (await control.call('operation.stop.v1', { operation, cause: 'signal_abort' }, 5_000)) as {
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
    const prepared = (await control.call('operation.prepare.v1', prepareRequest, 5_000)) as {
      reservation: Reservation;
      jointContainmentReceipt: JointContainmentReceipt;
    };
    const activation = {
      operation,
      reservation: prepared.reservation,
      jointContainmentReceipt: prepared.jointContainmentReceipt,
      jointActivationReceipt: asJointActivationReceipt('activation-1'),
    };

    const first = await control.call('operation.activate.v1', activation, 5_000);
    const replay = await control.call('operation.activate.v1', activation, 5_000);
    const inspected = await control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000);

    expect(first).toEqual({
      state: 'executing',
      activationFingerprint: operationActivationFingerprint(activation),
      startedAt: new Date(STARTED_AT_MS).toISOString(),
      hostRef: hostRefFor(operation.jobId),
      committedThroughProviderSeq: 0,
    });
    expect(replay).toEqual(first);
    expect(inspected).toEqual(first);
    expect(host.starts).toBe(1);
  });

  it('keeps a rejected start in release and never makes it activatable again', async () => {
    const host = fakeHost();
    host.start = function start(): never {
      this.starts += 1;
      throw new Error('start rejected');
    };
    const release = deferred();
    const { control, operation, proxy } = await startProxy(host, timer, {
      releaseMembership: () => release.promise,
    });
    const prepareRequest = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    const prepared = (await control.call('operation.prepare.v1', prepareRequest, 5_000)) as {
      reservation: Reservation;
      jointContainmentReceipt: JointContainmentReceipt;
    };
    const activation = {
      operation,
      reservation: prepared.reservation,
      jointContainmentReceipt: prepared.jointContainmentReceipt,
      jointActivationReceipt: asJointActivationReceipt('activation-1'),
    };

    const activating = control.call('operation.activate.v1', activation, 5_000);
    await vi.waitFor(() => expect(proxy.ledger().get(operation)?.state).toBe('releasing'));
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toMatchObject({
      state: 'releasing',
      activationAck: null,
    });

    release.resolve();
    await expect(activating).rejects.toThrow(/start rejected/u);
    await expect(control.call('operation.activate.v1', activation, 5_000)).rejects.toThrow(/No such prepared/u);
    expect(proxy.ledger().get(operation)).toBeNull();
    expect(host.starts).toBe(1);
  });

  it('inspects starting immediately and buffers provider events until the ACK exists', async () => {
    const inspectRequestParses = vi.spyOn(proxyOperationInspectParamsSchema, 'parse');
    const inspectResultParses = vi.spyOn(proxyOperationInspectResultSchema, 'parse');
    const host = fakeHost();
    const started = deferred<HostRef>();
    host.start = function start(): Promise<HostRef> {
      this.starts += 1;
      return started.promise;
    };
    let wallClockMs = STARTED_AT_MS;
    const received: unknown[] = [];
    const { control, operation, proxy } = await startProxy(host, timer, {
      onProviderEvent: (request) => {
        received.push(request);
        return { kind: 'ack', committedThroughProviderSeq: request.providerSeq };
      },
      wallClockNow: () => wallClockMs,
    });
    const prepareRequest = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    const prepared = (await control.call('operation.prepare.v1', prepareRequest, 5_000)) as {
      reservation: Reservation;
      jointContainmentReceipt: JointContainmentReceipt;
    };
    const activation = {
      operation,
      reservation: prepared.reservation,
      jointContainmentReceipt: prepared.jointContainmentReceipt,
      jointActivationReceipt: asJointActivationReceipt('activation-1'),
    };
    const activating = control.call('operation.activate.v1', activation, 5_000);
    await vi.waitFor(() => expect(proxy.ledger().get(operation)?.state).toBe('starting'));

    proxy.emitProviderEvent(operation, { kind: 'progress', message: 'buffered' });
    const inspectRequest = proxyOperationInspectParamsSchema.parse({ operation, prepareAttemptKey });
    const inspectResult = proxyOperationInspectResultSchema.parse(
      await control.call('operation.inspect.v2', inspectRequest, 5_000),
    );
    expect(inspectResult).toMatchObject({ state: 'starting' });
    expect(inspectRequestParses).toHaveBeenCalledTimes(2);
    expect(inspectResultParses).toHaveBeenCalledTimes(2);
    expect(received).toEqual([]);

    wallClockMs += 1_000;
    started.resolve(hostRefFor(operation.jobId));
    await expect(activating).resolves.toEqual({
      state: 'executing',
      activationFingerprint: operationActivationFingerprint(activation),
      startedAt: new Date(wallClockMs).toISOString(),
      hostRef: hostRefFor(operation.jobId),
      committedThroughProviderSeq: 0,
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
  });

  it('actively releases an expired lease without another RPC', async () => {
    const controlled = controlledTimer();
    const releaseMembership = vi.fn(async () => {});
    const host = fakeHost();
    const { control, operation, proxy } = await startProxy(host, controlled.timer, {
      readMilliseconds: controlled.readMilliseconds,
      releaseMembership,
    });
    await control.call(
      'operation.prepare.v1',
      { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
      5_000,
    );

    controlled.advance(PROXY_PENDING_ACTIVATION_LEASE_MS);

    await vi.waitFor(() => expect(proxy.ledger().get(operation)).toBeNull());
    expect(host.released).toEqual([{ jobId: operation.jobId, operationId: operation.operationId }]);
    expect(releaseMembership).toHaveBeenCalledOnce();
  });

  it('fences an attempt that never entered preparation and refuses its delayed prepare', async () => {
    const cancelParamsParses = vi.spyOn(proxyOperationCancelParamsSchema, 'parse');
    const cancelResultParses = vi.spyOn(proxyOperationCancelResultSchema, 'parse');
    const releaseMembership = vi.fn(async () => {});
    const host = fakeHost();
    const { control, operation } = await startProxy(host, timer, { releaseMembership });
    const prepareRequest = {
      operation,
      hostFingerprint: FINGERPRINT,
      prepareAttemptNumber: 1,
      prepared: PREPARED,
    };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    const cancelRequest = proxyOperationCancelParamsSchema.parse({
      operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey,
    });

    const cancelled = proxyOperationCancelResultSchema.parse(
      await control.call('operation.cancel.v2', cancelRequest, 5_000),
    );

    expect(cancelled).toEqual({
      state: 'released-never-started',
      operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey,
    });
    await expect(control.call('operation.prepare.v1', prepareRequest, 5_000)).rejects.toThrow(/attempt is fenced/u);
    expect(host.released).toEqual([]);
    expect(releaseMembership).not.toHaveBeenCalled();
    expect(cancelParamsParses).toHaveBeenCalledTimes(2);
    expect(cancelResultParses).toHaveBeenCalledTimes(2);
  });

  it('refuses a delayed lower prepare after a higher absent attempt was fenced', async () => {
    const host = fakeHost();
    const { control, operation } = await startProxy(host);
    const higherPrepare = {
      operation,
      hostFingerprint: FINGERPRINT,
      prepareAttemptNumber: 2,
      prepared: PREPARED,
    };
    const higherAttemptKey = operationPrepareAttemptKey(higherPrepare);
    await control.call(
      'operation.cancel.v2',
      { operation, prepareAttemptNumber: 2, prepareAttemptKey: higherAttemptKey },
      5_000,
    );

    await expect(
      control.call(
        'operation.prepare.v1',
        { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
        5_000,
      ),
    ).rejects.toThrow(/delayed lower prepare attempt/u);
    expect(host.starts).toBe(0);
  });

  it('accepts a higher prepare only after the previous attempt is fenced and released', async () => {
    const host = fakeHost();
    const { control, operation } = await startProxy(host);
    const firstRequest = {
      operation,
      hostFingerprint: FINGERPRINT,
      prepareAttemptNumber: 1,
      prepared: PREPARED,
    };
    const firstAttemptKey = operationPrepareAttemptKey(firstRequest);
    await control.call('operation.prepare.v1', firstRequest, 5_000);
    const secondRequest = { ...firstRequest, prepareAttemptNumber: 2 };

    await expect(control.call('operation.prepare.v1', secondRequest, 5_000)).rejects.toThrow(
      /previous prepare attempt is not fenced/u,
    );
    await control.call(
      'operation.cancel.v2',
      { operation, prepareAttemptNumber: 1, prepareAttemptKey: firstAttemptKey },
      5_000,
    );

    await expect(control.call('operation.prepare.v1', secondRequest, 5_000)).resolves.toMatchObject({
      state: 'pending-activation',
    });
    expect(host.released).toEqual([{ jobId: operation.jobId, operationId: operation.operationId }]);
  });

  it('joins cancellation to in-flight staging before certifying never-started', async () => {
    const staging = deferred<{
      providerRoot: { pid: number; processStartedAtSeconds: number };
      receipt: JointContainmentReceipt;
    }>();
    const membershipRelease = deferred();
    const releaseMembership = vi.fn(() => membershipRelease.promise);
    const host = fakeHost();
    const { control, operation, proxy } = await startProxy(host, timer, {
      stageProviderRoot: () => staging.promise,
      releaseMembership,
    });
    const prepareRequest = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    const preparing = control.call('operation.prepare.v1', prepareRequest, 5_000);
    await vi.waitFor(() => expect(proxy.ledger().get(operation)?.state).toBe('preparing'));
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toMatchObject({
      state: 'preparing',
    });
    const cancelling = control.call(
      'operation.cancel.v2',
      { operation, prepareAttemptNumber: 1, prepareAttemptKey },
      5_000,
    );
    const cancellationSettled = vi.fn();
    void cancelling.then(cancellationSettled, cancellationSettled);
    await vi.waitFor(() => expect(proxy.ledger().get(operation)?.state).toBe('releasing'));
    expect(cancellationSettled).not.toHaveBeenCalled();

    staging.resolve({
      providerRoot: { pid: 7_000, processStartedAtSeconds: 900 },
      receipt: asJointContainmentReceipt('joint-1'),
    });

    await expect(preparing).rejects.toThrow(/lease expired/u);
    await vi.waitFor(() => {
      expect(host.released).toHaveLength(1);
      expect(releaseMembership).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(cancellationSettled).not.toHaveBeenCalled();

    membershipRelease.resolve();
    await expect(cancelling).resolves.toEqual({
      state: 'released-never-started',
      operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey,
    });
    expect(cancellationSettled).toHaveBeenCalledOnce();
    expect(host.starts).toBe(0);
  });

  it('joins cancellation to an in-flight start and refuses never-started proof after the ACK', async () => {
    const host = fakeHost();
    const started = deferred<HostRef>();
    host.start = function start(): Promise<HostRef> {
      this.starts += 1;
      return started.promise;
    };
    const { control, operation, proxy } = await startProxy(host);
    const prepareRequest = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    const prepared = (await control.call('operation.prepare.v1', prepareRequest, 5_000)) as {
      reservation: Reservation;
      jointContainmentReceipt: JointContainmentReceipt;
    };
    const activating = control.call(
      'operation.activate.v1',
      {
        operation,
        reservation: prepared.reservation,
        jointContainmentReceipt: prepared.jointContainmentReceipt,
        jointActivationReceipt: asJointActivationReceipt('activation-1'),
      },
      5_000,
    );
    await vi.waitFor(() => expect(proxy.ledger().get(operation)?.state).toBe('starting'));
    const cancelling = control.call(
      'operation.cancel.v2',
      { operation, prepareAttemptNumber: 1, prepareAttemptKey },
      5_000,
    );

    started.resolve(hostRefFor(operation.jobId));

    await expect(activating).resolves.toMatchObject({ state: 'executing' });
    await expect(cancelling).rejects.toThrow(/Activation has begun/u);
    expect(proxy.ledger().get(operation)?.state).toBe('executing');
    expect(host.released).toEqual([]);
  });

  it('settles cumulatively and releases proxy-local and guardian membership state once', async () => {
    const settleRequestParses = vi.spyOn(proxyOperationSettleParamsSchema, 'parse');
    const settleResultParses = vi.spyOn(proxyOperationSettleResultSchema, 'parse');
    const releaseMembership = vi.fn(async () => {});
    const host = fakeHost();
    const { control, operation, proxy } = await startProxy(host, timer, { releaseMembership });
    const prepared = (await control.call(
      'operation.prepare.v1',
      { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
      5_000,
    )) as { reservation: Reservation; jointContainmentReceipt: JointContainmentReceipt };
    await control.call(
      'operation.activate.v1',
      {
        operation,
        reservation: prepared.reservation,
        jointContainmentReceipt: prepared.jointContainmentReceipt,
        jointActivationReceipt: asJointActivationReceipt('activation-1'),
      },
      5_000,
    );
    proxy.emitProviderEvent(operation, { kind: 'progress', message: 'final' });
    await control.call('operation.stop.v1', { operation, cause: 'signal_abort' }, 5_000);

    const settleRequest = proxyOperationSettleParamsSchema.parse({ operation, finalProviderSeq: 1 });
    const settled = proxyOperationSettleResultSchema.parse(
      await control.call('operation.settle.v2', settleRequest, 5_000),
    );
    expect(settled).toEqual({ state: 'released-after-terminal', settledThroughProviderSeq: 1 });
    const replayRequest = proxyOperationSettleParamsSchema.parse({ operation, finalProviderSeq: 0 });
    const replay = proxyOperationSettleResultSchema.parse(
      await control.call('operation.settle.v2', replayRequest, 5_000),
    );
    expect(replay).toEqual({ state: 'released-after-terminal', settledThroughProviderSeq: 1 });
    expect(proxy.ledger().get(operation)).toBeNull();
    expect(host.settled).toEqual([{ jobId: operation.jobId, operationId: operation.operationId }]);
    expect(releaseMembership).toHaveBeenCalledOnce();
    expect(settleRequestParses).toHaveBeenCalledTimes(4);
    expect(settleResultParses).toHaveBeenCalledTimes(4);
  });
});

describe('provider-proxy proxy: operation.prepare.v1 budget (BLOCKING B5)', () => {
  it('never arms the endpoint’s own default per-request budget timer for operation.prepare.v1', async () => {
    const host = fakeHost();
    const recording = recordingTimer();
    const { control, operation } = await startProxy(host, recording.timer);

    // Sanity: `control.open.v1` and `control.heartbeat.v1` are both ordinary, no-declared-`budgetMs` calls
    // `startProxy` already made above, so the endpoint's default budget timer fires twice before this test
    // ever reaches `operation.prepare.v1` — proving the recorder is wired to the real mechanism that method
    // must not trip.
    const budgetsBeforePrepare = [...recording.budgets];
    expect(budgetsBeforePrepare).toEqual([PROXY_CONTROL_RPC_TIMEOUT_MS, PROXY_CONTROL_RPC_TIMEOUT_MS]);

    await control.call(
      'operation.prepare.v1',
      { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
      5_000,
    );

    expect(recording.budgets.slice(budgetsBeforePrepare.length)).toEqual([PROXY_PENDING_ACTIVATION_LEASE_MS]);
  });
});
