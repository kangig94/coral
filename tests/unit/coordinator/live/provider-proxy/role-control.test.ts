import { ProviderProxySetInheritanceCorruptionError } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  establishRoleControl,
  ProviderProxyRoleControlUnavailableError,
} from '#src/coordinator/live/provider-proxy/role-control.js';
import { connectRoleControlWithRetry } from '#src/provider-proxy/role-spawn.js';
import {
  ControlClientError,
  controlExchangeForTest,
  type ControlClient,
  type ControlExchange,
} from '#src/provider-proxy/control-client.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { runtimeControlTimer } from '#src/provider-proxy/role-spawn.js';

vi.mock('#src/provider-proxy/role-spawn.js', async (original) => ({
  ...(await original<object>()),
  connectRoleControlWithRetry: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

const openedResult = { controlEpoch: 1, heartbeatChallenge: 'a'.repeat(64) };
const plan = {
  role: 'guardian',
  endpoint: '/tmp/unused.sock',
  openMethod: 'guardian.handoff-redeem.v1',
  heartbeatMethod: 'guardian.heartbeat.v1',
  openParams: {},
  openParamsSchema: z.object({}),
  openResultSchema: z.object({ controlEpoch: z.number(), heartbeatChallenge: z.string() }),
  identity: () => ({}),
  expectedIdentity: {},
} as const;
function establish(
  exchanges: (ControlExchange | Promise<ControlExchange>)[],
  faulted: ControlClient['faulted'] = new Promise(() => {}),
) {
  const client: ControlClient = {
    exchange: vi.fn(async () => exchanges.shift()!),
    faulted,
    onFault: () => () => {},
    close: vi.fn(),
  };
  vi.mocked(connectRoleControlWithRetry).mockResolvedValue(client);
  return establishRoleControl(
    [],
    runtimeControlTimer(createRealRuntime('prod')),
    { connectTimeoutMs: 1, retryIntervalMs: 1, overallDeadlineMs: 1, monotonicNow: () => 0n, sleep: async () => {} },
    plan,
  );
}

it.each(['open', 'first-heartbeat'] as const)(
  'classifies EPIPE at %s with its provenance and no global fatal',
  async (stage) => {
    for (const kind of ['delivery-unconfirmed', 'not-sent'] as const) {
      const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      const failure =
        kind === 'delivery-unconfirmed'
          ? controlExchangeForTest({ kind, cause: 'socket-error-after-write', error })
          : controlExchangeForTest({ kind, cause: 'write-threw', error });
      const exchanges =
        stage === 'open'
          ? [failure]
          : [controlExchangeForTest({ kind: 'response', response: { kind: 'result', value: openedResult } }), failure];
      const result = establish(exchanges);
      await expect(result).rejects.toBeInstanceOf(ProviderProxyRoleControlUnavailableError);
      const unavailable = await result.catch((e: unknown) => e);
      expect(unavailable).toMatchObject({
        cause: error,
        incident: { kind: stage === 'open' ? 'role-open-indeterminate' : 'role-heartbeat-indeterminate' },
      });
      const fatal = vi.fn();
      const retry = vi.fn();
      const dispatcher = createTestProviderProxyRecoveryDispatcher(
        {
          'set-inheritance': async () => {
            throw unavailable;
          },
        },
        fatal,
      );
      const db = newRawDatabase(':memory:');
      try {
        dispatcher.begin('ordinary-set-inheritance', {}, { evidence: vi.fn(), retry, fatal: vi.fn() }).start({
          sourceId: 'inheritance',
          producerId: 'set-inheritance',
          input: {
            locator: providerOperationRecord('executing'),
            db,
            signal: new AbortController().signal,
          },
        });
        await vi.waitFor(() => expect(retry).toHaveBeenCalled());
        expect(fatal).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    }
  },
);

it('preserves encoding failures as typed invariants with their cause', async () => {
  const error = new TypeError('cannot encode request');
  const attempted = establish([controlExchangeForTest({ kind: 'not-sent', cause: 'encode-failed', error })]);
  await expect(attempted).rejects.toBeInstanceOf(ProviderProxySetInheritanceCorruptionError);
  await expect(attempted).rejects.toMatchObject({ code: 'recovery_contract_violation', cause: error });
});

it.each(['open', 'first-heartbeat', 'fault-race'] as const)(
  'retries an unattributable invalid frame at %s without global fatal',
  async (stage) => {
    const fault = new ControlClientError(
      'control_call_failed',
      'The control channel received an invalid frame.',
      'remote-response',
      { kind: 'invalid-frame' },
    );
    const exchange = controlExchangeForTest({
      kind: 'channel-fault',
      cause: 'invalid-unattributable-frame',
      error: fault,
    });
    const exchanges =
      stage === 'open'
        ? [exchange]
        : [
            controlExchangeForTest({ kind: 'response', response: { kind: 'result', value: openedResult } }),
            stage === 'fault-race' ? new Promise<ControlExchange>(() => {}) : exchange,
          ];
    const result = establish(exchanges, stage === 'fault-race' ? Promise.resolve(fault) : new Promise(() => {}));
    const unavailable = await result.catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(ProviderProxyRoleControlUnavailableError);
    expect(unavailable).toMatchObject({ cause: fault });
    if (!(unavailable instanceof ProviderProxyRoleControlUnavailableError)) throw new Error('expected unavailability');
    if (stage === 'open') expect(unavailable.incident).toMatchObject({ kind: 'role-open-indeterminate', exchange });
    else if (stage === 'first-heartbeat')
      expect(unavailable.incident).toMatchObject({
        kind: 'role-heartbeat-indeterminate',
        observation: { kind: 'channel-fault', error: fault },
      });
    else expect(unavailable.incident).toMatchObject({ kind: 'role-control-channel-fault', stage: 'heartbeat', fault });
    const globalFatal = vi.fn();
    const turnFatal = vi.fn();
    const retry = vi.fn();
    const dispatcher = createTestProviderProxyRecoveryDispatcher(
      {
        'set-inheritance': async () => {
          throw unavailable;
        },
      },
      globalFatal,
    );
    const db = newRawDatabase(':memory:');
    try {
      dispatcher.begin('ordinary-set-inheritance', {}, { evidence: vi.fn(), retry, fatal: turnFatal }).start({
        sourceId: 'inheritance',
        producerId: 'set-inheritance',
        input: { locator: providerOperationRecord('executing'), db, signal: new AbortController().signal },
      });
      await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
      expect(globalFatal).not.toHaveBeenCalled();
      expect(turnFatal).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  },
);

it.each(['open', 'first-heartbeat'] as const)('retries unusable %s results without global fatal', async (stage) => {
  const unusable = controlExchangeForTest({
    kind: 'response',
    response: { kind: 'result', value: { controlEpoch: 1 } },
  });
  const exchanges =
    stage === 'open'
      ? [unusable]
      : [controlExchangeForTest({ kind: 'response', response: { kind: 'result', value: openedResult } }), unusable];
  const error = await establish(exchanges).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ProviderProxyRoleControlUnavailableError);
  expect(error).toMatchObject({
    incident:
      stage === 'open'
        ? { kind: 'role-result-unusable', exchange: unusable }
        : {
            kind: 'role-heartbeat-indeterminate',
            observation: { kind: 'reply', reply: { kind: 'unusable', exchange: unusable } },
          },
  });
  const fatal = vi.fn();
  const retry = vi.fn();
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    {
      'set-inheritance': async () => {
        throw error;
      },
    },
    fatal,
  );
  const db = newRawDatabase(':memory:');
  try {
    dispatcher.begin('ordinary-set-inheritance', {}, { evidence: vi.fn(), retry, fatal }).start({
      sourceId: 'inheritance',
      producerId: 'set-inheritance',
      input: { locator: providerOperationRecord('executing'), db, signal: new AbortController().signal },
    });
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(fatal).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});
