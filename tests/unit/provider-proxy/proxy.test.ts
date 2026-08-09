import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { HostRef } from '#src/providers/contract.js';
import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import { connectControlClient, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import { SemanticOperationCancellationTimeoutError } from '#src/provider-proxy/semantic-operation-runner.js';
import {
  OperationSupervisor,
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
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  proxyOperationActivationOutcomeSchema,
  proxyOperationAttachParamsSchema,
  proxyOperationAttachResultSchema,
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
    stageProviderRoot?: (signal: AbortSignal) => Promise<OperationStageResult>;
    stageAbortAndRelease?: () => Promise<void>;
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
      stageProviderRoot: (key, reserved) => {
        const abortController = new AbortController();
        const result = (
          options.stageProviderRoot ??
          (async () => ({
            state: 'staged' as const,
            providerRoot: { pid: 7_000, processStartedAtSeconds: 900 },
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

describe('provider-proxy proxy: prepare result sender validation', () => {
  it('rejects a supervisor result missing a required wire field before returning it', async () => {
    const prepare = vi.spyOn(OperationSupervisor.prototype, 'prepare').mockResolvedValueOnce({
      state: 'pending-activation',
      reservation: '40000000-0000-4000-8000-000000000001',
      leaseExpiresInMs: 15_000,
      jointContainmentReceipt: 'contained',
    });
    try {
      const { control, operation } = await startProxy(fakeHost());

      await expect(
        control.call(
          'operation.prepare.v1',
          { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED },
          5_000,
        ),
      ).rejects.toThrow(/providerRoot/u);
    } finally {
      prepare.mockRestore();
    }
  });

  it('publishes a prepare refusal only after its staged containment is released', async () => {
    const release = deferred();
    const refusal = {
      state: 'permanent-refusal',
      code: 'provider_creation_refused',
      disposition: 'local-fallback',
      reason: 'The provider root could not be created.',
    } as const;
    const { control, operation, proxy } = await startProxy(fakeHost(), timer, {
      stageProviderRoot: async () => refusal,
      stageAbortAndRelease: () => release.promise,
    });
    const request = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(request);
    const preparing = control.call('operation.prepare.v1', request, 5_000);
    const prepareSettled = vi.fn();
    void preparing.then(prepareSettled, prepareSettled);

    await vi.waitFor(() => expect(proxy.ledger().get(operation)?.state).toBe('releasing'));
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toMatchObject({
      state: 'releasing',
      releaseKind: 'never-started',
    });
    expect(prepareSettled).not.toHaveBeenCalled();

    release.resolve();
    await expect(preparing).resolves.toEqual(refusal);
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toEqual(
      refusal,
    );
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

    const first = proxyOperationActivationOutcomeSchema.parse(
      await control.call('operation.activate.v1', activation, 5_000),
    );
    const replay = await control.call('operation.activate.v1', activation, 5_000);
    const awaitingPublication = await control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000);
    await control.call('operation.attach.v1', { operation, committedThroughProviderSeq: 0 }, 5_000);
    const attached = await control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000);

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

  it('retains a rejected start as a typed activation-indeterminate receipt', async () => {
    const host = fakeHost();
    host.start = function start(): SemanticOperationStartHandle {
      this.starts += 1;
      return startHandle(Promise.reject(new Error('start rejected')));
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
      releaseKind: 'activation-indeterminate',
      activationAck: null,
    });

    release.resolve();
    const receipt = {
      state: 'released-activation-indeterminate',
      operation,
      prepareAttemptNumber: 1,
      prepareAttemptKey,
    };
    await expect(activating).resolves.toEqual(receipt);
    await expect(control.call('operation.activate.v1', activation, 5_000)).resolves.toEqual(receipt);
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toEqual(
      receipt,
    );
    expect(proxy.ledger().get(operation)).toBeNull();
    expect(host.starts).toBe(1);
  });

  it('keeps the activation deadline armed while the host start is unresolved', async () => {
    const controlled = controlledTimer();
    const host = fakeHost();
    const startResult = deferred<Awaited<SemanticOperationStartHandle['result']>>();
    const startAborted = vi.fn(() => {
      startResult.resolve({ kind: 'never-started', reason: 'deadline aborted start' });
      return Promise.resolve();
    });
    host.start = function start(): SemanticOperationStartHandle {
      this.starts += 1;
      return startHandle(startResult.promise, startAborted);
    };
    const { control, operation, proxy } = await startProxy(host, controlled.timer, {
      readMilliseconds: controlled.readMilliseconds,
    });
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
    const activationTimedOut = expect(activating).rejects.toThrow(/exceeded its 5000ms budget/u);

    controlled.advance(PROXY_PENDING_ACTIVATION_LEASE_MS);

    await activationTimedOut;
    await vi.waitFor(() => expect(startAborted).toHaveBeenCalled());
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toMatchObject({
      state: 'released-never-started',
    });
  });

  it('buffers a terminal through activation and delivers it only after strict attachment', async () => {
    const inspectRequestParses = vi.spyOn(proxyOperationInspectParamsSchema, 'parse');
    const inspectResultParses = vi.spyOn(proxyOperationInspectResultSchema, 'parse');
    const attachRequestParses = vi.spyOn(proxyOperationAttachParamsSchema, 'parse');
    const attachResultParses = vi.spyOn(proxyOperationAttachResultSchema, 'parse');
    const host = fakeHost();
    const started = deferred<HostRef>();
    host.start = function start(): SemanticOperationStartHandle {
      this.starts += 1;
      return startHandle(started.promise.then((hostRef) => ({ kind: 'started' as const, hostRef })));
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

    proxy.emitProviderEvent(operation, {
      kind: 'terminal',
      terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' } },
      diagnostics: {},
    });
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
    expect(proxy.ledger().get(operation)?.state).toBe('started-awaiting-publication');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(received).toEqual([]);

    const attachRequest = proxyOperationAttachParamsSchema.parse({ operation, committedThroughProviderSeq: 0 });
    const attached = proxyOperationAttachResultSchema.parse(
      await control.call('operation.attach.v1', attachRequest, 5_000),
    );

    expect(attached).toEqual({ state: 'attached', replayFromProviderSeq: 1 });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ providerSeq: 1, event: { kind: 'terminal' } });
    expect(proxy.ledger().get(operation)?.state).toBe('terminal-awaiting-settlement');
    expect(attachRequestParses).toHaveBeenCalledTimes(2);
    expect(attachResultParses).toHaveBeenCalledTimes(3);
  });

  it('commits each encoded provider frame synchronously before another emission can begin', async () => {
    const { control, operation, proxy } = await startProxy(fakeHost());
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
    await control.call('operation.attach.v1', { operation, committedThroughProviderSeq: 0 }, 5_000);

    const emissions = [
      proxy.emitProviderEvent(operation, { kind: 'progress', message: 'first' }),
      proxy.emitProviderEvent(operation, { kind: 'progress', message: 'second' }),
    ].map((emission) => Promise.resolve(emission).catch(() => undefined));

    expect(proxy.ledger().get(operation)?.bufferedEvents).toHaveLength(2);
    await Promise.all(emissions);
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

  it('aborts unresolved staging as soon as its activation lease expires', async () => {
    const controlled = controlledTimer();
    const staging = deferred<{
      state: 'staged';
      providerRoot: { pid: number; processStartedAtSeconds: number };
      receipt: JointContainmentReceipt;
    }>();
    const stageAborted = vi.fn();
    const host = fakeHost();
    const { control, operation, proxy } = await startProxy(host, controlled.timer, {
      readMilliseconds: controlled.readMilliseconds,
      stageProviderRoot: (signal) => {
        signal.addEventListener('abort', stageAborted, { once: true });
        return staging.promise;
      },
    });
    const prepareRequest = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    const preparing = control.call('operation.prepare.v1', prepareRequest, 5_000);
    await vi.waitFor(() => expect(proxy.ledger().get(operation)?.state).toBe('preparing'));

    controlled.advance(PROXY_PENDING_ACTIVATION_LEASE_MS);

    await vi.waitFor(() => expect(stageAborted).toHaveBeenCalledOnce());
    expect(proxy.ledger().get(operation)?.state).toBe('releasing');
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toMatchObject({
      state: 'releasing',
      releaseKind: 'never-started',
    });

    staging.resolve({
      state: 'staged',
      providerRoot: { pid: 7_000, processStartedAtSeconds: 900 },
      receipt: asJointContainmentReceipt('joint-late'),
    });
    await expect(preparing).rejects.toThrow(/lease expired/u);
    await vi.waitFor(() => expect(proxy.ledger().get(operation)).toBeNull());
  });

  it('turns a late staging completion into release instead of publishing prepared', async () => {
    const staging = deferred<{
      state: 'staged';
      providerRoot: { pid: number; processStartedAtSeconds: number };
      receipt: JointContainmentReceipt;
    }>();
    const host = fakeHost();
    const { control, operation, proxy } = await startProxy(host, timer, {
      stageProviderRoot: () => staging.promise,
    });
    const prepareRequest = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    const preparing = control.call('operation.prepare.v1', prepareRequest, 5_000);
    await vi.waitFor(() => expect(proxy.ledger().get(operation)?.state).toBe('preparing'));
    const cancelling = control.call(
      'operation.cancel.v2',
      { operation, prepareAttemptNumber: 1, prepareAttemptKey },
      5_000,
    );
    await vi.waitFor(() => expect(proxy.ledger().get(operation)?.state).toBe('releasing'));

    staging.resolve({
      state: 'staged',
      providerRoot: { pid: 7_000, processStartedAtSeconds: 900 },
      receipt: asJointContainmentReceipt('joint-late'),
    });

    await expect(preparing).rejects.toThrow(/lease expired/u);
    const receipt = await cancelling;
    expect(receipt).toMatchObject({ state: 'released-never-started' });
    expect(host.released).toContainEqual({ jobId: operation.jobId, operationId: operation.operationId });
    expect(proxy.ledger().get(operation)).toBeNull();
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toEqual(
      receipt,
    );
  });

  it('retains a failed guardian release and retries it from the releasing state', async () => {
    const controlled = controlledTimer();
    const releaseMembership = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('guardian unavailable'))
      .mockResolvedValue(undefined);
    const host = fakeHost();
    const { control, operation, proxy } = await startProxy(host, controlled.timer, {
      readMilliseconds: controlled.readMilliseconds,
      releaseMembership,
    });
    const prepareRequest = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    await control.call('operation.prepare.v1', prepareRequest, 5_000);

    controlled.advance(PROXY_PENDING_ACTIVATION_LEASE_MS);

    await vi.waitFor(() => expect(releaseMembership).toHaveBeenCalledTimes(1));
    expect(proxy.ledger().get(operation)?.state).toBe('releasing');

    controlled.advance(OPERATION_RELEASE_RETRY_MS);

    await vi.waitFor(() => expect(releaseMembership).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(proxy.ledger().get(operation)).toBeNull());
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toMatchObject({
      state: 'released-never-started',
    });
  });

  it('retries a semantic cancellation timeout and releases the same staged attempt', async () => {
    const controlled = controlledTimer();
    const stageAbortAndRelease = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new SemanticOperationCancellationTimeoutError())
      .mockResolvedValue(undefined);
    const { control, operation, proxy } = await startProxy(fakeHost(), controlled.timer, {
      readMilliseconds: controlled.readMilliseconds,
      stageAbortAndRelease,
    });
    const prepareRequest = { operation, hostFingerprint: FINGERPRINT, prepareAttemptNumber: 1, prepared: PREPARED };
    const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
    await control.call('operation.prepare.v1', prepareRequest, 5_000);

    await expect(
      control.call('operation.cancel.v2', { operation, prepareAttemptNumber: 1, prepareAttemptKey }, 5_000),
    ).rejects.toThrow('Provider operation cancellation did not settle within 10000ms.');
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toMatchObject({
      state: 'releasing',
      releaseKind: 'never-started',
    });

    controlled.advance(OPERATION_RELEASE_RETRY_MS);

    await vi.waitFor(() => expect(stageAbortAndRelease).toHaveBeenCalledTimes(2));
    await expect(control.call('operation.inspect.v2', { operation, prepareAttemptKey }, 5_000)).resolves.toMatchObject({
      state: 'released-never-started',
    });
    expect(proxy.ledger().get(operation)).toBeNull();
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
      state: 'staged';
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
      state: 'staged',
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
    host.start = function start(): SemanticOperationStartHandle {
      this.starts += 1;
      return startHandle(started.promise.then((hostRef) => ({ kind: 'started' as const, hostRef })));
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
    expect(proxy.ledger().get(operation)?.state).toBe('started-awaiting-publication');
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
    await control.call('operation.attach.v1', { operation, committedThroughProviderSeq: 0 }, 5_000);
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
