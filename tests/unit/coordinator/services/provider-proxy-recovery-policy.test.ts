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
import type { ProviderHandoffCapsuleRetirementOutcome } from '#src/coordinator/services/provider-proxy-capsule-discovery.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import {
  authorizeProviderProxySetContainmentProof,
  createProviderProxySetContainmentProver,
} from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { providerProxySetIdentityFromRecord } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

type Settlement = Readonly<{ kind: 'value'; value: unknown }> | Readonly<{ kind: 'throw'; error: unknown }>;

const unavailable = new ProviderProxyRoleControlUnavailableError({
  kind: 'role-control-unavailable',
  role: 'guardian',
  stage: 'open',
  method: 'guardian.handoff-redeem.v1',
  origin: 'timeout',
  controlCode: 'control_call_failed',
});

async function testContainmentProof(reapRequired: boolean) {
  const identity = providerProxySetIdentityFromRecord(providerOperationRecord('executing'));
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  const runtime = {
    ...createRealRuntime('prod'),
    process: {
      ...createRealRuntime('prod').process,
      readProcessIncarnation: () => null,
      observeLiveness: () => (reapRequired ? ('absent' as const) : ('unknown' as const)),
    },
  };
  try {
    const proof = await createProviderProxySetContainmentProver(runtime).collectContainmentProof(
      authorizeProviderProxySetContainmentProof(identity),
      db,
      new AbortController().signal,
    );
    return { identity, proof };
  } finally {
    db.close();
  }
}

const seamFor = (producerId: ProviderProxyRecoveryProducerId): ProviderProxyRecoveryConsumerSeam => {
  switch (producerId) {
    case 'disappearance-terminalization':
      return 'disappearance-delivery';
    case 'set-inheritance':
      return 'startup-set-inheritance';
    case 'capsule-redemption':
      return 'exact-capsule-recovery';
    case 'capsule-retirement':
      return 'capsule-retirement';
    case 'disappearance-consumer':
      return 'disappearance-delivery';
    case 'representation-abandonment-consumer':
      return 'representation-abandonment-delivery';
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
  const containment = await testContainmentProof(true);
  const pairedAbsence = await testContainmentProof(false);
  const effectiveContext: ProviderProxyRecoveryExactContext =
    producerId === 'containment-proof' || producerId === 'capsule-redemption'
      ? { ...context, setIdentity: containment.identity }
      : context;
  const effectiveSettlement: Settlement =
    settlement.kind === 'value' && producerId === 'containment-proof'
      ? { kind: 'value', value: containment.proof }
      : settlement.kind === 'value' && producerId === 'capsule-redemption'
        ? {
            kind: 'value',
            value: {
              ...(settlement.value as object),
              set: { ...((settlement.value as { set?: object }).set ?? {}), setIdentity: containment.identity },
            },
          }
        : settlement;
  const producer = () => {
    if (effectiveSettlement.kind === 'throw') throw effectiveSettlement.error;
    return effectiveSettlement.value;
  };
  // `capsule-redemption`'s only seam reduces two sources — a redemption and an independent containment proof —
  // and emits nothing until both have landed. Supplying the absence half is what lets this matrix observe the
  // redemption producer's own classification rather than the reducer still waiting.
  const pairsWithAbsence = producerId === 'capsule-redemption';
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    {
      [producerId]: producer,
      ...(pairsWithAbsence
        ? {
            'containment-proof': () => pairedAbsence.proof,
          }
        : {}),
    } as Partial<ProviderProxyRecoveryProducerPorts>,
    () => {
      globalFatal += 1;
    },
  );
  const turn = dispatcher.begin(seamFor(producerId), effectiveContext, {
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
    sourceId: pairsWithAbsence ? 'redemption' : 'matrix-source',
    producerId,
    input: {},
  } as ProviderProxyRecoveryAnySource);
  if (pairsWithAbsence) {
    turn.start({ sourceId: 'absence', producerId: 'containment-proof', input: {} } as ProviderProxyRecoveryAnySource);
  }
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  return { evidence, retry, localFatal, globalFatal };
}

