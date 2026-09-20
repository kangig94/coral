import { describe, expect, it, vi } from 'vitest';

import { ProviderOperationAtomicTerminalizationError } from '#src/jobs/provider-operation-terminalization.js';
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
import { providerOperationMutationAdmission } from '#src/store/provider-operation-journal.js';

type Settlement = Readonly<{ kind: 'value'; value: unknown }> | Readonly<{ kind: 'throw'; error: unknown }>;
type ProducerSettlement = Settlement | Readonly<{ kind: 'reject'; error: Error }>;
type ControlledSettlement = Readonly<{ kind: 'value'; value: unknown }> | Readonly<{ kind: 'reject'; error: Error }>;

function controlledProducer(): Readonly<{
  produce: () => Promise<unknown>;
  settle: (settlement: ControlledSettlement) => void;
}> {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return {
    produce: () => promise,
    settle: (settlement) => {
      if (settlement.kind === 'value') resolve(settlement.value);
      else reject(settlement.error);
    },
  };
}

async function flushRecoveryTurn(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

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
    const mutationFence = providerOperationMutationAdmission(db).closeSet(identity);
    const proof = await createProviderProxySetContainmentProver(runtime).collectContainmentProof(
      authorizeProviderProxySetContainmentProof(identity, {
        mutationFence,
        closeAdmission: async () => undefined,
      }),
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
  settlement: ProducerSettlement,
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
  const effectiveSettlement: ProducerSettlement =
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
    if (effectiveSettlement.kind === 'reject') return Promise.reject(effectiveSettlement.error);
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
  it('disposes a cached non-reap absence proof when redemption wins exact recovery', async () => {
    const absence = await testContainmentProof(false);
    const disposeLateEvidence = vi.fn();
    const evidence = vi.fn();
    const dispatcher = createTestProviderProxyRecoveryDispatcher({
      'containment-proof': async () => absence.proof,
      'capsule-redemption': () => ({ kind: 'redeemed', set: { setIdentity: absence.identity } }) as never,
    });
    const turn = dispatcher.begin(
      'exact-capsule-recovery',
      { setIdentity: absence.identity },
      {
        evidence,
        retry: vi.fn(),
        fatal: vi.fn(),
        disposeLateEvidence,
      },
    );

    turn.start({ sourceId: 'absence', producerId: 'containment-proof', input: {} } as ProviderProxyRecoveryAnySource);
    await Promise.resolve();
    turn.start({
      sourceId: 'redemption',
      producerId: 'capsule-redemption',
      input: {},
    } as ProviderProxyRecoveryAnySource);
    await Promise.resolve();

    expect(evidence).toHaveBeenCalledWith(expect.objectContaining({ kind: 'redeemed' }), 'redemption');
    expect(disposeLateEvidence).toHaveBeenCalledOnce();
    expect(disposeLateEvidence).toHaveBeenCalledWith(absence.proof, 'absence');
  });

  it('disposes cached absence proof when exact recovery retires on conflicting evidence', async () => {
    const absence = await testContainmentProof(true);
    const redemption = { kind: 'redeemed', set: { setIdentity: absence.identity } };
    const disposeLateEvidence = vi.fn();
    const fatal = vi.fn();
    const dispatcher = createTestProviderProxyRecoveryDispatcher({
      'containment-proof': async () => absence.proof,
      'capsule-redemption': () => redemption as never,
    });
    const turn = dispatcher.begin(
      'exact-capsule-recovery',
      { setIdentity: absence.identity },
      {
        evidence: vi.fn(),
        retry: vi.fn(),
        fatal,
        disposeLateEvidence,
      },
    );

    turn.start({ sourceId: 'absence', producerId: 'containment-proof', input: {} } as ProviderProxyRecoveryAnySource);
    await Promise.resolve();
    turn.start({
      sourceId: 'redemption',
      producerId: 'capsule-redemption',
      input: {},
    } as ProviderProxyRecoveryAnySource);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();

    expect(fatal).toHaveBeenCalledOnce();
    expect(disposeLateEvidence).toHaveBeenCalledTimes(2);
    expect(disposeLateEvidence).toHaveBeenCalledWith(absence.proof, 'absence');
    expect(disposeLateEvidence).toHaveBeenCalledWith(redemption, 'redemption');
  });

  it('disposes cached absence proof when the recovery turn is cancelled', async () => {
    const absence = await testContainmentProof(false);
    const disposeLateEvidence = vi.fn();
    const dispatcher = createTestProviderProxyRecoveryDispatcher({
      'containment-proof': async () => absence.proof,
    });
    const turn = dispatcher.begin(
      'exact-capsule-recovery',
      { setIdentity: absence.identity },
      {
        evidence: vi.fn(),
        retry: vi.fn(),
        fatal: vi.fn(),
        disposeLateEvidence,
      },
    );

    turn.start({ sourceId: 'absence', producerId: 'containment-proof', input: {} } as ProviderProxyRecoveryAnySource);
    await Promise.resolve();
    turn.cancel(new Error('cancelled'));

    expect(disposeLateEvidence).toHaveBeenCalledOnce();
    expect(disposeLateEvidence).toHaveBeenCalledWith(absence.proof, 'absence');
  });

  it.each([
    { pair: 'non-reap absence / malformed redemption value', order: ['redemption', 'absence'] as const },
    { pair: 'non-reap absence / malformed redemption value', order: ['absence', 'redemption'] as const },
    { pair: 'unavailable absence / malformed redemption outcome', order: ['redemption', 'absence'] as const },
    { pair: 'unavailable absence / malformed redemption outcome', order: ['absence', 'redemption'] as const },
    { pair: 'fatal absence / unavailable redemption', order: ['redemption', 'absence'] as const },
    { pair: 'fatal absence / unavailable redemption', order: ['absence', 'redemption'] as const },
    { pair: 'fatal absence / unavailable redemption outcome', order: ['redemption', 'absence'] as const },
    { pair: 'fatal absence / unavailable redemption outcome', order: ['absence', 'redemption'] as const },
  ])('reduces $pair when $order.0 settles first', async ({ pair, order }) => {
    const containment = await testContainmentProof(false);
    const redemption = controlledProducer();
    const absence = controlledProducer();
    const fatal = vi.fn();
    const retry = vi.fn();
    const disposeLateEvidence = vi.fn();
    const events: string[] = [];
    const retiredSources = new Set<string>();
    const redemptionAbort = new AbortController();
    const absenceAbort = new AbortController();
    redemptionAbort.signal.addEventListener('abort', () => events.push('abort:redemption'));
    absenceAbort.signal.addEventListener('abort', () => events.push('abort:absence'));
    const dispatcher = createTestProviderProxyRecoveryDispatcher(
      {
        'role-control': redemption.produce,
        'containment-proof': absence.produce as ProviderProxyRecoveryProducerPorts['containment-proof'],
      },
      vi.fn(),
    );
    const turn = dispatcher.begin(
      'control-reattachment-hold',
      { setIdentity: containment.identity, retiredSources },
      {
        evidence: vi.fn(),
        retry: (value) => {
          events.push('retry');
          retry(value);
        },
        fatal: (error) => {
          events.push(`fatal:${error.producerId}`);
          fatal(error);
        },
        disposeLateEvidence: (value, sourceId) => {
          events.push(`dispose:${sourceId}`);
          disposeLateEvidence(value, sourceId);
        },
      },
    );
    turn.start({
      sourceId: 'redemption',
      producerId: 'role-control',
      input: { signal: redemptionAbort.signal, run: redemption.produce },
      abort: (reason) => redemptionAbort.abort(reason),
    });
    turn.start({
      sourceId: 'absence',
      producerId: 'containment-proof',
      input: { identity: containment.identity, signal: absenceAbort.signal },
      abort: (reason) => absenceAbort.abort(reason),
    });

    const settlements: Record<(typeof order)[number], ControlledSettlement> =
      pair === 'non-reap absence / malformed redemption value'
        ? {
            redemption: { kind: 'value', value: null },
            absence: { kind: 'value', value: containment.proof },
          }
        : pair === 'unavailable absence / malformed redemption outcome'
          ? {
              redemption: { kind: 'value', value: { kind: 'not-a-redemption-outcome' } },
              absence: { kind: 'reject', error: unavailable },
            }
          : pair === 'fatal absence / unavailable redemption'
            ? {
                redemption: { kind: 'reject', error: unavailable },
                absence: { kind: 'value', value: { kind: 'not-a-containment-proof' } },
              }
            : {
                // The producer fulfills rather than rejects here: the incident lives on the resolved
                // outcome's own `kind`, not on a thrown/rejected error the classifier sees directly.
                redemption: { kind: 'value', value: { kind: 'unavailable', incident: unavailable.incident } },
                absence: { kind: 'value', value: { kind: 'not-a-containment-proof' } },
              };
    const fatalSource =
      pair === 'fatal absence / unavailable redemption' || pair === 'fatal absence / unavailable redemption outcome'
        ? 'absence'
        : 'redemption';

    const first = order[0];
    (first === 'redemption' ? redemption : absence).settle(settlements[first]);
    await flushRecoveryTurn();

    expect({
      fatalCalls: fatal.mock.calls.length,
      retryCalls: retry.mock.calls.length,
      retiredSources: [...retiredSources],
      redemptionAborted: redemptionAbort.signal.aborted,
      absenceAborted: absenceAbort.signal.aborted,
    }).toEqual(
      first === fatalSource
        ? {
            fatalCalls: 1,
            retryCalls: 0,
            retiredSources: [fatalSource],
            redemptionAborted: fatalSource === 'redemption',
            absenceAborted: fatalSource === 'absence',
          }
        : {
            fatalCalls: 0,
            retryCalls: 0,
            retiredSources: [],
            redemptionAborted: false,
            absenceAborted: false,
          },
    );

    const second = order[1];
    (second === 'redemption' ? redemption : absence).settle(settlements[second]);
    await flushRecoveryTurn();

    expect({
      fatalCalls: fatal.mock.calls.length,
      retryCalls: retry.mock.calls.length,
      retiredSources: [...retiredSources],
      redemptionAborted: redemptionAbort.signal.aborted,
      absenceAborted: absenceAbort.signal.aborted,
    }).toEqual({
      fatalCalls: 1,
      retryCalls: 1,
      retiredSources: [fatalSource],
      redemptionAborted: true,
      absenceAborted: true,
    });
    if (pair === 'non-reap absence / malformed redemption value') {
      expect(events.indexOf('fatal:role-control')).toBeLessThan(events.indexOf('dispose:absence'));
      expect(disposeLateEvidence).toHaveBeenCalledWith(containment.proof, 'absence');
    }

    // The retry that ends every pair must carry the surviving source's own cause: the fatal error the
    // other source produced, or that source's own typed incident — never a synthetic stand-in for a
    // value the reducer failed to unwrap.
    const [retryPayload] = retry.mock.calls.at(-1) ?? [];
    expect(retryPayload).toEqual(
      pair === 'non-reap absence / malformed redemption value'
        ? { producerId: 'role-control', incident: fatal.mock.calls[0]?.[0] }
        : {
            producerId:
              pair === 'unavailable absence / malformed redemption outcome' ? 'containment-proof' : 'role-control',
            incident: unavailable.incident,
          },
    );
  });

  it.each<['control-reattachment-hold' | 'control-reattachment', 'redemption' | 'absence', 'redemption' | 'absence']>([
    ['control-reattachment-hold', 'redemption', 'absence'],
    ['control-reattachment-hold', 'absence', 'redemption'],
    ['control-reattachment', 'redemption', 'absence'],
    ['control-reattachment', 'absence', 'redemption'],
  ])('ends the %s turn without a retry once both sources are retired, %s first', async (seam, ...order) => {
    const identity = providerProxySetIdentityFromRecord(providerOperationRecord('executing'));
    const redemption = controlledProducer();
    const absence = controlledProducer();
    const fatal = vi.fn();
    const retry = vi.fn();
    const retiredSources = new Set<string>();
    const redemptionAbort = new AbortController();
    const absenceAbort = new AbortController();
    const dispatcher = createTestProviderProxyRecoveryDispatcher({
      'role-control': redemption.produce,
      'containment-proof': absence.produce as ProviderProxyRecoveryProducerPorts['containment-proof'],
    });
    const turn = dispatcher.begin(seam, { setIdentity: identity, retiredSources }, { evidence: vi.fn(), retry, fatal });
    turn.start({
      sourceId: 'redemption',
      producerId: 'role-control',
      input: { signal: redemptionAbort.signal, run: redemption.produce },
      abort: (reason) => redemptionAbort.abort(reason),
    });
    turn.start({
      sourceId: 'absence',
      producerId: 'containment-proof',
      input: { identity, signal: absenceAbort.signal },
      abort: (reason) => absenceAbort.abort(reason),
    });

    const settlements: Record<(typeof order)[number], ControlledSettlement> = {
      redemption: { kind: 'value', value: null },
      absence: { kind: 'value', value: { kind: 'not-a-containment-proof' } },
    };
    for (const source of order) {
      (source === 'redemption' ? redemption : absence).settle(settlements[source]);
      await flushRecoveryTurn();
    }

    expect({
      fatalCalls: fatal.mock.calls.length,
      retryCalls: retry.mock.calls.length,
      retiredSources: [...retiredSources].sort(),
      redemptionAborted: redemptionAbort.signal.aborted,
      absenceAborted: absenceAbort.signal.aborted,
    }).toEqual({
      fatalCalls: 2,
      retryCalls: 0,
      retiredSources: ['absence', 'redemption'],
      redemptionAborted: true,
      absenceAborted: true,
    });
  });

  it('disposes evidence that arrives after its source retires without retiring the surviving source', async () => {
    const firstRedemption = controlledProducer();
    const lateRedemption = controlledProducer();
    const redemptionSettlements = [firstRedemption, lateRedemption];
    const absence = controlledProducer();
    const disposeLateEvidence = vi.fn();
    const fatal = vi.fn();
    const retry = vi.fn();
    const dispatcher = createTestProviderProxyRecoveryDispatcher({
      'role-control': () => redemptionSettlements.shift()?.produce() ?? Promise.reject(new Error('missing settlement')),
      'containment-proof': absence.produce as ProviderProxyRecoveryProducerPorts['containment-proof'],
    });
    const turn = dispatcher.begin(
      'control-reattachment-hold',
      { retiredSources: new Set() },
      { evidence: vi.fn(), retry, fatal, disposeLateEvidence },
    );
    const source = {
      sourceId: 'redemption',
      producerId: 'role-control' as const,
      input: { signal: new AbortController().signal, run: firstRedemption.produce },
    };
    turn.start(source);
    turn.start(source);
    turn.start({
      sourceId: 'absence',
      producerId: 'containment-proof',
      input: {
        identity: providerProxySetIdentityFromRecord(providerOperationRecord('executing')),
        signal: new AbortController().signal,
      },
    });

    firstRedemption.settle({ kind: 'value', value: null });
    await flushRecoveryTurn();
    const lateOutcome = { kind: 'unavailable', incident: unavailable.incident };
    lateRedemption.settle({ kind: 'value', value: lateOutcome });
    await flushRecoveryTurn();

    expect(fatal).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(disposeLateEvidence).toHaveBeenCalledTimes(2);
    expect(disposeLateEvidence).toHaveBeenCalledWith(null, 'redemption');
    expect(disposeLateEvidence).toHaveBeenCalledWith(lateOutcome, 'redemption');
  });

  it.each(['redemption', 'absence'] as const)(
    'carries retired %s into a later attempt and starts only its survivor',
    async (retiredSource) => {
      const containment = await testContainmentProof(false);
      const roleControl = vi.fn(() => {
        throw unavailable;
      });
      const containmentProof = vi.fn(() => {
        throw unavailable;
      });
      const retry = vi.fn();
      const dispatcher = createTestProviderProxyRecoveryDispatcher({
        'role-control': roleControl,
        'containment-proof': containmentProof,
      });
      const turn = dispatcher.begin(
        'control-reattachment-hold',
        { setIdentity: containment.identity, retiredSources: new Set([retiredSource]) },
        { evidence: vi.fn(), retry, fatal: vi.fn() },
      );
      turn.start({
        sourceId: 'redemption',
        producerId: 'role-control',
        input: { signal: new AbortController().signal, run: async () => ({ kind: 'unavailable' }) },
      });
      turn.start({
        sourceId: 'absence',
        producerId: 'containment-proof',
        input: { identity: containment.identity, signal: new AbortController().signal },
      });
      await flushRecoveryTurn();

      expect({
        roleControlCalls: roleControl.mock.calls.length,
        containmentProofCalls: containmentProof.mock.calls.length,
      }).toEqual(
        retiredSource === 'redemption'
          ? { roleControlCalls: 0, containmentProofCalls: 1 }
          : { roleControlCalls: 1, containmentProofCalls: 0 },
      );
      expect(retry).toHaveBeenCalledOnce();
    },
  );

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

  it('classifies a producer that returns a rejecting promise', async () => {
    await expect(observe('capsule-retirement', { kind: 'reject', error: unavailable })).resolves.toEqual({
      evidence: 0,
      retry: 1,
      localFatal: 0,
      globalFatal: 0,
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
