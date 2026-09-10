import type { RecoverySubject } from './containment.js';

const unreadableProviderOperationSubjectBrand: unique symbol = Symbol('unreadable-provider-operation-subject');
const PROVIDER_OPERATION_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const READABLE_DISCARD_SUBJECT_PREFIX = 'readable-provider-operation\u0000';

/**
 * A validated exact unreadable-row coordinate. The brand keeps the canonical key/fingerprint shape distinct
 * from recovery subjects whose revisions have different semantics.
 */
export type UnreadableProviderOperationSubject = Readonly<{
  key: string;
  revision: Readonly<{ kind: 'fingerprint'; value: string }>;
  [unreadableProviderOperationSubjectBrand]: true;
}>;

export type UnreadableProviderOperationDiscardRequest = Readonly<{
  key: string;
  revision: string;
}>;

export type ProviderOperationDiscardCoordinate = Readonly<{
  key: string;
  revision: string;
  allowReadable: boolean;
}>;

/** A destructive discard verdict or an exact recovery-ownership refusal. */
export type UnreadableProviderOperationDiscardResult = UnreadableProviderOperationDiscardRequest &
  (
    | Readonly<{ kind: 'discarded' }>
    | Readonly<{ kind: 'absent' }>
    | Readonly<{ kind: 'revision-mismatch'; currentRevision: string }>
    | Readonly<{ kind: 'readable' }>
    | Readonly<{ kind: 'quarantine-not-found' }>
    | Readonly<{ kind: 'owned'; state: 'retrying' | 'continuation' }>
  );

/** A readable row may be discarded only when the request carries this explicit subject-kind opt-in. */
export function allowReadableProviderOperationDiscard(
  request: UnreadableProviderOperationDiscardRequest,
): UnreadableProviderOperationDiscardRequest {
  return { ...request, key: `${READABLE_DISCARD_SUBJECT_PREFIX}${request.key}` };
}

/** Ownership and release checks must use the durable row key, never its command-level subject tag. */
export function providerOperationDiscardCoordinate(
  request: UnreadableProviderOperationDiscardRequest,
): ProviderOperationDiscardCoordinate {
  const allowReadable = request.key.startsWith(READABLE_DISCARD_SUBJECT_PREFIX);
  return {
    key: allowReadable ? request.key.slice(READABLE_DISCARD_SUBJECT_PREFIX.length) : request.key,
    revision: request.revision,
    allowReadable,
  };
}

/**
 * Validates and binds a non-empty durable row key to a canonical SHA-256 revision coordinate.
 */
export function unreadableProviderOperationSubject(
  key: string,
  revision: string,
): UnreadableProviderOperationSubject & RecoverySubject {
  if (key.length === 0) throw new Error('unreadable_provider_operation_key_invalid');
  if (!PROVIDER_OPERATION_FINGERPRINT.test(revision)) {
    throw new Error('unreadable_provider_operation_revision_invalid');
  }
  return Object.freeze({
    key,
    revision: Object.freeze({ kind: 'fingerprint' as const, value: revision }),
    [unreadableProviderOperationSubjectBrand]: true as const,
  });
}
