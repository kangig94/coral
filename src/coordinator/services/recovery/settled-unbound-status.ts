import { errorMessage } from '../../../infra/error-format.js';
import { sha256Hex } from '../../../infra/hash.js';
import type { TimePort } from '../../../infra/port-types.js';
import type {
  ProviderOperationBindingIdentity,
  SettledUnboundStatusOwnership,
  SettledUnboundStatusPort,
  SettledUnboundStatusResult,
  SettledUnboundStatusSubject,
} from '../../../jobs/contracts/provider-operation-lifecycle.js';
import { SETTLED_UNBOUND_STATUS_BOUNDARY } from '../../../recovery/source-registry.js';
import { RecoveryQuarantineStore } from '../../../recovery/quarantine.js';
import type { Database } from '../../../store/db.js';
import { providerOperationRecordKeyPrefix, readProviderOperations } from '../../../store/provider-operation-journal.js';

export const MAX_SETTLED_UNBOUND_STATUS_ENTRIES = 1_024;

const STATUS_ERROR_PREFIX = 'Provider operation settlement journal probe remained unknown';
const STATUS_SUBJECT_PREFIX = 'settled-unbound:';

function statusError(identity: ProviderOperationBindingIdentity): string {
  return `${STATUS_ERROR_PREFIX} for job '${identity.jobId}' operation '${identity.operationId}'.`;
}

export function settledUnboundStatusSubject(identity: ProviderOperationBindingIdentity): SettledUnboundStatusSubject {
  const encodedIdentity = JSON.stringify([identity.jobId, identity.operationId]);
  return {
    boundary: SETTLED_UNBOUND_STATUS_BOUNDARY,
    key: `${STATUS_SUBJECT_PREFIX}${encodedIdentity}`,
    revision: `sha256:${sha256Hex(encodedIdentity)}`,
    state: 'active',
  };
}

function sameIdentity(left: ProviderOperationBindingIdentity, right: ProviderOperationBindingIdentity): boolean {
  return left.jobId === right.jobId && left.operationId === right.operationId;
}

function sameSubject(left: SettledUnboundStatusSubject, right: SettledUnboundStatusSubject): boolean {
  return (
    left.boundary === right.boundary &&
    left.key === right.key &&
    left.revision === right.revision &&
    left.state === right.state
  );
}

export function matchingSettledUnboundRecordKeys(
  db: Database,
  identity: ProviderOperationBindingIdentity,
): readonly string[] {
  const scan = readProviderOperations(db);
  const keyPrefix = `${providerOperationRecordKeyPrefix(identity.jobId)}${identity.operationId}:`;
  return [
    ...scan.records
      .filter(
        (record) => record.operation.jobId === identity.jobId && record.operation.operationId === identity.operationId,
      )
      .map((record) => `${keyPrefix}${record.operation.proxyInstanceId}:${record.operation.buildSetId}`),
    ...scan.unreadableKeys.filter((key) => key.startsWith(keyPrefix)),
  ];
}

function statusDetail(recordKeys: readonly string[] | null, scanFailure: string | null): string {
  const exit =
    'Run coral-cli backend shutdown, then retry any Coral command; startup reconstructs this ownership and resumes its exact journal probe.';
  if (recordKeys === null) {
    return `The journal scan failed (${scanFailure ?? 'unknown failure'}). Restore journal access. ${exit}`;
  }
  return `Matching provider-operation rows remain unresolved: ${recordKeys.join(', ')}. ${exit}`;
}

function mintOwnership(
  identity: ProviderOperationBindingIdentity,
  subjects: readonly SettledUnboundStatusSubject[],
): SettledUnboundStatusOwnership {
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    subjects: Object.freeze([...subjects]),
  }) as SettledUnboundStatusOwnership;
}

function identityFromStatusSubject(subject: SettledUnboundStatusSubject): ProviderOperationBindingIdentity | null {
  if (!subject.key.startsWith(STATUS_SUBJECT_PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(subject.key.slice(STATUS_SUBJECT_PREFIX.length));
    if (!Array.isArray(value) || value.length !== 2 || value.some((part) => typeof part !== 'string')) return null;
    const [jobId, operationId] = value as [string, string];
    const identity = { jobId, operationId };
    return sameSubject(subject, settledUnboundStatusSubject(identity)) ? identity : null;
  } catch {
    return null;
  }
}

type StatusClearDisposition =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'deleted' }>
  | Readonly<{ kind: 'refused' }>;

