import type { EngineManifest } from '#src/expansion/contract.js';
import type { RetrievalRoleDescriptor } from '#src/kb/search/contract.js';

export const dummyRetrievalRoleDescriptor = {
  id: 'dummy',
  label: 'Dummy Test Role',
  tags: ['lexical'],
  phase: 'retrieval-source',
  supportsScopes: ['notes', 'sources', 'all'],
  provides: 'retrieval-source',
} as const satisfies RetrievalRoleDescriptor;

export const dummyRetrievalRoleManifest = {
  id: 'dummy-retrieval-role',
  version: '0.0.0',
  specifier: '#tests/fixtures/dummy-retrieval-role/expansion.js',
  tier: 'installed',
  description: 'Dummy retrieval role fixture for expansion role registration tests.',
  provides: [dummyRetrievalRoleDescriptor],
} as const satisfies EngineManifest;

export default dummyRetrievalRoleManifest;
