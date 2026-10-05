import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { HostRef } from '#src/providers/contract.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { attachContinuityCommit } from '#src/providers/internal/continuity-commit.js';
import { ControlEndpointError, type ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import { operationPrepareAttemptKey } from '#src/provider-proxy/ledger.js';
import {
  OPERATION_RELEASE_RETRY_MS,
  OperationSupervisor,
  type OperationStageHandle,
  type OperationStageResult,
  type ProviderEventControlFault,
  type SemanticOperationHost,
} from '#src/provider-proxy/operation-supervisor.js';
import { PROXY_EVENT_COMMIT_TIMEOUT_MS, type OperationIdentity } from '#src/provider-proxy/protocol.js';
import type { ProxyPreparedAppServerOperation } from '#src/provider-proxy/protocol.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';

const PREPARED: ProxyPreparedAppServerOperation = {
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function controlledTimer(): {
  timer: ControlEndpointTimer;
  nowMs(): number;
  runNext(): boolean;
  advance(ms: number): void;
  pendingCount(): number;
} {
  let elapsedMs = 0;
  let nextId = 0;
  type Handle = { id: number; dueAtMs: number; callback: () => void; unref(): void };
  const pending = new Map<number, Handle>();
  const nextDue = (): Handle | undefined =>
    [...pending.values()].sort((left, right) => left.dueAtMs - right.dueAtMs || left.id - right.id)[0];
  return {
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
      clearTimeout: (rawHandle) => pending.delete((rawHandle as Handle).id),
    },
    nowMs: () => elapsedMs,
    runNext: () => {
      const due = nextDue();
      if (due === undefined || due.dueAtMs > elapsedMs) return false;
      pending.delete(due.id);
      due.callback();
      return true;
    },
    advance: (ms) => {
      elapsedMs += ms;
      while (true) {
        const due = nextDue();
        if (due === undefined || due.dueAtMs > elapsedMs) return;
        pending.delete(due.id);
        due.callback();
      }
    },
    pendingCount: () => pending.size,
  };
}

function hostRef(): HostRef {
  return {
    provider: 'codex',
    fingerprint: 'a'.repeat(64),
    instanceId: 'host-1',
    leaseMode: 'shared',
  };
}

async function executingSupervisor(
  pushProviderEvent: ConstructorParameters<typeof OperationSupervisor>[0]['pushProviderEvent'],
  publish = true,
): Promise<{
  supervisor: OperationSupervisor;
  operation: OperationIdentity;
  faults: ProviderEventControlFault[];
  clock: ReturnType<typeof controlledTimer>;
  stop: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  prepareAttemptKey: string;
}> {
  const operation: OperationIdentity = {
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: randomUUID(),
    buildSetId: randomUUID(),
  };
  const clock = controlledTimer();
  const faults: ProviderEventControlFault[] = [];
  const stop = vi.fn(async () => {});
  const release = vi.fn(async () => {});
  const host: SemanticOperationHost = {
    start: () => ({
      result: Promise.resolve({ kind: 'started', hostRef: hostRef() }),
      abortAndRelease: release,
    }),
    stop,
  };
  const receipt = asJointContainmentReceipt('containment');
  const stage: OperationStageHandle = {
    result: Promise.resolve({
      state: 'staged',
      providerRoot: { pid: 4_242, incarnation: testIncarnation(1_700_000_000) },
      receipt,
    }),
    confirmActivation: async () => {},
    abortAndRelease: async () => {},
  };
  const supervisor = new OperationSupervisor({
    host,
    timer: clock.timer,
    mintReservation: () => asReservation('40000000-0000-4000-8000-000000000001'),
    wallClockNow: () => 0,
    nowMs: clock.nowMs,
    proxyInstanceId: operation.proxyInstanceId,
    buildSetId: operation.buildSetId,
    stageProviderRoot: () => stage,
    pushProviderEvent,
    faultProviderEventControl: (fault) => faults.push(fault),
  });
  const prepareRequest = {
    operation,
    hostFingerprint: 'a'.repeat(64),
    prepareAttemptNumber: 1,
    prepared: PREPARED,
  };
  const prepareAttemptKey = operationPrepareAttemptKey(prepareRequest);
  const prepared = (await supervisor.prepare(operation, {
    prepareAttemptNumber: 1,
    prepareAttemptKey,
    prepared: PREPARED,
  })) as { reservation: string; jointContainmentReceipt: string };
  await supervisor.activate(operation, {
    reservation: asReservation(prepared.reservation),
    jointContainmentReceipt: asJointContainmentReceipt(prepared.jointContainmentReceipt),
    jointActivationReceipt: asJointActivationReceipt('activation'),
    activationFingerprint: prepareAttemptKey,
  });
  if (publish) await supervisor.attach(operation, 0);
  return { supervisor, operation, faults, clock, stop, release, prepareAttemptKey };
}

function preExecutionReleaseFixture(abortAndRelease: OperationStageHandle['abortAndRelease']): Readonly<{
  supervisor: OperationSupervisor;
  operation: OperationIdentity;
  prepareAttemptKey: string;
  staging: ReturnType<typeof deferred<OperationStageResult>>;
  stageAbort: ReturnType<typeof vi.fn<OperationStageHandle['abortAndRelease']>>;
  clock: ReturnType<typeof controlledTimer>;
}> {
  const operation: OperationIdentity = {
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: randomUUID(),
    buildSetId: randomUUID(),
  };
  const clock = controlledTimer();
  const staging = deferred<OperationStageResult>();
  const stageAbort = vi.fn(abortAndRelease);
  const stage: OperationStageHandle = {
    result: staging.promise,
    confirmActivation: async () => {},
    abortAndRelease: stageAbort,
  };
  const host: SemanticOperationHost = {
    start: () => {
      throw new Error('pre-execution fixture must not start the host');
    },
    stop: async () => {},
  };
  const supervisor = new OperationSupervisor({
    host,
    timer: clock.timer,
    mintReservation: () => asReservation('40000000-0000-4000-8000-000000000001'),
    wallClockNow: () => 0,
    nowMs: clock.nowMs,
    proxyInstanceId: operation.proxyInstanceId,
    buildSetId: operation.buildSetId,
    stageProviderRoot: () => stage,
    pushProviderEvent: () => ({
      controlEpoch: 1,
      response: Promise.resolve({ kind: 'ack', committedThroughProviderSeq: 0 }),
    }),
    faultProviderEventControl: () => {},
  });
  const prepareAttemptKey = operationPrepareAttemptKey({
    operation,
    hostFingerprint: 'a'.repeat(64),
    prepareAttemptNumber: 1,
    prepared: PREPARED,
  });
  return { supervisor, operation, prepareAttemptKey, staging, stageAbort, clock };
}

async function beginBlockedPreparation(
  fixture: ReturnType<typeof preExecutionReleaseFixture>,
): Promise<Readonly<{ preparing: Promise<unknown> }>> {
  const preparing = fixture.supervisor.prepare(fixture.operation, {
    prepareAttemptNumber: 1,
    prepareAttemptKey: fixture.prepareAttemptKey,
    prepared: PREPARED,
  });
  await vi.waitFor(() => expect(fixture.supervisor.ledger().get(fixture.operation)?.state).toBe('preparing'));
  return { preparing };
}

function completeStaging(fixture: ReturnType<typeof preExecutionReleaseFixture>): void {
  fixture.staging.resolve({
    state: 'staged',
    providerRoot: { pid: 4_242, incarnation: testIncarnation(1_700_000_000) },
    receipt: asJointContainmentReceipt('late-containment'),
  });
}

describe('operation supervisor release progress', () => {
  it('drives pre-execution release before a blocked operation tail can resume', async () => {
    const ownedAbort = deferred<void>();
    const fixture = preExecutionReleaseFixture(() => ownedAbort.promise);
    const { preparing } = await beginBlockedPreparation(fixture);
    const prepareSettled = vi.fn();
    void preparing.then(prepareSettled, prepareSettled);

    const stopping = fixture.supervisor.stop(fixture.operation, 'signal_abort');
    const stopSettled = vi.fn();
    void stopping.then(stopSettled, stopSettled);
    await vi.waitFor(() => expect(fixture.stageAbort).toHaveBeenCalledOnce());
    expect(fixture.supervisor.ledger().get(fixture.operation)?.state).toBe('releasing');

    ownedAbort.resolve(undefined);

    await vi.waitFor(async () => {
      const inspection = (await fixture.supervisor.inspect(fixture.operation, fixture.prepareAttemptKey)) as {
        state: string;
      };
      expect({
        ledgerState: fixture.supervisor.ledger().get(fixture.operation)?.state ?? 'absent',
        inspectionState: inspection.state,
      }).toEqual({ ledgerState: 'absent', inspectionState: 'released-never-started' });
    });
    expect(prepareSettled).not.toHaveBeenCalled();
    expect(stopSettled).not.toHaveBeenCalled();

    completeStaging(fixture);
    await expect(preparing).rejects.toThrow();
    await expect(stopping).resolves.toMatchObject({ state: 'released' });
  });

  it('retries an independently driven release failure without inspection', async () => {
    const fixture = preExecutionReleaseFixture(
      vi
        .fn<OperationStageHandle['abortAndRelease']>()
        .mockRejectedValueOnce(new Error('first release failed'))
        .mockResolvedValue(undefined),
    );
    const { preparing } = await beginBlockedPreparation(fixture);
    const stopping = fixture.supervisor.stop(fixture.operation, 'signal_abort');
    await vi.waitFor(() => expect(fixture.stageAbort).toHaveBeenCalledOnce());
    await new Promise((resolve) => setImmediate(resolve));

    fixture.clock.advance(OPERATION_RELEASE_RETRY_MS);

    await vi.waitFor(() => expect(fixture.stageAbort).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fixture.supervisor.ledger().get(fixture.operation)).toBeNull());
    await expect(fixture.supervisor.cancel(fixture.operation, 1, fixture.prepareAttemptKey)).resolves.toMatchObject({
      state: 'released-never-started',
    });

    completeStaging(fixture);
    await expect(preparing).rejects.toThrow();
    await expect(stopping).resolves.toMatchObject({ state: 'released' });
  });
});

