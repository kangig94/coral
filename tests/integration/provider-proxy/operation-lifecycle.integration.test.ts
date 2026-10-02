import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import { ControlEndpointError } from '#src/provider-proxy/control-endpoint.js';
import { operationPrepareAttemptKey, operationActivationFingerprint } from '#src/provider-proxy/ledger.js';
import {
  proxyOperationPrepareResultSchema,
  type OperationIdentity,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';
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

it('starts the provider exactly once when an activation reply is lost and retried', async () => {
  const { supervisor, operation, start, activate } = await preparedOperation(() => ({
    controlEpoch: 1,
    response: new Promise<never>(() => {}),
  }));
  const lostReply = activate().then(() => {
    throw new Error('activation reply lost');
  });
  await expect(lostReply).rejects.toThrow('activation reply lost');
  await expect(activate()).resolves.toMatchObject({ state: 'executing' });
  expect(start).toHaveBeenCalledOnce();
  expect(supervisor.ledger().get(operation)?.state).toBe('started-awaiting-publication');
});

it('replays a buffered event when successor control attaches', async () => {
  const firstAck = createDeferred<unknown>();
  const firstPush = createDeferred<void>();
  const successorPush = createDeferred<void>();
  const successorAck = createDeferred<unknown>();
  const received: unknown[] = [];
  let controlEpoch = 1;
  const { supervisor, operation, time, activate } = await preparedOperation((frame) => {
    received.push(frame);
    if (controlEpoch === 1) {
      firstPush.resolve();
      return { controlEpoch, response: firstAck.promise };
    }
    successorPush.resolve();
    return { controlEpoch, response: successorAck.promise };
  });
  await activate();
  await supervisor.attach(operation, 0);
  supervisor.emitProviderEvent(operation, { kind: 'progress', message: 'held event' });
  time.tick(1);
  await firstPush.promise;
  firstAck.reject(new ControlEndpointError('control_endpoint_push_lost', 'predecessor socket closed'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(supervisor.ledger().get(operation)?.bufferedEvents).toHaveLength(1);

  controlEpoch = 2;
  supervisor.controlActivated(controlEpoch);
  await expect(supervisor.attach(operation, 0)).resolves.toMatchObject({ replayFromProviderSeq: 1 });
  time.tick(1);
  await successorPush.promise;
  expect(received).toHaveLength(2);
  expect(received[1]).toEqual(received[0]);
  successorAck.resolve({ kind: 'ack', committedThroughProviderSeq: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(supervisor.ledger().get(operation)).toMatchObject({ committedThroughProviderSeq: 1, bufferedEvents: [] });
});