/**
 * The same producer, the same settlement, and the seam as the only difference — the whole point of the split
 * is that a foreign capsule's cleanup failure cannot reach the process-wide fatal sink that the owned seam's
 * identical failure must.
 */
async function retireCapsuleOn(
  seam: ProviderProxyRecoveryConsumerSeam,
  settlement: Settlement,
): Promise<Readonly<{ evidence: number; retryIncidents: unknown[]; localFatal: number; globalFatal: number }>> {
  let evidence = 0;
  let localFatal = 0;
  let globalFatal = 0;
  const retryIncidents: unknown[] = [];
  const dispatcher = createTestProviderProxyRecoveryDispatcher(
    {
      'capsule-retirement': () => {
        if (settlement.kind === 'throw') throw settlement.error;
        return settlement.value as ProviderHandoffCapsuleRetirementOutcome;
      },
    },
    () => {
      globalFatal += 1;
    },
  );
  const turn = dispatcher.begin(
    seam,
    {},
    {
      evidence: () => {
        evidence += 1;
      },
      retry: (retry) => {
        retryIncidents.push(retry.incident);
      },
      fatal: () => {
        localFatal += 1;
      },
    },
  );
  turn.start({
    sourceId: 'retirement',
    producerId: 'capsule-retirement',
    input: { path: '/capsules/paired.handoff.v3.json' },
  });
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  return { evidence, retryIncidents, localFatal, globalFatal };
}

function errorWithHostileCode(): Error {
  const error = new Error('hostile code getter');
  Object.defineProperty(error, 'code', {
    get() {
      throw new Error('reading code is not permitted');
    },
  });
  return error;
}

