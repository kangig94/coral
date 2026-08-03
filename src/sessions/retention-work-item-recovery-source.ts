import { hasUnterminalRetentionDiscardRequest, type ProviderSession } from './entry.js';
import { deriveProviderArtifactSourceRevision } from './provider-artifact-archive.js';
import {
  canonicalRecoveryRevision,
  compositeRecoveryRevision,
  defineCompositeRecoverySource,
  type RecoveryReceipt,
  type RecoveryReceiptValue,
  type RecoveryRevisionDependency,
  type RecoveryRevisionField,
  type RecoverySource,
  type RecoverySubject,
} from '../recovery/containment.js';
import {
  continuationRevisionFields,
  eventRevisionFields,
  projectionSessionRevisionFields,
} from '../recovery/row-revision-fields.js';
import type { RetentionReleasePairComponent } from './retention-release-pair-recovery-source.js';
import type { SessionContinuationLeaseComponent } from './continuation-lease-recovery-source.js';
import type { RawRetentionContinuationRow, SessionProjectionComponent } from './projection-recovery-source.js';
import type { TerminalRetentionOutcomeComponent } from './terminal-retention-outcome-recovery-source.js';

const RETENTION_WORK_BOUNDARY = 'session-retention-work';

export type P4RetentionComponent =
  | SessionProjectionComponent
  | SessionContinuationLeaseComponent
  | TerminalRetentionOutcomeComponent
  | RetentionReleasePairComponent;

export type RawRetentionWorkItem = {
  readonly sessionId: string;
  readonly jobId: string;
  readonly entry: ProviderSession;
  readonly session: SessionProjectionComponent;
  readonly lease: SessionContinuationLeaseComponent | null;
  readonly release: Extract<RetentionReleasePairComponent, { kind: 'release' }>;
  readonly terminal: Extract<RetentionReleasePairComponent, { kind: 'terminal' }>;
  readonly outcomes: readonly TerminalRetentionOutcomeComponent[];
  readonly continuation: RawRetentionContinuationRow | null;
  readonly sourceRevision: string;
  readonly subject: RecoverySubject;
};

type ReceiptValue<T extends P4RetentionComponent = P4RetentionComponent> = RecoveryReceiptValue<T>;

type ComposedRetentionWorkReceipts = {
  readonly sessions: readonly ReceiptValue<SessionProjectionComponent>[];
  readonly leases: ReadonlyMap<string, ReceiptValue<SessionContinuationLeaseComponent>>;
  readonly outcomesBySession: ReadonlyMap<string, readonly ReceiptValue<TerminalRetentionOutcomeComponent>[]>;
  readonly releasesByPair: ReadonlyMap<
    string,
    ReceiptValue<Extract<RetentionReleasePairComponent, { kind: 'release' }>>
  >;
  readonly terminalsByPair: ReadonlyMap<
    string,
    ReceiptValue<Extract<RetentionReleasePairComponent, { kind: 'terminal' }>>
  >;
};

function workKey(sessionId: string, jobId: string): string {
  return `${sessionId}\u0000${jobId}`;
}

function operationRevisionFields(input: {
  readonly session: SessionProjectionComponent;
  readonly lease: SessionContinuationLeaseComponent | null;
  readonly release: RetentionReleasePairComponent;
  readonly terminal: RetentionReleasePairComponent;
  readonly outcomes: readonly TerminalRetentionOutcomeComponent[];
  readonly entry: ProviderSession;
  readonly jobId: string;
}): RecoveryRevisionField[] {
  const { row } = input.session;
  const key = row.session_id;
  const fields: RecoveryRevisionField[] = [
    ...projectionSessionRevisionFields(row),
    { table: 'retention_work', key: workKey(key, input.jobId), field: 'session_id', value: key },
    { table: 'retention_work', key: workKey(key, input.jobId), field: 'job_id', value: input.jobId },
    {
      table: 'retention_work',
      key: workKey(key, input.jobId),
      field: 'retention_attempts',
      value: JSON.stringify(input.entry.retentionDiscard.attempts),
    },
    {
      table: 'retention_work',
      key: workKey(key, input.jobId),
      field: 'artifact_handles',
      value: JSON.stringify(input.entry.artifactHandles),
    },
    {
      table: 'retention_work',
      key: workKey(key, input.jobId),
      field: 'continuation_lease',
      value: JSON.stringify(input.entry.continuationLease ?? null),
    },
  ];
  if (input.lease !== null) {
    fields.push({
      table: 'retention_work',
      key: workKey(key, input.jobId),
      field: 'lease_projection_last_seq',
      value: input.lease.row.last_seq,
    });
  }
  fields.push(...eventRevisionFields(input.release.row), ...eventRevisionFields(input.terminal.row));
  for (const outcome of input.outcomes) fields.push(...eventRevisionFields(outcome.row));
  return fields;
}

