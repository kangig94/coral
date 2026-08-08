import type { ProviderOperationActivationAck, ProviderOperationRecord } from '../../store/provider-operation-record.js';

export type ProviderOperationReconciliationEvidence =
  | Readonly<{ kind: 'unresolved' }>
  | Readonly<{
      kind: 'activation-ack-replayed';
      activationAck: ProviderOperationActivationAck;
      localRuntimeCommitCompleted: boolean;
    }>
  | Readonly<{ kind: 'released-never-started'; prepareAttemptKey: string }>
  | Readonly<{ kind: 'released-after-terminal'; settledThroughProviderSeq: number }>
  | Readonly<{ kind: 'containment-disappeared'; disappearanceReceipt: string }>;

export type ProviderOperationTerminationVerdict =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'executing'; activationAck: ProviderOperationActivationAck }>
  | Readonly<{ kind: 'released-never-started' }>
  | Readonly<{ kind: 'released-after-terminal' }>
  | Readonly<{ kind: 'indeterminate-activation'; disappearanceReceipt: string }>;

const activationMayHaveBegun = (record: ProviderOperationRecord): boolean =>
  record.phase === 'proxy-activation-pending' || record.phase === 'activation-resolution-pending';

export function providerOperationTerminationVerdict(
  record: ProviderOperationRecord,
  evidence: ProviderOperationReconciliationEvidence,
): ProviderOperationTerminationVerdict {
  if (
    evidence.kind === 'activation-ack-replayed' &&
    evidence.localRuntimeCommitCompleted &&
    activationMayHaveBegun(record)
  ) {
    return { kind: 'executing', activationAck: evidence.activationAck };
  }
  if (
    evidence.kind === 'released-never-started' &&
    record.phase === 'prestart-cleanup-pending' &&
    evidence.prepareAttemptKey === record.prepareAttemptKey
  ) {
    return { kind: 'released-never-started' };
  }
  if (
    evidence.kind === 'released-after-terminal' &&
    record.phase === 'settlement-pending' &&
    evidence.settledThroughProviderSeq >= record.terminalProviderSeq
  ) {
    return { kind: 'released-after-terminal' };
  }
  if (evidence.kind === 'containment-disappeared' && activationMayHaveBegun(record)) {
    return { kind: 'indeterminate-activation', disappearanceReceipt: evidence.disappearanceReceipt };
  }
  return { kind: 'pending' };
}

export interface ProviderOperationReconciliationJournal {
  readDue(nowMs: number, limit: number): readonly ProviderOperationRecord[];
}

export interface ProviderOperationReconciliationDriver {
  drive(record: ProviderOperationRecord): Promise<ProviderOperationReconciliationEvidence>;
}

export interface ProviderOperationReconciliationTerminations {
  executing(record: ProviderOperationRecord, activationAck: ProviderOperationActivationAck): Promise<void>;
  releasedNeverStarted(record: ProviderOperationRecord): Promise<void>;
  releasedAfterTerminal(record: ProviderOperationRecord): Promise<void>;
  indeterminateActivation(record: ProviderOperationRecord, disappearanceReceipt: string): Promise<void>;
}

export type ProviderOperationReconciliationResult = Readonly<{
  record: ProviderOperationRecord;
  evidence: ProviderOperationReconciliationEvidence;
  verdict: ProviderOperationTerminationVerdict;
}>;

export type ProviderOperationReconcilerDeps = Readonly<{
  journal: ProviderOperationReconciliationJournal;
  driver: ProviderOperationReconciliationDriver;
  terminations: ProviderOperationReconciliationTerminations;
  batchSize?: number;
}>;

export class ProviderOperationReconciler {
  readonly #deps: ProviderOperationReconcilerDeps;
  readonly #batchSize: number;

  constructor(deps: ProviderOperationReconcilerDeps) {
    const batchSize = deps.batchSize ?? 32;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new RangeError('batchSize must be a positive safe integer.');
    }
    this.#deps = deps;
    this.#batchSize = batchSize;
  }

  async reconcile(record: ProviderOperationRecord): Promise<ProviderOperationReconciliationResult> {
    const evidence = await this.#deps.driver.drive(record);
    const verdict = providerOperationTerminationVerdict(record, evidence);
    if (verdict.kind === 'executing') {
      await this.#deps.terminations.executing(record, verdict.activationAck);
    } else if (verdict.kind === 'released-never-started') {
      await this.#deps.terminations.releasedNeverStarted(record);
    } else if (verdict.kind === 'released-after-terminal') {
      await this.#deps.terminations.releasedAfterTerminal(record);
    } else if (verdict.kind === 'indeterminate-activation') {
      await this.#deps.terminations.indeterminateActivation(record, verdict.disappearanceReceipt);
    }
    return { record, evidence, verdict };
  }

  async reconcileDue(nowMs: number): Promise<readonly ProviderOperationReconciliationResult[]> {
    const records = this.#deps.journal.readDue(nowMs, this.#batchSize);
    const results: ProviderOperationReconciliationResult[] = [];
    for (const record of records) results.push(await this.reconcile(record));
    return results;
  }
}
