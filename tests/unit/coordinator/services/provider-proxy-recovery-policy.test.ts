import { describe, expect, it } from 'vitest';

import {
  ProviderOperationAtomicTerminalizationError,
  ProviderOperationTerminalizationUnavailableError,
} from '#src/jobs/provider-operation-terminalization.js';
import { ProviderProxyRoleControlUnavailableError } from '#src/coordinator/live/provider-proxy/role-control.js';
import {
  type ProviderProxyRecoveryConsumerSeam,
  type ProviderProxyRecoveryAnySource,
  type ProviderProxyRecoveryExactContext,
  type ProviderProxyRecoveryProducerId,
  type ProviderProxyRecoveryProducerPorts,
} from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

type Settlement = Readonly<{ kind: 'value'; value: unknown }> | Readonly<{ kind: 'throw'; error: unknown }>;

const unavailable = new ProviderProxyRoleControlUnavailableError({
  kind: 'role-control-unavailable',
  role: 'guardian',
  stage: 'open',
  method: 'guardian.handoff-redeem.v1',
  origin: 'timeout',
  controlCode: 'control_call_failed',
});

const seamFor = (producerId: ProviderProxyRecoveryProducerId): ProviderProxyRecoveryConsumerSeam => {
  switch (producerId) {
    case 'disappearance-terminalization':
      return 'disappearance-delivery';
    case 'set-inheritance':
      return 'startup-set-inheritance';
    case 'capsule-redemption':
      return 'opaque-capsule-redemption';
    case 'capsule-rewrite':
      return 'opaque-capsule-rewrite';
    case 'capsule-retirement':
      return 'capsule-retirement';
    case 'disappearance-consumer':
      return 'disappearance-delivery';
    case 'role-control':
    case 'containment-proof':
      return 'containment-attempt';
  }
};

async function observe(
  producerId: ProviderProxyRecoveryProducerId,
  settlement: Settlement,
  context: ProviderProxyRecoveryExactContext = {},
): Promise<Readonly<{ evidence: number; retry: number; localFatal: number; globalFatal: number }>> {
  let evidence = 0;
  let retry = 0;
  let localFatal = 0;
  let globalFatal = 0;
  const producer = () => {
    if (settlement.kind === 'throw') throw settlement.error;
    return settlement.value;
  };
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    { [producerId]: producer } as Partial<ProviderProxyRecoveryProducerPorts>,
    () => {
      globalFatal += 1;
    },
  );
  const turn = dispatcher.begin(seamFor(producerId), context, {
    evidence: () => {
      evidence += 1;
    },
    retry: () => {
      retry += 1;
    },
    fatal: () => {
      localFatal += 1;
    },
  });
  turn.start({
    sourceId: 'matrix-source',
    producerId,
    input: {},
  } as ProviderProxyRecoveryAnySource);
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  return { evidence, retry, localFatal, globalFatal };
}

