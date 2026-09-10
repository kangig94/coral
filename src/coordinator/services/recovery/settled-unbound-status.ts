import { errorMessage } from '../../../infra/error-format.js';
import { sha256Hex } from '../../../infra/hash.js';
import type { TimePort } from '../../../infra/port-types.js';
import type {
  ProviderOperationBindingIdentity,
  SettledUnboundStatusPort,
  SettledUnboundStatusResult,
} from '../../../jobs/contracts/provider-operation-lifecycle.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '../../../recovery/source-registry.js';
import { unreadableProviderOperationSubject } from '../../../recovery/unreadable-provider-operation.js';
import { RecoveryQuarantineStore, type RecoveryQuarantineEntry } from '../../../recovery/quarantine.js';
import type { Database } from '../../../store/db.js';
import {
  attributeUnreadableProviderOperations,
  providerOperationRecordKeyPrefix,
  readProviderOperations,
} from '../../../store/provider-operation-journal.js';
import { encodeProviderOperationRecord } from '../../../store/provider-operation-record.js';

export const MAX_SETTLED_UNBOUND_STATUS_ENTRIES = 1_024;

const STATUS_ERROR_PREFIX = 'Provider operation settlement journal probe remained unknown';

function statusError(identity: ProviderOperationBindingIdentity): string {
  return `${STATUS_ERROR_PREFIX} for job '${identity.jobId}' operation '${identity.operationId}'.`;
}

function belongsToStatus(entry: RecoveryQuarantineEntry, identity: ProviderOperationBindingIdentity): boolean {
  return entry.errorMessage === statusError(identity);
}

function materializeActionableStatuses(
  quarantine: RecoveryQuarantineStore,
  db: Database,
  identity: ProviderOperationBindingIdentity,
): SettledUnboundStatusResult {
  const scan = readProviderOperations(db);
  const keyPrefix = `${providerOperationRecordKeyPrefix(identity.jobId)}${identity.operationId}:`;
  const readable = scan.records.filter(
    (record) => record.operation.jobId === identity.jobId && record.operation.operationId === identity.operationId,
  );
  const unreadable = attributeUnreadableProviderOperations(
    db,
    scan.unreadableKeys.filter((key) => key.startsWith(keyPrefix)),
  );
  const candidates = [
    ...readable.map((record) => ({
      key: `${keyPrefix}${record.operation.proxyInstanceId}:${record.operation.buildSetId}`,
      revision: `sha256:${sha256Hex(encodeProviderOperationRecord(record))}`,
    })),
    ...unreadable.map(({ key, revision }) => ({ key, revision })),
  ];
  if (candidates.length === 0) return { kind: 'absent' };

  // Ownership of an existing row is decided by its error message, which only the listing carries;
  // a keyed read answers whether a row exists, never whose it is.
  const boundaryEntries = quarantine
    .list()
    .filter((entry) => entry.boundary === UNREADABLE_PROVIDER_OPERATION_BOUNDARY);
  const entriesByKey = new Map(boundaryEntries.map((entry) => [entry.subject.key, entry]));
  const observed = candidates.map((candidate) => ({
    candidate,
    existing: entriesByKey.get(candidate.key) ?? null,
  }));
  const missing = observed.filter(({ existing }) => existing === null);
  const retained = boundaryEntries.filter((entry) => entry.errorMessage.startsWith(STATUS_ERROR_PREFIX)).length;
  if (retained + missing.length > MAX_SETTLED_UNBOUND_STATUS_ENTRIES) {
    return { kind: 'refused', reason: 'The durable unsettled settlement status is at capacity.' };
  }
  for (const { candidate, existing } of observed) {
    if (existing !== null && (!belongsToStatus(existing, identity) || existing.state !== 'active')) continue;
    const persisted = quarantine.upsert({
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject: unreadableProviderOperationSubject(candidate.key, candidate.revision),
      state: 'active',
      stage: 'settle',
      errorMessage: statusError(identity),
      detail:
        'Settlement could not prove whether this row remained present. Reconciliation may settle it; otherwise ' +
        'inspect the row and use the printed discard-provider-operation command, with --allow-readable for a ' +
        'readable row.',
    });
    if (!persisted && existing === null) {
      return { kind: 'refused', reason: 'The durable unsettled settlement status did not persist.' };
    }
  }
  return { kind: 'recorded' };
}

export function createSettledUnboundStatusPort(
  getDb: () => Database,
  time: Pick<TimePort, 'now'>,
): SettledUnboundStatusPort {
  return {
    record(identity): SettledUnboundStatusResult {
      try {
        const db = getDb();
        const quarantine = new RecoveryQuarantineStore(db, time);
        return materializeActionableStatuses(quarantine, db, identity);
      } catch (error: unknown) {
        return { kind: 'refused', reason: errorMessage(error) };
      }
    },
    clear(identity): boolean {
      try {
        const quarantine = new RecoveryQuarantineStore(getDb(), time);
        const owned = quarantine.list().filter((entry) => belongsToStatus(entry, identity));
        for (const entry of owned) {
          if (!quarantine.delete({ boundary: entry.boundary, subject: entry.subject })) return false;
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}
