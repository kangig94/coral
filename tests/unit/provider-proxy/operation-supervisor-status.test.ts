import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { ControlEndpointTimer } from '#src/provider-proxy/control-endpoint.js';
import { operationPrepareAttemptKey } from '#src/provider-proxy/ledger.js';
import { OperationSupervisor } from '#src/provider-proxy/operation-supervisor.js';
import {
  jointContainmentReceiptSchema,
  reservationSchema,
  type OperationIdentity,
  type ProxyPreparedAppServerOperation,
} from '#src/provider-proxy/protocol.js';

const PREPARED: ProxyPreparedAppServerOperation = {
  version: 1,
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'observe the operation',
    cwd: '/project',
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
};

const inertTimer: ControlEndpointTimer = {
  setTimeout: () => ({}),
  clearTimeout: () => {},
};

describe('OperationSupervisor.status', () => {
  it('reports held for the live-ledger case and absent for a missing operation', async () => {
    const operation: OperationIdentity = {
      jobId: randomUUID(),
      operationId: randomUUID(),
      proxyInstanceId: randomUUID(),
      buildSetId: randomUUID(),
    };
    const missing: OperationIdentity = {
      ...operation,
      jobId: randomUUID(),
      operationId: randomUUID(),
    };
    const supervisor = new OperationSupervisor({
      host: {
        start: () => {
          throw new Error('status fixture must not start the provider');
        },
        stop: async () => {},
      },
      timer: inertTimer,
      mintReservation: () => reservationSchema.parse(randomUUID()),
      wallClockNow: () => 0,
      nowMs: () => 0,
      proxyInstanceId: operation.proxyInstanceId,
      buildSetId: operation.buildSetId,
      stageProviderRoot: () => ({
        result: Promise.resolve({
          state: 'staged',
          providerRoot: { pid: 4_242, processStartedAtSeconds: 1_700_000_000 },
          receipt: jointContainmentReceiptSchema.parse('live-ledger-containment'),
        }),
        confirmActivation: async () => {},
        abortAndRelease: async () => {},
      }),
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

    await supervisor.prepare(operation, { prepareAttemptNumber: 1, prepareAttemptKey, prepared: PREPARED });
    expect(supervisor.ledger().get(operation)).not.toBeNull();

    expect(supervisor.status([operation, missing])).toEqual([
      { operation, state: 'held' },
      { operation: missing, state: 'absent' },
    ]);
  });
});