function clearStatusSubject(
  quarantine: RecoveryQuarantineStore,
  subject: SettledUnboundStatusSubject,
): StatusClearDisposition {
  const current = quarantine.read(subject.boundary, subject.key);
  if (current === null) return { kind: 'absent' };
  if (
    current.boundary !== SETTLED_UNBOUND_STATUS_BOUNDARY ||
    current.state !== subject.state ||
    current.subject.key !== subject.key ||
    current.subject.revision.kind !== 'fingerprint' ||
    current.subject.revision.value !== subject.revision
  ) {
    return { kind: 'refused' };
  }
  return quarantine.delete({
    boundary: SETTLED_UNBOUND_STATUS_BOUNDARY,
    subject: {
      key: subject.key,
      revision: { kind: 'fingerprint', value: subject.revision },
    },
  })
    ? { kind: 'deleted' }
    : { kind: 'refused' };
}

function materializeActionableStatus(
  quarantine: RecoveryQuarantineStore,
  db: Database,
  identity: ProviderOperationBindingIdentity,
): SettledUnboundStatusResult {
  let recordKeys: readonly string[] | null = null;
  let scanFailure: string | null = null;
  try {
    recordKeys = matchingSettledUnboundRecordKeys(db, identity);
    if (recordKeys.length === 0) return { kind: 'absent' };
  } catch (error: unknown) {
    scanFailure = errorMessage(error);
  }

  const subject = settledUnboundStatusSubject(identity);
  const existing = quarantine.read(subject.boundary, subject.key);
  if (existing === null) {
    const retained = quarantine.list().filter((entry) => entry.boundary === SETTLED_UNBOUND_STATUS_BOUNDARY).length;
    if (retained >= MAX_SETTLED_UNBOUND_STATUS_ENTRIES) {
      return { kind: 'refused', reason: 'The durable unsettled settlement status is at capacity.' };
    }
  } else if (
    existing.state !== subject.state ||
    existing.subject.revision.kind !== 'fingerprint' ||
    existing.subject.revision.value !== subject.revision
  ) {
    return { kind: 'refused', reason: 'The durable unsettled settlement status is owned by another state.' };
  }

  const persisted = quarantine.upsert({
    boundary: subject.boundary,
    subject: {
      key: subject.key,
      revision: { kind: 'fingerprint', value: subject.revision },
    },
    state: subject.state,
    stage: 'settle',
    errorMessage: statusError(identity),
    detail: statusDetail(recordKeys, scanFailure),
  });
  if (!persisted) {
    return { kind: 'refused', reason: 'The durable unsettled settlement status did not persist.' };
  }
  return { kind: 'recorded', ownership: mintOwnership(identity, [subject]) };
}

function clearOwnedStatuses(
  quarantine: RecoveryQuarantineStore,
  identity: ProviderOperationBindingIdentity,
  ownership: SettledUnboundStatusOwnership,
): boolean {
  if (!sameIdentity(identity, ownership.identity)) return false;
  const expectedSubject = settledUnboundStatusSubject(identity);
  const [subject] = ownership.subjects;
  if (ownership.subjects.length !== 1 || subject === undefined || !sameSubject(subject, expectedSubject)) {
    return false;
  }

  return clearStatusSubject(quarantine, subject).kind === 'deleted';
}

export function createSettledUnboundStatusPort(
  getDb: () => Database,
  time: Pick<TimePort, 'now'>,
): SettledUnboundStatusPort {
  return {
    record(identity): SettledUnboundStatusResult {
      try {
        const db = getDb();
        return materializeActionableStatus(new RecoveryQuarantineStore(db, time), db, identity);
      } catch (error: unknown) {
        return { kind: 'refused', reason: errorMessage(error) };
      }
    },
    rebind(subject): SettledUnboundStatusOwnership | null {
      try {
        const identity = identityFromStatusSubject(subject);
        if (identity === null) return null;
        const current = new RecoveryQuarantineStore(getDb(), time).read(subject.boundary, subject.key);
        if (
          current === null ||
          current.boundary !== subject.boundary ||
          current.subject.revision.kind !== 'fingerprint' ||
          current.subject.revision.value !== subject.revision
        ) {
          return null;
        }
        return mintOwnership(identity, [subject]);
      } catch {
        return null;
      }
    },
    clear(identity, ownership): boolean {
      try {
        return clearOwnedStatuses(new RecoveryQuarantineStore(getDb(), time), identity, ownership);
      } catch {
        return false;
      }
    },
    clearAbsent(identity): boolean {
      try {
        return (
          clearStatusSubject(new RecoveryQuarantineStore(getDb(), time), settledUnboundStatusSubject(identity)).kind !==
          'refused'
        );
      } catch {
        return false;
      }
    },
    clearRefusal(): void {},
  };
}
