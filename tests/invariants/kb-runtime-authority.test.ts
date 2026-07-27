import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  KB_RUNTIME_AUTHORITY,
  KB_RUNTIME_EXACT_AUTHORITIES,
  KB_RUNTIME_PATTERNED_AUTHORITIES,
} from '#src/kb/runtime-authority.js';

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

const producerMappings = [
  ['src/engines/orama/paths.ts', 'KB_RUNTIME_AUTHORITY.orama'],
  ['src/kb/corpus/index/store.ts', 'KB_RUNTIME_AUTHORITY.corpusProjection'],
  ['src/kb/curate/community/generated-projection-store.ts', 'KB_RUNTIME_AUTHORITY.generatedCommunityProjection'],
  ['src/kb/paths.ts', 'KB_RUNTIME_AUTHORITY.sourceImportStaging'],
  ['src/kb/ops/source/import.ts', 'KB_RUNTIME_AUTHORITY.sourceImportPdf'],
  ['src/kb/ops/promote-marker.ts', 'KB_RUNTIME_AUTHORITY.promoteRecovery'],
  ['src/kb/migrations/index.ts', 'KB_RUNTIME_AUTHORITY.migrations'],
  ['src/kb/runtime.ts', 'KB_RUNTIME_AUTHORITY.mutationLock'],
  ['src/kb/corpus/index/store.ts', 'KB_RUNTIME_AUTHORITY.index'],
  ['src/kb/corpus/index/store.ts', 'KB_RUNTIME_AUTHORITY.indexState'],
  ['src/kb/curate/touch-journal.ts', 'KB_RUNTIME_AUTHORITY.touchJournal'],
  ['src/kb/curate/touch-journal.ts', 'KB_RUNTIME_AUTHORITY.touchJournalTombstone'],
  ['src/kb/curate/touch-journal.ts', 'KB_RUNTIME_AUTHORITY.touchJournalProgress'],
] as const;

describe('KB runtime top-level authority registry', () => {
  it('pins the complete exact and patterned reservation set', () => {
    expect(KB_RUNTIME_AUTHORITY).toEqual(expectedAuthorities);
    expect([...KB_RUNTIME_EXACT_AUTHORITIES].sort()).toEqual(Object.values(expectedAuthorities).sort());
    expect(KB_RUNTIME_PATTERNED_AUTHORITIES.map(String)).toEqual([String(/^wiki-touches\.orphan\..+\.jsonl$/u)]);
  });

  it.each(producerMappings)('%s uses %s', (file, authority) => {
    expect(readFileSync(resolve(file), 'utf8')).toContain(authority);
  });
});
