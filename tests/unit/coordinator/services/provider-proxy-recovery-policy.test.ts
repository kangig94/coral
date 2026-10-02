import { describe, expect, it, vi } from 'vitest';
import { ProviderProxyRoleControlUnavailableError } from '#src/coordinator/live/provider-proxy/role-control.js';
import {
  type ProviderProxyRecoveryAnySource,
  type ProviderProxyRecoveryProducerPorts,
} from '#src/coordinator/services/provider-proxy-recovery-policy.js';
import { createTestProviderProxyRecoveryDispatcher } from '#tests/helpers/provider-proxy-recovery-dispatcher.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';
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

  it('keeps foreign capsule retirement failure owner-local', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    const retry = vi.fn();
    const fatal = vi.fn();
    const globalFatal = vi.fn();
    const dispatcher = createTestProviderProxyRecoveryDispatcher(
      {
        'capsule-retirement': () => {
          throw error;
        },
      },
      globalFatal,
    );
    const turn = dispatcher.begin(
      'foreign-capsule-retirement',
      {},
      {
        evidence: vi.fn(),
        retry,
        fatal,
      },
    );
    turn.start({
      sourceId: 'retirement',
      producerId: 'capsule-retirement',
      input: {},
    } as ProviderProxyRecoveryAnySource);
    await flushRecoveryTurn();
    expect(retry).toHaveBeenCalledWith({
      producerId: 'capsule-retirement',
      incident: { kind: 'foreign-capsule-retirement-rejected', errorCode: 'EACCES' },
    });
    expect(fatal).not.toHaveBeenCalled();
    expect(globalFatal).not.toHaveBeenCalled();
  });
});
