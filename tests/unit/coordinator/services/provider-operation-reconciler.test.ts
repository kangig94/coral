import {
  ProviderOperationReconciler,
  providerOperationTerminationVerdict,
  type ProviderOperationReconciliationEvidence,
  type ProviderOperationReconciliationTerminations,
} from '#src/coordinator/services/provider-operation-reconciler.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { describe, expect, it, vi } from 'vitest';

import { providerOperationRecord } from '../../store/provider-operation-fixtures.js';

const activationAck = { state: 'executing', committedThroughProviderSeq: 0 } as const;

function terminationSpies(): ProviderOperationReconciliationTerminations {
  return {
    executing: vi.fn(async () => undefined),
    releasedNeverStarted: vi.fn(async () => undefined),
    releasedAfterTerminal: vi.fn(async () => undefined),
    indeterminateActivation: vi.fn(async () => undefined),
  };
}

describe('provider operation termination verdicts', () => {
  it('fires each termination only from its own semantic evidence', () => {
    const cases = [
      [
        'stored activation ACK and local commit',
        providerOperationRecord('proxy-activation-pending'),
        { kind: 'activation-ack-replayed', activationAck, localRuntimeCommitCompleted: true },
        'executing',
      ],
      [
        'activation ACK without local commit',
        providerOperationRecord('proxy-activation-pending'),
        { kind: 'activation-ack-replayed', activationAck, localRuntimeCommitCompleted: false },
        'pending',
      ],
      [
        'never-started release in cleanup',
        providerOperationRecord('prestart-cleanup-pending'),
        { kind: 'released-never-started', prepareAttemptKey: 'b'.repeat(64) },
        'released-never-started',
      ],
      [
        'never-started release for another attempt',
        providerOperationRecord('prestart-cleanup-pending'),
        { kind: 'released-never-started', prepareAttemptKey: 'c'.repeat(64) },
        'pending',
      ],
      [
        'never-started release outside cleanup',
        providerOperationRecord('guardian-activation-pending'),
        { kind: 'released-never-started', prepareAttemptKey: 'b'.repeat(64) },
        'pending',
      ],
      [
        'terminal release through final watermark',
        providerOperationRecord('settlement-pending'),
        { kind: 'released-after-terminal', settledThroughProviderSeq: 4 },
        'released-after-terminal',
      ],
      [
        'terminal release below final watermark',
        providerOperationRecord('settlement-pending'),
        { kind: 'released-after-terminal', settledThroughProviderSeq: 3 },
        'pending',
      ],
      [
        'terminal release outside settlement',
        providerOperationRecord('executing'),
        { kind: 'released-after-terminal', settledThroughProviderSeq: 4 },
        'pending',
      ],
      [
        'containment disappearance after activation uncertainty',
        providerOperationRecord('activation-resolution-pending'),
        { kind: 'containment-disappeared', disappearanceReceipt: 'gone' },
        'indeterminate-activation',
      ],
      [
        'containment disappearance before proxy activation',
        providerOperationRecord('guardian-activation-pending'),
        { kind: 'containment-disappeared', disappearanceReceipt: 'gone' },
        'pending',
      ],
      ['no proof', providerOperationRecord('activation-resolution-pending'), { kind: 'unresolved' }, 'pending'],
    ] satisfies ReadonlyArray<
      readonly [string, ProviderOperationRecord, ProviderOperationReconciliationEvidence, string]
    >;
    for (const [name, record, evidence, expected] of cases) {
      expect(providerOperationTerminationVerdict(record, evidence).kind, name).toBe(expected);
    }

    const record = providerOperationRecord('activation-resolution-pending');
    const diagnosticsChanged = {
      ...record,
      retryNotBeforeMs: 99_999,
      retryCount: 8,
      lastError: { observedAtMs: 50, code: 'timeout', message: 'transport timeout' },
    };
    const evidence = { kind: 'containment-disappeared', disappearanceReceipt: 'gone' } as const;
    expect(providerOperationTerminationVerdict(diagnosticsChanged, evidence)).toEqual(
      providerOperationTerminationVerdict(record, evidence),
    );
  });
});

describe('ProviderOperationReconciler', () => {
  it('stays passive until driven, dispatches proof, and retains unresolved work', async () => {
    const record = providerOperationRecord('prestart-cleanup-pending');
    const readDue = vi.fn(() => [record]);
    const drive = vi.fn(async () => ({
      kind: 'released-never-started' as const,
      prepareAttemptKey: record.prepareAttemptKey,
    }));
    const terminations = terminationSpies();
    const reconciler = new ProviderOperationReconciler({
      journal: { readDue },
      driver: { drive },
      terminations,
      batchSize: 7,
    });

    expect(readDue).not.toHaveBeenCalled();
    expect(drive).not.toHaveBeenCalled();

    const results = await reconciler.reconcileDue(123);

    expect(readDue).toHaveBeenCalledWith(123, 7);
    expect(drive).toHaveBeenCalledWith(record);
    expect(results[0]?.verdict).toEqual({ kind: 'released-never-started' });
    expect(terminations.releasedNeverStarted).toHaveBeenCalledWith(record);
    expect(terminations.executing).not.toHaveBeenCalled();
    expect(terminations.releasedAfterTerminal).not.toHaveBeenCalled();
    expect(terminations.indeterminateActivation).not.toHaveBeenCalled();

    const unresolvedRecord = providerOperationRecord('prepare-pending');
    const unresolvedTerminations = terminationSpies();
    const unresolvedReconciler = new ProviderOperationReconciler({
      journal: { readDue: () => [] },
      driver: { drive: async () => ({ kind: 'unresolved' }) },
      terminations: unresolvedTerminations,
    });

    await expect(unresolvedReconciler.reconcile(unresolvedRecord)).resolves.toMatchObject({
      verdict: { kind: 'pending' },
    });
    for (const termination of Object.values(unresolvedTerminations)) expect(termination).not.toHaveBeenCalled();
  });
});
