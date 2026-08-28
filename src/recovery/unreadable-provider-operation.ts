import type { RecoverySubject } from './containment.js';

const unreadableProviderOperationSubjectBrand: unique symbol = Symbol('unreadable-provider-operation-subject');
const PROVIDER_OPERATION_FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;

/**
 * A validated exact unreadable-row coordinate. The brand prevents CLI and coordinator callers from replacing
 * the store-derived key/revision pair with a hand-assembled recovery subject.
 */
export type UnreadableProviderOperationSubject = Readonly<{
  key: string;
  revision: Readonly<{ kind: 'fingerprint'; value: string }>;
  [unreadableProviderOperationSubjectBrand]: true;
}>;

/**
 * Validates and binds a non-empty durable row key to its canonical current SHA-256 revision. A retry advances
 * only when the same key is observed with a different validated current fingerprint.
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