describe('provider proxy recovery producer classification', () => {
  it('classifies every closed producer with positive and opposite facts', async () => {
    const record = providerOperationRecord('executing');
    const positive = new Map<ProviderProxyRecoveryProducerId, unknown>([
      ['disappearance-terminalization', { kind: 'terminalized' }],
      ['role-control', { disappearanceReceipt: 'role-evidence' }],
      ['set-inheritance', { kind: 'not-bequeathed', reason: 'no capsule' }],
      ['capsule-redemption', { kind: 'redeemed', set: {} }],
      ['containment-proof', 'containment-absent'],
      ['capsule-rewrite', undefined],
      ['capsule-retirement', { kind: 'retired' }],
      [
        'disappearance-consumer',
        {
          kind: 'accepted',
          acceptance: { kind: 'accepted', operation: record.operation, disposition: 'record-absent' },
        },
      ],
    ]);

    const positiveResults = await Promise.all(
      [...positive].map(async ([producerId, value]) => [
        producerId,
        await observe(
          producerId,
          { kind: 'value', value },
          producerId === 'disappearance-consumer' ? { operation: record.operation } : {},
        ),
      ]),
    );
    const unknownResults = await Promise.all(
      [...positive.keys()].map(async (producerId) => [
        producerId,
        await observe(producerId, { kind: 'throw', error: new Error(`${producerId}-unknown`) }),
      ]),
    );

    expect(Object.fromEntries(positiveResults)).toEqual(
      Object.fromEntries(
        [...positive.keys()].map((producerId) => [
          producerId,
          { evidence: 1, retry: 0, localFatal: 0, globalFatal: 0 },
        ]),
      ),
    );
    expect(Object.fromEntries(unknownResults)).toEqual(
      Object.fromEntries(
        [...positive.keys()].map((producerId) => [
          producerId,
          { evidence: 0, retry: 0, localFatal: 1, globalFatal: 1 },
        ]),
      ),
    );

    await expect(
      observe('disappearance-terminalization', {
        kind: 'throw',
        error: new ProviderOperationAtomicTerminalizationError(record.operation, new Error('atomic-unknown')),
      }),
    ).resolves.toEqual({ evidence: 0, retry: 1, localFatal: 0, globalFatal: 0 });
    await expect(
      observe('disappearance-terminalization', {
        kind: 'throw',
        error: new ProviderOperationTerminalizationUnavailableError(),
      }),
    ).resolves.toEqual({ evidence: 0, retry: 1, localFatal: 0, globalFatal: 0 });
    await expect(observe('role-control', { kind: 'throw', error: unavailable })).resolves.toEqual({
      evidence: 0,
      retry: 1,
      localFatal: 0,
      globalFatal: 0,
    });
    await expect(
      observe('set-inheritance', {
        kind: 'value',
        value: { kind: 'temporarily-unavailable', incident: unavailable.incident },
      }),
    ).resolves.toEqual({ evidence: 0, retry: 1, localFatal: 0, globalFatal: 0 });
    await expect(
      observe('capsule-redemption', {
        kind: 'value',
        value: { kind: 'temporarily-unavailable', incident: unavailable.incident },
      }),
    ).resolves.toEqual({ evidence: 0, retry: 1, localFatal: 0, globalFatal: 0 });
    await expect(observe('containment-proof', { kind: 'throw', error: unavailable })).resolves.toEqual({
      evidence: 0,
      retry: 1,
      localFatal: 0,
      globalFatal: 0,
    });
    await expect(
      observe('capsule-retirement', {
        kind: 'value',
        value: {
          kind: 'temporarily-unavailable',
          incident: { kind: 'capsule-directory-durability-unavailable' },
        },
      }),
    ).resolves.toEqual({ evidence: 0, retry: 1, localFatal: 0, globalFatal: 0 });
    await expect(observe('capsule-rewrite', { kind: 'value', value: 'invalid-success' })).resolves.toEqual({
      evidence: 0,
      retry: 0,
      localFatal: 1,
      globalFatal: 1,
    });
  });

  it('classifies disappearance delivery only from the strict outcome and complete operation identity', async () => {
    const operation = providerOperationRecord('executing').operation;
    const accepted = {
      kind: 'accepted' as const,
      acceptance: { kind: 'accepted' as const, operation, disposition: 'record-absent' as const },
    };

    await expect(observe('disappearance-consumer', { kind: 'value', value: accepted }, { operation })).resolves.toEqual(
      { evidence: 1, retry: 0, localFatal: 0, globalFatal: 0 },
    );
    await expect(
      observe(
        'disappearance-consumer',
        {
          kind: 'value',
          value: {
            kind: 'operational-failure',
            code: 'disappearance_consumer_unavailable',
            reason: 'transient store contention',
          },
        },
        { operation },
      ),
    ).resolves.toEqual({ evidence: 0, retry: 1, localFatal: 0, globalFatal: 0 });
    await expect(
      observe('disappearance-consumer', { kind: 'value', value: { ...accepted, unexpected: true } }, { operation }),
    ).resolves.toEqual({ evidence: 0, retry: 0, localFatal: 1, globalFatal: 1 });
    await expect(
      observe('disappearance-consumer', { kind: 'throw', error: unavailable }, { operation }),
    ).resolves.toEqual({ evidence: 0, retry: 0, localFatal: 1, globalFatal: 1 });

    for (const field of ['jobId', 'operationId', 'proxyInstanceId', 'buildSetId'] as const) {
      await expect(
        observe(
          'disappearance-consumer',
          {
            kind: 'value',
            value: {
              ...accepted,
              acceptance: {
                ...accepted.acceptance,
                operation: { ...operation, [field]: '00000000-0000-4000-8000-000000000123' },
              },
            },
          },
          { operation },
        ),
      ).resolves.toEqual({ evidence: 0, retry: 0, localFatal: 1, globalFatal: 1 });
    }
  });
});
