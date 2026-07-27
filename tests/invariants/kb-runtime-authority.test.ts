import { describe, expect, it } from 'vitest';

import {
  KB_RUNTIME_AUTHORITY,
  KB_RUNTIME_EXACT_AUTHORITIES,
  KB_RUNTIME_PATTERNED_AUTHORITIES,
} from '#src/runtime/kb-runtime-authority.js';

const expectedAuthorities = {
  orama: 'orama',
  corpusProjection: 'corpus-projection',
  generatedCommunityProjection: 'generated-community-projection',
  sourceImportStaging: 'source-import-staging',
  sourceImportPdf: 'source-import-pdf',
  promoteRecovery: 'promote-recovery',
  migrations: 'migrations',
  mutationLock: 'mutation.lock',
  index: 'index.json',
  indexState: 'index-state.json',
  touchJournal: 'wiki-touches.jsonl',
  touchJournalTombstone: 'wiki-touches.jsonl.tombstone',
  touchJournalProgress: 'wiki-touches.jsonl.progress.json',
} as const;

describe('KB runtime top-level authority registry', () => {
  it('pins the complete exact and patterned reservation set', () => {
    expect(KB_RUNTIME_AUTHORITY).toEqual(expectedAuthorities);
    expect([...KB_RUNTIME_EXACT_AUTHORITIES].sort()).toEqual(Object.values(expectedAuthorities).sort());
    expect(KB_RUNTIME_PATTERNED_AUTHORITIES.map(String)).toEqual([String(/^wiki-touches\.orphan\..+\.jsonl$/u)]);
  });
});