function composeRetentionWorkItemReceipts(
  receipts: readonly RecoveryReceiptValue<P4RetentionComponent>[],
): ComposedRetentionWorkReceipts {
  const sessions: ReceiptValue<SessionProjectionComponent>[] = [];
  const leases = new Map<string, ReceiptValue<SessionContinuationLeaseComponent>>();
  const outcomesBySession = new Map<string, ReceiptValue<TerminalRetentionOutcomeComponent>[]>();
  const releasesByPair = new Map<string, ReceiptValue<Extract<RetentionReleasePairComponent, { kind: 'release' }>>>();
  const terminalsByPair = new Map<string, ReceiptValue<Extract<RetentionReleasePairComponent, { kind: 'terminal' }>>>();

  for (const receipt of receipts) {
    const component = receipt.payload;
    switch (component.kind) {
      case 'session':
        sessions.push(receipt as ReceiptValue<SessionProjectionComponent>);
        break;
      case 'lease':
        leases.set(component.row.session_id, receipt as ReceiptValue<SessionContinuationLeaseComponent>);
        break;
      case 'terminal-outcome': {
        const outcomes = outcomesBySession.get(component.sessionId) ?? [];
        outcomes.push(receipt as ReceiptValue<TerminalRetentionOutcomeComponent>);
        outcomesBySession.set(component.sessionId, outcomes);
        break;
      }
      case 'release':
        releasesByPair.set(
          workKey(component.sessionId, component.jobId),
          receipt as ReceiptValue<Extract<RetentionReleasePairComponent, { kind: 'release' }>>,
        );
        break;
      case 'terminal':
        terminalsByPair.set(
          workKey(component.sessionId, component.jobId),
          receipt as ReceiptValue<Extract<RetentionReleasePairComponent, { kind: 'terminal' }>>,
        );
        break;
    }
  }
  return { sessions, leases, outcomesBySession, releasesByPair, terminalsByPair };
}

function matchingContinuation(
  session: SessionProjectionComponent,
  sessionId: string,
  jobId: string,
): RawRetentionContinuationRow | null {
  const key = workKey(sessionId, jobId);
  return session.retentionContinuations.find((continuation) => continuation.subject_key === key) ?? null;
}

function buildRetentionWorkSubject(input: {
  readonly pairKey: string;
  readonly operationFields: readonly RecoveryRevisionField[];
  readonly continuation: RawRetentionContinuationRow | null;
  readonly sessionReceipt: ReceiptValue<SessionProjectionComponent>;
  readonly leaseReceipt: ReceiptValue<SessionContinuationLeaseComponent> | undefined;
  readonly releaseReceipt: ReceiptValue<Extract<RetentionReleasePairComponent, { kind: 'release' }>>;
  readonly terminalReceipt: ReceiptValue<Extract<RetentionReleasePairComponent, { kind: 'terminal' }>>;
  readonly outcomes: readonly ReceiptValue<TerminalRetentionOutcomeComponent>[];
}): RecoverySubject {
  const operationRevision = canonicalRecoveryRevision(input.operationFields);
  if (operationRevision.kind !== 'fingerprint') {
    throw new Error('Retention work operation revision is not fingerprinted.');
  }
  const dependencies: RecoveryRevisionDependency[] = [
    { source: 'session-projection', subject: input.sessionReceipt.subject },
    ...(input.leaseReceipt === undefined
      ? []
      : [{ source: 'session-continuation-lease', subject: input.leaseReceipt.subject }]),
    { source: 'retention-release', subject: input.releaseReceipt.subject },
    { source: 'job-terminal', subject: input.terminalReceipt.subject },
    ...input.outcomes.map((outcome) => ({
      source: 'terminal-retention-outcome',
      subject: outcome.subject,
    })),
  ];
  const revisionFields = [...input.operationFields];
  if (input.continuation !== null) {
    revisionFields.push(
      ...continuationRevisionFields(RETENTION_WORK_BOUNDARY, input.continuation.subject_key, input.continuation),
    );
  }
  return {
    key: input.pairKey,
    revision: compositeRecoveryRevision(revisionFields, dependencies),
  };
}

