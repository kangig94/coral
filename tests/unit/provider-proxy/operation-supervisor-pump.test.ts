import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { HostRef } from '#src/providers/contract.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { attachContinuityCommit } from '#src/providers/internal/continuity-commit.js';
import { ControlEndpointError, type ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import {
  MAX_PROVIDER_REPLAY_BYTES,
  MAX_PROVIDER_REPLAY_EVENTS,
  operationPrepareAttemptKey,
} from '#src/provider-proxy/ledger.js';
import {
  OPERATION_RELEASE_RETRY_MS,
  OperationSupervisor,
  type OperationStageHandle,
  type OperationStageResult,
  type ProviderEventControlFault,
  type SemanticOperationHost,
} from '#src/provider-proxy/operation-supervisor.js';
import {
  PROXY_EVENT_COMMIT_TIMEOUT_MS,
  providerEventRequestSchema,
  type OperationIdentity,
  type ProxyOperationSendResult,
} from '#src/provider-proxy/protocol.js';
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
  admitSend?: SemanticOperationHost['admitSend'],
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
    admitSend,
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

it('refuses a send before publication without calling runner admission', async () => {
  const admitSend = vi.fn(() => ({
    state: 'refused' as const,
    code: 'turn_ended' as const,
    reason: 'Unexpected admission',
  }));
  const h = await executingSupervisor(
    () => {
      throw new Error('Unexpected event');
    },
    false,
    admitSend,
  );
  try {
    await expect(
      h.supervisor.send(h.operation, {
        text: 'Change direction',
        clientMessageId: '33333333-3333-4333-8333-333333333333',
      }),
    ).resolves.toMatchObject({ state: 'refused', code: 'turn_not_started' });
    expect(admitSend).not.toHaveBeenCalled();
    expect(h.supervisor.ledger().get(h.operation)?.bufferedEvents).toEqual([]);
  } finally {
    h.supervisor.close();
  }
});

it('starts an admitted send synchronously and lets stop finish while its write is pending', async () => {
  const answer = deferred<{ state: 'unknown'; reason: string }>();
  const write = vi.fn(() => answer.promise);
  const admitSend = vi.fn(() => ({ state: 'admitted' as const, refuse: vi.fn(), write }));
  const h = await executingSupervisor(
    () => {
      throw new Error('Unexpected event');
    },
    true,
    admitSend,
  );
  const input = { text: 'Change direction', clientMessageId: '33333333-3333-4333-8333-333333333333' };
  try {
    const pending = h.supervisor.send(h.operation, input);
    expect(admitSend).toHaveBeenCalledExactlyOnceWith({
      key: {
        jobId: h.operation.jobId,
        operationId: h.operation.operationId,
      },
      input,
    });
    expect(write).toHaveBeenCalledTimes(1);
    const stopping = h.supervisor.stop(h.operation, 'user_abort');
    await expect(h.supervisor.send(h.operation, input)).resolves.toMatchObject({
      state: 'refused',
      code: 'turn_ended',
    });
    await stopping;
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(admitSend).toHaveBeenCalledTimes(1);
    answer.resolve({ state: 'unknown', reason: 'Host closed during send' });
    await expect(pending).resolves.toMatchObject({ state: 'unknown' });
  } finally {
    h.supervisor.close();
  }
});

it('refuses a send after terminal and permits settlement while an earlier send is pending', async () => {
  const answer = deferred<{ state: 'unknown'; reason: string }>();
  const write = vi.fn(() => answer.promise);
  const admitSend = vi.fn(() => ({ state: 'admitted' as const, refuse: vi.fn(), write }));
  const h = await executingSupervisor(
    () => {
      throw new Error('Unexpected event');
    },
    true,
    admitSend,
  );
  const emit = vi.spyOn(h.supervisor, 'emitProviderEvent');
  const input = { text: 'Change direction', clientMessageId: '33333333-3333-4333-8333-333333333333' };
  try {
    const pending = h.supervisor.send(h.operation, input);
    const emitted = h.supervisor.emitProviderEvent(h.operation, {
      kind: 'terminal',
      terminal: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
      diagnostics: {},
    });
    if (emitted.kind !== 'recorded') throw new Error('Expected terminal record');
    await expect(h.supervisor.send(h.operation, input)).resolves.toMatchObject({
      state: 'refused',
      code: 'turn_ended',
    });
    await h.supervisor.attach(h.operation, emitted.providerSeq);
    await expect(h.supervisor.settle(h.operation, emitted.providerSeq)).resolves.toMatchObject({
      state: 'released-after-terminal',
    });
    expect(h.release).toHaveBeenCalledTimes(1);
    await expect(h.supervisor.send(h.operation, input)).resolves.toMatchObject({
      state: 'refused',
      code: 'turn_ended',
    });
    expect(admitSend).toHaveBeenCalledTimes(1);
    answer.resolve({ state: 'unknown', reason: 'Released host' });
    await expect(pending).resolves.toMatchObject({ state: 'unknown' });
    expect(emit).toHaveBeenCalledTimes(2);
  } finally {
    emit.mockRestore();
    h.supervisor.close();
  }
});

it.each(['stop', 'terminal'] as const)('refuses without a send record when %s wins admission', async (winner) => {
  const write = vi.fn(async () => ({ state: 'delivered' as const, providerTurnId: 'turn-current' }));
  const admitSend = vi.fn(() => ({ state: 'admitted' as const, refuse: vi.fn(), write }));
  const h = await executingSupervisor(
    () => {
      throw new Error('Unexpected push');
    },
    true,
    admitSend,
  );
  try {
    if (winner === 'stop') {
      await h.supervisor.stop(h.operation, 'user_abort');
    } else {
      h.supervisor.emitProviderEvent(h.operation, {
        kind: 'terminal',
        terminal: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
        diagnostics: {},
      });
    }
    const before = h.supervisor.ledger().get(h.operation)?.bufferedEvents;
    await expect(
      h.supervisor.send(h.operation, { text: 'Change direction', clientMessageId: randomUUID() }),
    ).resolves.toMatchObject({
      state: 'refused',
      code: 'turn_ended',
    });
    expect(h.supervisor.ledger().get(h.operation)?.bufferedEvents).toEqual(before);
    expect(admitSend).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  } finally {
    h.supervisor.close();
  }
});

it('records the send synchronously before the write and an immediate completion, then settles the final sequence', async () => {
  const input = { text: 'Change direction', clientMessageId: '33333333-3333-4333-8333-333333333333' };
  const write = vi.fn(async () => ({ state: 'delivered' as const, providerTurnId: 'turn-current' }));
  const h = await executingSupervisor(
    () => {
      throw new Error('Unexpected push before the controlled clock advances');
    },
    true,
    () => ({ state: 'admitted', refuse: vi.fn(), write }),
  );
  write.mockImplementation(async () => {
    const buffered = h.supervisor.ledger().get(h.operation)?.bufferedEvents ?? [];
    expect(buffered).toHaveLength(1);
    const record = providerEventRequestSchema.parse((JSON.parse(buffered[0]!.frame) as { params: unknown }).params);
    expect(record).toMatchObject({
      operation: h.operation,
      providerSeq: 1,
      event: {
        kind: 'progress',
        message: `Sending message ${input.clientMessageId} (jobs send): Change direction. This line does not prove delivery.`,
      },
    });
    expect(
      h.supervisor.emitProviderEvent(h.operation, {
        kind: 'terminal',
        terminal: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
        diagnostics: {},
      }),
    ).toEqual({ kind: 'recorded', providerSeq: 2 });
    return { state: 'delivered', providerTurnId: 'turn-current' };
  });
  try {
    const pending = h.supervisor.send(h.operation, input);
    expect(write).toHaveBeenCalledOnce();
    expect(
      h.supervisor
        .ledger()
        .get(h.operation)
        ?.bufferedEvents.map(({ providerSeq }) => providerSeq),
    ).toEqual([1, 2]);
    await expect(pending).resolves.toEqual({ state: 'delivered', providerTurnId: 'turn-current' });
    expect(h.supervisor.ledger().nextProviderSeq(h.operation)).toBe(3);
    await h.supervisor.attach(h.operation, 2);
    await expect(h.supervisor.settle(h.operation, 2)).resolves.toMatchObject({
      state: 'released-after-terminal',
      settledThroughProviderSeq: 2,
    });
  } finally {
    h.supervisor.close();
  }
});

it.each(['delivered', 'unknown', 'refused'] as const)(
  'refuses a duplicate message id during the write and after its %s outcome without a second record',
  async (state) => {
    const input = { text: 'Change direction', clientMessageId: randomUUID() };
    const answer = deferred<ProxyOperationSendResult>();
    const write = vi.fn(() => answer.promise);
    const admitSend = vi.fn(() => ({ state: 'admitted' as const, refuse: vi.fn(), write }));
    const h = await executingSupervisor(
      () => {
        throw new Error('Unexpected push');
      },
      true,
      admitSend,
    );
    const refusal = {
      state: 'refused',
      code: 'control_unavailable',
      reason: `Message id ${input.clientMessageId} already has a send record. This repeat was not written; inspect progress for the original send.`,
    };
    try {
      const pending = h.supervisor.send(h.operation, input);
      const repeated = h.supervisor.send(h.operation, input);
      expect(write).toHaveBeenCalledOnce();
      expect(h.supervisor.ledger().nextProviderSeq(h.operation)).toBe(2);
      await expect(repeated).resolves.toEqual(refusal);
      const outcome =
        state === 'delivered'
          ? { state, providerTurnId: 'turn-current' }
          : state === 'refused'
            ? { state, code: 'turn_ended' as const, reason: 'Turn ended before the write.' }
            : { state, reason: 'Reply lost.' };
      answer.resolve(outcome);
      await expect(pending).resolves.toEqual(outcome);
      await h.supervisor.attach(h.operation, 1);
      await expect(h.supervisor.send(h.operation, input)).resolves.toEqual(refusal);
      expect(admitSend).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      expect(h.supervisor.ledger().nextProviderSeq(h.operation)).toBe(2);
    } finally {
      h.supervisor.close();
    }
  },
);

it('keeps the send record after a write-time refusal without claiming delivery', async () => {
  const outcome = { state: 'refused', code: 'turn_ended', reason: 'Provider turn ended before the write.' } as const;
  const write = vi.fn(async () => outcome);
  const h = await executingSupervisor(
    () => {
      throw new Error('Unexpected push');
    },
    true,
    () => ({ state: 'admitted', refuse: vi.fn(), write }),
  );
  const clientMessageId = '33333333-3333-4333-8333-333333333333';
  try {
    await expect(h.supervisor.send(h.operation, { text: 'Change direction', clientMessageId })).resolves.toEqual(
      outcome,
    );
    const buffered = h.supervisor.ledger().get(h.operation)?.bufferedEvents ?? [];
    expect(buffered).toHaveLength(1);
    expect(
      providerEventRequestSchema.parse((JSON.parse(buffered[0]!.frame) as { params: unknown }).params),
    ).toMatchObject({
      providerSeq: 1,
      event: { kind: 'progress', message: expect.stringContaining(`Sending message ${clientMessageId}`) },
    });
    expect(buffered[0]!.frame).toContain('This line does not prove delivery.');
    expect(write).toHaveBeenCalledOnce();
  } finally {
    h.supervisor.close();
  }
});

it.each(['events', 'bytes'] as const)(
  'refuses an exhausted replay %s budget without writing or emitting an emergency terminal',
  async (budget) => {
    const refuse = vi.fn();
    const write = vi.fn(async () => ({ state: 'delivered' as const, providerTurnId: 'turn-current' }));
    const h = await executingSupervisor(
      () => {
        throw new Error('Unexpected push');
      },
      true,
      () => ({ state: 'admitted', refuse, write }),
    );
    try {
      const ledger = h.supervisor.ledger();
      if (budget === 'events') {
        for (let providerSeq = 1; providerSeq <= MAX_PROVIDER_REPLAY_EVENTS; providerSeq += 1) {
          ledger.recordEvent(h.operation, { providerSeq, frame: 'x' }, { kind: 'ordinary' });
        }
      } else {
        ledger.recordEvent(
          h.operation,
          { providerSeq: 1, frame: 'x'.repeat(MAX_PROVIDER_REPLAY_BYTES - 1) },
          { kind: 'ordinary' },
        );
      }
      const before = ledger.get(h.operation);
      const emit = vi.spyOn(h.supervisor, 'emitProviderEvent');
      const outcome = await h.supervisor.send(h.operation, {
        text: 'Change direction',
        clientMessageId: '33333333-3333-4333-8333-333333333333',
      });
      expect(outcome).toMatchObject({ state: 'refused', code: 'control_unavailable' });
      expect(refuse).toHaveBeenCalledExactlyOnceWith(outcome);
      expect(write).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(ledger.get(h.operation)).toEqual(before);
      expect(ledger.get(h.operation)).toMatchObject({ state: 'executing', completionRecorded: false });
    } finally {
      h.supervisor.close();
    }
  },
);

it('does not write unless record emission returns recorded', async () => {
  const refuse = vi.fn();
  const write = vi.fn(async () => ({ state: 'delivered' as const, providerTurnId: 'turn-current' }));
  const h = await executingSupervisor(
    () => {
      throw new Error('Unexpected push');
    },
    true,
    () => ({ state: 'admitted', refuse, write }),
  );
  const emit = vi.spyOn(h.supervisor, 'emitProviderEvent').mockReturnValue({ kind: 'proxy-emergency-terminal' });
  try {
    const outcome = await h.supervisor.send(h.operation, {
      text: 'Change direction',
      clientMessageId: '33333333-3333-4333-8333-333333333333',
    });
    expect(outcome).toMatchObject({ state: 'refused', code: 'control_unavailable' });
    expect(refuse).toHaveBeenCalledExactlyOnceWith(outcome);
    expect(write).not.toHaveBeenCalled();
  } finally {
    emit.mockRestore();
    h.supervisor.close();
  }
});

it('bounds and flattens the send preview before recording it', async () => {
  const h = await executingSupervisor(
    () => {
      throw new Error('Unexpected push');
    },
    true,
    () => ({
      state: 'admitted',
      refuse: vi.fn(),
      write: async () => ({ state: 'delivered', providerTurnId: 'turn-current' }),
    }),
  );
  try {
    await h.supervisor.send(h.operation, { text: '\n' + '界'.repeat(300), clientMessageId: randomUUID() });
    const buffered = h.supervisor.ledger().get(h.operation)?.bufferedEvents ?? [];
    expect(buffered).toHaveLength(1);
    const { event } = providerEventRequestSchema.parse((JSON.parse(buffered[0]!.frame) as { params: unknown }).params);
    expect(event).toMatchObject({ kind: 'progress', message: expect.stringContaining('界'.repeat(239) + '…') });
    if (event.kind !== 'progress') throw new Error('Expected send progress');
    expect(event.message).not.toContain('\n');
    expect(Buffer.byteLength(buffered[0]!.frame, 'utf8')).toBeLessThan(2_000);
  } finally {
    h.supervisor.close();
  }
});
