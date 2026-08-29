import type { TimePort } from '../../../infra/port-types.js';
import type { IdPort } from '../../../runtime/ports.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '../../../recovery/source-registry.js';
import {
  unreadableProviderOperationSubject,
  type UnreadableProviderOperationDiscardRequest,
  type UnreadableProviderOperationDiscardResult,
} from '../../../recovery/unreadable-provider-operation.js';
import { RecoveryQuarantineStore } from '../../../recovery/quarantine.js';
import type { Database } from '../../../store/db.js';
import { discardUnreadableProviderOperationWithRecoveryAuthority } from '../../../store/provider-operation-journal.js';

/** What claiming the quarantine can answer with instead of taking ownership. Named so the generic refusal
 *  is not inferred from whichever branch the compiler reads first. */
type UnreadableProviderOperationDiscardOwnershipRefusal =
  | Readonly<{ kind: 'quarantine-not-found' }>
  | Readonly<{ kind: 'revision-mismatch'; currentRevision: string }>
  | Readonly<{ kind: 'owned'; state: 'retrying' | 'continuation' }>;

/** Recovery-owned destructive operation for one exact unreadable provider-operation quarantine. */
export interface UnreadableProviderOperationDiscardService {
  discard(request: UnreadableProviderOperationDiscardRequest): UnreadableProviderOperationDiscardResult;
}

/** Dependencies that bind discard ownership and quarantine evidence to one writable store. */
export type UnreadableProviderOperationDiscardServiceOptions = Readonly<{
  instanceId: string;
  ids: Pick<IdPort, 'uuid'>;
  db: Database;
  time: Pick<TimePort, 'now'>;
}>;

/** Creates the sole runtime owner of raw unreadable provider-operation discard. */
export function createUnreadableProviderOperationDiscardService(
  options: UnreadableProviderOperationDiscardServiceOptions,
): UnreadableProviderOperationDiscardService {
  if (options.instanceId.length === 0) throw new Error('Provider-operation discard owner must be non-empty');
  const quarantine = new RecoveryQuarantineStore(options.db, options.time);

  return {
    discard(request) {
      const subject = unreadableProviderOperationSubject(request.key, request.revision);
      const result =
        discardUnreadableProviderOperationWithRecoveryAuthority<UnreadableProviderOperationDiscardOwnershipRefusal>(
          options.db,
          request.key,
          request.revision,
          {
            claim() {
              const current = quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, request.key);
              if (current === null) {
                return { kind: 'refused', result: { kind: 'quarantine-not-found' as const } };
              }
              if (
                current.subject.revision.kind !== 'fingerprint' ||
                current.subject.revision.value !== subject.revision.value
              ) {
                return current.subject.revision.kind === 'fingerprint'
                  ? {
                      kind: 'refused',
                      result: {
                        kind: 'revision-mismatch' as const,
                        currentRevision: current.subject.revision.value,
                      },
                    }
                  : { kind: 'refused', result: { kind: 'quarantine-not-found' as const } };
              }
              if (current.state === 'retrying' || current.state === 'continuation') {
                return { kind: 'refused', result: { kind: 'owned' as const, state: current.state } };
              }

              const token = options.ids.uuid();
              if (token.length === 0) throw new Error('Provider-operation discard token must be non-empty');
              const retry = { owner: options.instanceId, token };
              if (
                !quarantine.claimRetry({
                  boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
                  subject,
                  retry,
                })
              ) {
                throw new Error('provider_operation_discard_authority_lost_before_raw_delete');
              }
              return {
                kind: 'claimed',
                settle: (rawResult) =>
                  rawResult.kind === 'discarded'
                    ? quarantine.delete({
                        boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
                        subject,
                        expectedRetry: retry,
                      })
                    : quarantine.releaseRetry({
                        boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
                        subject,
                        expectedRetry: retry,
                      }),
              };
            },
          },
        );
      return { ...request, ...result };
    },
  };
}
