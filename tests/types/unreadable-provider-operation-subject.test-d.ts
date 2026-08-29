import type { UnreadableProviderOperationSubject } from '#src/recovery/unreadable-provider-operation.js';

// @ts-expect-error unreadable-row actions must use the validating key/revision binder, not a structural literal.
const forgedSubject: UnreadableProviderOperationSubject = {
  key: 'provider-operation-key',
  revision: { kind: 'fingerprint', value: `sha256:${'a'.repeat(64)}` },
};
void forgedSubject;