describe('provider-event supervisor pump', () => {
  it('retains a control-activation wake while the old push is in flight', async () => {
    const first = deferred<unknown>();
    let pushCalls = 0;
    const fixture = await executingSupervisor(() => {
      pushCalls += 1;
      return {
        controlEpoch: 1,
        response: pushCalls === 1 ? first.promise : Promise.resolve({ kind: 'ack', committedThroughProviderSeq: 1 }),
      };
    });

    fixture.supervisor.emitProviderEvent(fixture.operation, { kind: 'progress', message: 'held' });
    expect(pushCalls).toBe(0);
    expect(fixture.clock.runNext()).toBe(true);
    expect(pushCalls).toBe(1);

    fixture.supervisor.controlActivated(1);
    first.reject(
      new ControlEndpointError('control_endpoint_push_lost', 'The stale socket closed before its ACK arrived.'),
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.clock.runNext()).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pushCalls).toBe(2);
    expect(fixture.supervisor.ledger().get(fixture.operation)?.committedThroughProviderSeq).toBe(1);
    expect(fixture.supervisor.ledger().get(fixture.operation)?.bufferedEvents).toEqual([]);
  });

  it('faults control after one unanswered ACK budget while retaining the frame', async () => {
    const held = deferred<unknown>();
    const fixture = await executingSupervisor(() => ({ controlEpoch: 7, response: held.promise }));

    fixture.supervisor.emitProviderEvent(fixture.operation, { kind: 'progress', message: 'ambiguous' });
    expect(fixture.clock.runNext()).toBe(true);
    fixture.clock.advance(PROXY_EVENT_COMMIT_TIMEOUT_MS);

    expect(fixture.faults).toEqual([
      {
        reason: 'provider_event_ack_timeout',
        operation: fixture.operation,
        providerSeq: 1,
        expectedControlEpoch: 7,
      },
    ]);
    expect(fixture.supervisor.ledger().get(fixture.operation)?.bufferedEvents).toHaveLength(1);
    expect(fixture.supervisor.ledger().get(fixture.operation)?.committedThroughProviderSeq).toBe(0);
  });

  it('commits the original continuity object only after the cumulative ACK', async () => {
    const held = deferred<unknown>();
    const commit = vi.fn();
    const reject = vi.fn();
    const fixture = await executingSupervisor(() => ({ controlEpoch: 1, response: held.promise }));
    const event = attachContinuityCommit(
      {
        kind: 'continuity',
        conversationRef: 'thread-1',
        resumable: true,
        providerContinuity: { provider: 'codex', state: { threadId: 'thread-1' } },
      },
      { commit, reject },
    );

    const emission = fixture.supervisor.emitProviderEvent(fixture.operation, event);
    if (emission.kind !== 'continuity-recorded') throw new Error('expected a continuity settlement');
    expect(fixture.clock.runNext()).toBe(true);
    expect(commit).not.toHaveBeenCalled();

    held.resolve({ kind: 'ack', committedThroughProviderSeq: 1 });
    await emission.settlement.committed;

    expect(commit).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
    expect(fixture.supervisor.ledger().get(fixture.operation)?.committedThroughProviderSeq).toBe(1);
  });
});

it.each(['stop', 'cancel'] as const)('ends an unpublished start through %s and releases the host', async (method) => {
  const fixture = await executingSupervisor(
    () => ({
      controlEpoch: 1,
      response: Promise.resolve({ kind: 'ack', committedThroughProviderSeq: 0 }),
    }),
    false,
  );
  try {
    await expect(fixture.supervisor.inspect(fixture.operation, fixture.prepareAttemptKey)).resolves.toMatchObject({
      state: 'started-awaiting-publication',
    });
    if (method === 'stop') {
      await expect(fixture.supervisor.stop(fixture.operation, 'signal_abort')).resolves.toMatchObject({
        state: 'released',
      });
    } else {
      await expect(fixture.supervisor.cancel(fixture.operation, 1, fixture.prepareAttemptKey)).rejects.toThrow(
        'unpublished start was stopped',
      );
    }
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
    await expect(fixture.supervisor.inspect(fixture.operation, fixture.prepareAttemptKey)).resolves.toMatchObject({
      state: 'released-activation-indeterminate',
    });
  } finally {
    fixture.supervisor.close();
  }
});