describe('provider proxy recovery producer classification', () => {
  it('classifies every closed producer with positive and opposite facts', async () => {
    const record = providerOperationRecord('executing');
    const positive = new Map<ProviderProxyRecoveryProducerId, unknown>([
      ['disappearance-terminalization', { kind: 'terminalized' }],
      ['role-control', { disappearanceReceipt: 'role-evidence' }],
      ['set-inheritance', { kind: 'not-bequeathed', reason: 'no capsule' }],
      ['capsule-redemption', { kind: 'redeemed', set: {} }],
      [
        'containment-proof',
        {
          kind: 'reap-required',
          containment: { pid: 200, incarnation: testIncarnation(3), processGroupId: 200 },
          recordedRoots: [],
        },
      ],
      ['capsule-retirement', { kind: 'retired' }],
      [
        'disappearance-consumer',
        {
          kind: 'accepted',
          acceptance: { kind: 'accepted', operation: record.operation, disposition: 'record-absent' },
        },
      ],
      [
        'representation-abandonment-consumer',
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
          producerId === 'disappearance-consumer' || producerId === 'representation-abandonment-consumer'
            ? { operation: record.operation }
            : {},
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

  it('keeps every capsule-retirement failure owner-local on the foreign seam and globally fatal on the owned one', async () => {
    const rejections: readonly Readonly<{ named: string; error: unknown; errorCode: string | null }>[] = [
      { named: 'null', error: null, errorCode: null },
      { named: 'undefined', error: undefined, errorCode: null },
      { named: 'object without a code', error: {}, errorCode: null },
      { named: 'non-string code', error: Object.assign(new Error('numeric'), { code: 13 }), errorCode: null },
      { named: 'hostile code getter', error: errorWithHostileCode(), errorCode: null },
      { named: 'EACCES', error: Object.assign(new Error('denied'), { code: 'EACCES' }), errorCode: 'EACCES' },
      { named: 'EROFS', error: Object.assign(new Error('read-only'), { code: 'EROFS' }), errorCode: 'EROFS' },
      { named: 'EIO', error: Object.assign(new Error('io'), { code: 'EIO' }), errorCode: 'EIO' },
    ];

    const paired = await Promise.all(
      rejections.map(async ({ named, error, errorCode }) => [
        named,
        {
          owned: await retireCapsuleOn('capsule-retirement', { kind: 'throw', error }),
          foreign: await retireCapsuleOn('foreign-capsule-retirement', { kind: 'throw', error }),
          expectedIncident: { kind: 'foreign-capsule-retirement-rejected', errorCode },
        },
      ]),
    );

    expect(Object.fromEntries(paired)).toEqual(
      Object.fromEntries(
        rejections.map(({ named, errorCode }) => [
          named,
          {
            owned: { evidence: 0, retryIncidents: [], localFatal: 1, globalFatal: 1 },
            foreign: {
              evidence: 0,
              retryIncidents: [{ kind: 'foreign-capsule-retirement-rejected', errorCode }],
              localFatal: 0,
              globalFatal: 0,
            },
            expectedIncident: { kind: 'foreign-capsule-retirement-rejected', errorCode },
          },
        ]),
      ),
    );
  });

  it('replaces even a rejection the shared classifier recognises with the foreign seam incident', async () => {
    // The shared classifier answers `unavailable` for this one, which is already owner-local — so only the
    // seam's own branch can guarantee that what the owner receives never depends on the thrown type.
    expect({
      owned: await retireCapsuleOn('capsule-retirement', { kind: 'throw', error: unavailable }),
      foreign: await retireCapsuleOn('foreign-capsule-retirement', { kind: 'throw', error: unavailable }),
    }).toEqual({
      owned: { evidence: 0, retryIncidents: [unavailable.incident], localFatal: 0, globalFatal: 0 },
      foreign: {
        evidence: 0,
        retryIncidents: [{ kind: 'foreign-capsule-retirement-rejected', errorCode: null }],
        localFatal: 0,
        globalFatal: 0,
      },
    });
  });

  it('keeps a malformed retirement fulfillment owner-local under its own kind and leaves the shared outcomes alone', async () => {
    const malformed: Settlement = { kind: 'value', value: { kind: 'not-a-retirement-outcome' } };
    const unavailableOutcome: Settlement = {
      kind: 'value',
      value: { kind: 'temporarily-unavailable', incident: { kind: 'capsule-directory-durability-unavailable' } },
    };

    expect({
      malformedOwned: await retireCapsuleOn('capsule-retirement', malformed),
      malformedForeign: await retireCapsuleOn('foreign-capsule-retirement', malformed),
      unavailableOwned: await retireCapsuleOn('capsule-retirement', unavailableOutcome),
      unavailableForeign: await retireCapsuleOn('foreign-capsule-retirement', unavailableOutcome),
      retiredForeign: await retireCapsuleOn('foreign-capsule-retirement', {
        kind: 'value',
        value: { kind: 'retired' },
      }),
    }).toEqual({
      malformedOwned: { evidence: 0, retryIncidents: [], localFatal: 1, globalFatal: 1 },
      malformedForeign: {
        evidence: 0,
        retryIncidents: [{ kind: 'foreign-capsule-retirement-contract-violation' }],
        localFatal: 0,
        globalFatal: 0,
      },
      unavailableOwned: {
        evidence: 0,
        retryIncidents: [{ kind: 'capsule-directory-durability-unavailable' }],
        localFatal: 0,
        globalFatal: 0,
      },
      unavailableForeign: {
        evidence: 0,
        retryIncidents: [{ kind: 'capsule-directory-durability-unavailable' }],
        localFatal: 0,
        globalFatal: 0,
      },
      retiredForeign: { evidence: 1, retryIncidents: [], localFatal: 0, globalFatal: 0 },
    });
  });

  it('refuses a retirement outcome whose kind promises a retry it carries no incident for', async () => {
    // The one malformed shape a `kind`-only check admits. What each seam receives must be the refusal, never
    // a hold whose incident is absent: nothing downstream can decide what it is holding from `undefined`.
    const incidentless: Settlement = { kind: 'value', value: { kind: 'temporarily-unavailable' } };

    expect({
      owned: await retireCapsuleOn('capsule-retirement', incidentless),
      foreign: await retireCapsuleOn('foreign-capsule-retirement', incidentless),
    }).toEqual({
      owned: { evidence: 0, retryIncidents: [], localFatal: 1, globalFatal: 1 },
      foreign: {
        evidence: 0,
        retryIncidents: [{ kind: 'foreign-capsule-retirement-contract-violation' }],
        localFatal: 0,
        globalFatal: 0,
      },
    });
  });
});
