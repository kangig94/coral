import { expect, it, vi } from 'vitest';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { isProviderProxyRecoveryFatalError } from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const record = providerOperationRecord('executing');
const identity = providerProxySetIdentityFromRecord(record);
const signal = new AbortController().signal;

const authority = {
  ...Object.fromEntries(
    [
      'commitContainment',
      'stopHeartbeats',
      'initiateControlClose',
      'stopAndReap',
      'installRecoveryCredential',
      'authorizeControllerTransfer',
      'registerSuccessionOperation',
      'onFault',
      'onIncident',
      'redeemControl',
      'promoteControl',
      'prepareOperation',
      'inspectOperation',
      'authorizeOperation',
      'activatePreparedOperation',
      'attachOperation',
      'cancelOperation',
      'settleOperation',
      'sendOperation',
      'buildOperationControl',
    ].map((method) => [method, () => undefined]),
  ),
  proxyInstanceId: identity.proxyInstanceId,
  setIdentity: identity,
  faulted: new Promise(() => {}),
  autonomousDeadline: {
    orphanTimeoutMs: 60_000,
    adoptionWindowMs: 46_000,
    heartbeatHoldBound: { spanMs: 10_000, materialSchedulerLatenessMs: 1_000 },
  },
  providerHosts: Object.fromEntries(
    ['list', 'inspect', 'terminalEviction', 'evict'].map((method) => [method, () => undefined]),
  ),
};
const recoveredFields = {
  set: authority,
  publicationReceipt: { kind: 'provider-proxy-set-published' },
  protection: 'protected',
};
it('routes a recognized redemption missing its set to the fatal owner without an unhandled rejection', async () => {
  const globalFatal = vi.fn();
  const fatal = vi.fn();
  const retry = vi.fn();
  const evidence = vi.fn();
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    {
      'capsule-redemption': async () =>
        ({
          kind: 'redeemed',
          publicationReceipt: recoveredFields.publicationReceipt,
          protection: 'protected',
        }) as never,
    },
    globalFatal,
  );
  dispatcher.begin('exact-capsule-recovery', { setIdentity: identity }, { fatal, retry, evidence }).start({
    sourceId: 'outcome',
    producerId: 'capsule-redemption',
    input: { capsule: {} as never, capsulePath: '/unused', signal },
  });
  await vi.waitFor(() => expect(globalFatal).toHaveBeenCalledOnce());
  expect(isProviderProxyRecoveryFatalError(globalFatal.mock.calls[0]?.[0])).toBe(true);
  expect(globalFatal.mock.calls[0]?.[0]).toMatchObject({
    producerId: 'capsule-redemption',
    cause: expect.any(Error),
  });
  expect(fatal).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  expect(evidence).not.toHaveBeenCalled();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it('contains a failing evidence consumer through the fatal owner after the turn settles', async () => {
  const failure = new Error('evidence consumer failed');
  const globalFatal = vi.fn();
  const fatal = vi.fn();
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    { 'set-inheritance': async () => ({ kind: 'recorded-group-unattributable' }) },
    globalFatal,
  );
  const db = newRawDatabase(':memory:');
  try {
    dispatcher
      .begin(
        'startup-set-inheritance',
        { setIdentity: identity },
        {
          fatal,
          retry: vi.fn(),
          evidence: () => {
            throw failure;
          },
        },
      )
      .start({ sourceId: 'outcome', producerId: 'set-inheritance', input: { locator: record, db, signal } });
    await vi.waitFor(() => expect(globalFatal).toHaveBeenCalledOnce());
    expect(globalFatal.mock.calls[0]?.[0]).toMatchObject({ cause: failure });
    expect(fatal).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    db.close();
  }
});

it('accepts an explicitly undefined exchange error while requiring the field to exist', async () => {
  const retry = vi.fn();
  const fatal = vi.fn();
  const incident = {
    kind: 'role-open-indeterminate',
    role: 'guardian',
    method: 'guardian.handoff-redeem.v1',
    exchange: { kind: 'not-sent', cause: 'write-threw', error: undefined },
  };
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    { 'set-inheritance': async () => ({ kind: 'temporarily-unavailable', incident }) as never },
    fatal,
  );
  const db = newRawDatabase(':memory:');
  try {
    dispatcher
      .begin('startup-set-inheritance', { setIdentity: identity }, { fatal, retry, evidence: vi.fn() })
      .start({ sourceId: 'outcome', producerId: 'set-inheritance', input: { locator: record, db, signal } });
    await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
    expect(fatal).not.toHaveBeenCalled();
    expect(Object.hasOwn(retry.mock.calls[0]?.[0].incident.exchange, 'error')).toBe(true);
  } finally {
    db.close();
  }
});

it('accepts complete inheritance fields and retains the original authority capability', async () => {
  const evidence = vi.fn();
  const fatal = vi.fn();
  const value = { kind: 'inherited', ...recoveredFields };
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    { 'set-inheritance': async () => value as never },
    fatal,
  );
  const db = newRawDatabase(':memory:');
  try {
    dispatcher
      .begin('startup-set-inheritance', { setIdentity: identity }, { fatal, retry: vi.fn(), evidence })
      .start({ sourceId: 'outcome', producerId: 'set-inheritance', input: { locator: record, db, signal } });
    await vi.waitFor(() => expect(evidence).toHaveBeenCalledOnce());
    expect(evidence.mock.calls[0]?.[0]).toBe(value);
    expect(evidence.mock.calls[0]?.[0].set).toBe(authority);
    expect(fatal).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it('rejects a complete inherited authority for a different exact set', async () => {
  const fatal = vi.fn();
  const evidence = vi.fn();
  const value = { kind: 'inherited', ...recoveredFields };
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    { 'set-inheritance': async () => value as never },
    fatal,
  );
  const db = newRawDatabase(':memory:');
  try {
    dispatcher
      .begin(
        'startup-set-inheritance',
        { setIdentity: { ...identity, canonicalEndpoint: identity.canonicalEndpoint + '-other' } },
        { fatal: vi.fn(), retry: vi.fn(), evidence },
      )
      .start({ sourceId: 'outcome', producerId: 'set-inheritance', input: { locator: record, db, signal } });
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
    expect(isProviderProxyRecoveryFatalError(fatal.mock.calls[0]?.[0])).toBe(true);
    expect(evidence).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});
