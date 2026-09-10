import type { TimePort } from '../../../infra/port-types.js';
import { sha256Hex } from '../../../infra/hash.js';
import type { IdPort } from '../../../runtime/ports.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '../../../recovery/source-registry.js';
import {
  unreadableProviderOperationSubject,
  type UnreadableProviderOperationDiscardRequest,
  type UnreadableProviderOperationDiscardResult,
} from '../../../recovery/unreadable-provider-operation.js';
import { RecoveryQuarantineStore } from '../../../recovery/quarantine.js';
import { withImmediate, type Database } from '../../../store/db.js';
import {
  deleteProviderOperation,
  discardUnreadableProviderOperationWithRecoveryAuthority,
  observeProviderOperationRecord,
} from '../../../store/provider-operation-journal.js';
import {
  encodeProviderOperationRecord,
  type ProviderOperationRecord,
} from '../../../store/provider-operation-record.js';

type UnreadableProviderOperationDiscardOwnershipRefusalKind = 'quarantine-not-found' | 'revision-mismatch' | 'owned';

type UnreadableProviderOperationDiscardOwnershipRefusal = {
  [Kind in UnreadableProviderOperationDiscardOwnershipRefusalKind]: Omit<
    Extract<UnreadableProviderOperationDiscardResult, { kind: Kind }>,
    keyof UnreadableProviderOperationDiscardRequest
  >;
}[UnreadableProviderOperationDiscardOwnershipRefusalKind];

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

/** Requires an exact unowned quarantine subject before the raw row and its evidence can be deleted atomically. */
export function createUnreadableProviderOperationDiscardService(
  options: UnreadableProviderOperationDiscardServiceOptions,
): UnreadableProviderOperationDiscardService {
  if (options.instanceId.length === 0) throw new Error('Provider-operation discard owner must be non-empty');
  const quarantine = new RecoveryQuarantineStore(options.db, options.time);

  /** Raw-row observation and mutation require exclusive ownership of the exact active quarantine revision. */
  const claim = (key: string, revision: string) => {
    const subject = unreadableProviderOperationSubject(key, revision);
    const current = quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, key);
    if (current === null) {
      return { kind: 'refused' as const, result: { kind: 'quarantine-not-found' as const } };
    }
    if (current.subject.revision.kind !== 'fingerprint' || current.subject.revision.value !== subject.revision.value) {
      return current.subject.revision.kind === 'fingerprint'
        ? {
            kind: 'refused' as const,
            result: {
              kind: 'revision-mismatch' as const,
              currentRevision: current.subject.revision.value,
            },
          }
        : { kind: 'refused' as const, result: { kind: 'quarantine-not-found' as const } };
    }
    if (current.state === 'retrying' || current.state === 'continuation') {
      return { kind: 'refused' as const, result: { kind: 'owned' as const, state: current.state } };
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
      kind: 'claimed' as const,
      settle: (result: Readonly<{ kind: string }>) =>
        result.kind === 'discarded'
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
  };

  const readableRevision = (record: ProviderOperationRecord): string =>
    `sha256:${sha256Hex(encodeProviderOperationRecord(record))}`;

  /** Readable deletion and quarantine settlement must commit from the same fingerprint observation. */
  const discardReadable = (
    request: UnreadableProviderOperationDiscardRequest,
    key: string,
  ): UnreadableProviderOperationDiscardResult =>
    withImmediate(options.db, () => {
      const authority = claim(key, request.revision);
      if (authority.kind === 'refused') return { ...request, ...authority.result };

      const observation = observeProviderOperationRecord(options.db, key);
      const result = (() => {
        if (observation.kind === 'absent') return { kind: 'absent' as const };
        if (observation.kind === 'unreadable') {
          return { kind: 'revision-mismatch' as const, currentRevision: observation.attribution.revision };
        }
        const currentRevision = readableRevision(observation.record);
        if (currentRevision !== request.revision) {
          return { kind: 'revision-mismatch' as const, currentRevision };
        }
        const deletion = deleteProviderOperation(options.db, observation.record);
        if (deletion.kind === 'deleted') return { kind: 'discarded' as const };
        return deletion.current === null
          ? { kind: 'absent' as const }
          : { kind: 'revision-mismatch' as const, currentRevision: readableRevision(deletion.current) };
      })();
      if (!authority.settle(result)) throw new Error('provider_operation_discard_recovery_authority_lost');
      return { ...request, ...result };
    });

  return {
    discard(request) {
      if (request.allowReadable === true) return discardReadable(request, request.key);
      const result =
        discardUnreadableProviderOperationWithRecoveryAuthority<UnreadableProviderOperationDiscardOwnershipRefusal>(
          options.db,
          request.key,
          request.revision,
          {
            claim: () => claim(request.key, request.revision),
          },
        );
      return { ...request, ...result };
    },
  };
}
