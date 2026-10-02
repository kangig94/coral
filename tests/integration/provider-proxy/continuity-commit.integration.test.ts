import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import { operationPrepareAttemptKey, operationActivationFingerprint } from '#src/provider-proxy/ledger.js';
import {
  proxyOperationPrepareResultSchema,
  type OperationIdentity,
  type ProxyPreparedAppServerOperation,
  type Reservation,
} from '#src/provider-proxy/protocol.js';
import type { HostRef } from '#src/providers/contract.js';
import { attachContinuityCommit } from '#src/providers/internal/continuity-commit.js';
import { PROXY_PENDING_ACTIVATION_LEASE_MS } from '#src/provider-proxy/ledger.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import {
  asJointActivationReceipt,
  asJointContainmentReceipt,
  asReservation,
} from '#tests/helpers/provider-proxy-correlation.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';

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

const supervisors: OperationSupervisor[] = [];
afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.close();
});

async function preparedOperation(
  pushProviderEvent: ConstructorParameters<typeof OperationSupervisor>[0]['pushProviderEvent'],
) {
  const operation: OperationIdentity = {
    jobId: randomUUID(),
    operationId: randomUUID(),
    proxyInstanceId: randomUUID(),
    buildSetId: randomUUID(),
  };
  const time = new VirtualTime();
  const start = vi.fn(() => ({
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
  }));
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
    prepared: PREPARED,
  });
  const prepared = proxyOperationPrepareResultSchema.parse(
    await supervisor.prepare(operation, { prepareAttemptNumber: 1, prepareAttemptKey, prepared: PREPARED }),
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
  const timer = new VirtualTime();
  const startEntered = createDeferred<void>();
  const startResult = createDeferred<{ kind: 'started'; hostRef: HostRef }>();
  const releaseGate = createDeferred<void>();
  const pushed = createDeferred<void>();
  const response = createDeferred<unknown>();
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
      cwd: fixtureCanonicalWorkDir('/workspace'),
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
    nowMs: () => timer.now(),
    proxyInstanceId: operation.proxyInstanceId,
    buildSetId: operation.buildSetId,
    stageProviderRoot: () => ({
      result: Promise.resolve({
        state: 'staged' as const,
        providerRoot: { pid: 4_242, incarnation: testIncarnation(1_700_000_000) },
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
  supervisors.push(supervisor);
  const request = {
    operation,
    hostFingerprint: 'a'.repeat(64),
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

  timer.tick(PROXY_PENDING_ACTIVATION_LEASE_MS);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await settlementFailure).toMatchObject({ code: 'continuity_commit_operation_released' });
  expect(supervisor.ledger().get(operation)).toMatchObject({
    state: 'releasing',
    committedThroughProviderSeq: 0,
    bufferedEvents: [{ providerSeq: 1 }],
  });

  supervisor.controlActivated(1);
  timer.tick(1);
  await pushed.promise;
  response.resolve({ kind: 'ack', committedThroughProviderSeq: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));

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
