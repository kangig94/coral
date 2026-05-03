import { canonicalizeCapabilityName, type KbCapabilityDescriptor } from './contract.js';

export const KB_FTS_CAPABILITY = canonicalizeCapabilityName('kb.fts');
export const KB_VECTOR_CAPABILITY = canonicalizeCapabilityName('kb.vector');
export const KB_EMBEDDING_CAPABILITY = canonicalizeCapabilityName('kb.embedding');

export const BUILTIN_FTS_CAPABILITY_DESCRIPTOR = Object.freeze({
  name: KB_FTS_CAPABILITY,
  typeTag: 'fts-retrieval',
  namespace: 'kb',
} satisfies KbCapabilityDescriptor);

export const BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR = Object.freeze({
  name: KB_VECTOR_CAPABILITY,
  typeTag: 'vector-retrieval',
  namespace: 'kb',
} satisfies KbCapabilityDescriptor);

export const BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR = Object.freeze({
  name: KB_EMBEDDING_CAPABILITY,
  typeTag: 'embedding-service',
  namespace: 'kb',
} satisfies KbCapabilityDescriptor);