function buildRetentionWorkItem(input: {
  readonly composed: ComposedRetentionWorkReceipts;
  readonly sessionReceipt: ReceiptValue<SessionProjectionComponent>;
  readonly leaseReceipt: ReceiptValue<SessionContinuationLeaseComponent> | undefined;
  readonly outcomes: readonly ReceiptValue<TerminalRetentionOutcomeComponent>[];
  readonly entry: ProviderSession;
  readonly pairKey: string;
  readonly releaseReceipt: ReceiptValue<Extract<RetentionReleasePairComponent, { kind: 'release' }>>;
}): RawRetentionWorkItem | null {
  const { composed, sessionReceipt, leaseReceipt, outcomes, entry, pairKey, releaseReceipt } = input;
  const session = sessionReceipt.payload;
  const sessionId = session.row.session_id;
  if (releaseReceipt.payload.sessionId !== sessionId) return null;

  const terminalReceipt = composed.terminalsByPair.get(pairKey);
  if (terminalReceipt === undefined) return null;

  const lease = leaseReceipt?.payload ?? null;
  const { jobId } = releaseReceipt.payload;
  const continuation = matchingContinuation(session, sessionId, jobId);
  if (hasUnterminalRetentionDiscardRequest(entry) && continuation === null) return null;

  const outcomeComponents = outcomes.map(({ payload }) => payload);
  const operationFields = operationRevisionFields({
    session,
    lease,
    release: releaseReceipt.payload,
    terminal: terminalReceipt.payload,
    outcomes: outcomeComponents,
    entry,
    jobId,
  });
  const subject = buildRetentionWorkSubject({
    pairKey,
    operationFields,
    continuation,
    sessionReceipt,
    leaseReceipt,
    releaseReceipt,
    terminalReceipt,
    outcomes,
  });
  return {
    sessionId,
    jobId,
    entry: releaseReceipt.payload.entry,
    session,
    lease,
    release: releaseReceipt.payload,
    terminal: terminalReceipt.payload,
    outcomes: outcomeComponents,
    continuation,
    sourceRevision: deriveProviderArtifactSourceRevision({
      sessionId,
      jobId,
      release: releaseReceipt.payload.row,
      terminal: terminalReceipt.payload.row,
    }),
    subject,
  };
}

function scanRetentionWorkRows(
  composed: ComposedRetentionWorkReceipts,
  subjectKey?: string,
): readonly RawRetentionWorkItem[] {
  const rows: RawRetentionWorkItem[] = [];
  for (const sessionReceipt of composed.sessions) {
    const session = sessionReceipt.payload;
    const sessionId = session.row.session_id;
    const leaseReceipt = composed.leases.get(sessionId);
    if (session.hasContinuationLeaseField && leaseReceipt === undefined) continue;
    const lease = leaseReceipt?.payload ?? null;
    const entry = lease?.effectiveEntry ?? session.entry;
    const outcomes = composed.outcomesBySession.get(sessionId) ?? [];
    if (
      entry.retention !== 'discard_provider_artifacts_on_terminal' ||
      entry.activeJobId !== undefined ||
      lease?.protectsRetention === true ||
      outcomes.some(({ payload }) => payload.terminal)
    ) {
      continue;
    }

    for (const [pairKey, releaseReceipt] of composed.releasesByPair) {
      const row = buildRetentionWorkItem({
        composed,
        sessionReceipt,
        leaseReceipt,
        outcomes,
        entry,
        pairKey,
        releaseReceipt,
      });
      if (row !== null && (subjectKey === undefined || row.subject.key === subjectKey)) rows.push(row);
    }
  }
  return rows;
}

/** Creates the sole registered P4 composite from boundary-issued component receipts. */
export function retentionWorkItemRecoverySource(
  receipts: readonly RecoveryReceipt<P4RetentionComponent>[],
  subject?: RecoverySubject,
): RecoverySource<RawRetentionWorkItem> {
  return defineCompositeRecoverySource(receipts, {
    boundary: RETENTION_WORK_BOUNDARY,
    scanSubject: subject ?? { key: 'session-retention-work-composition', revision: { kind: 'until-cleared' } },
    scan: (values) => scanRetentionWorkRows(composeRetentionWorkItemReceipts(values), subject?.key),
    subject: (raw) => raw.subject,
  });
}
