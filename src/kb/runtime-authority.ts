/**
 * Canonical ownership registry for every Coral-owned top-level artifact under
 * `KbRuntime.runtimeDir`.
 *
 * Keep producers on these constants. Retirement validation depends on this
 * registry to distinguish a retired expansion's legacy `<id>` trees from
 * current KB state.
 */
export const KB_RUNTIME_AUTHORITY = Object.freeze({
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
} as const);

export const KB_RUNTIME_EXACT_AUTHORITIES: ReadonlySet<string> = new Set(Object.values(KB_RUNTIME_AUTHORITY));

export const KB_RUNTIME_PATTERNED_AUTHORITIES: readonly RegExp[] = Object.freeze([
  /^wiki-touches\.orphan\..+\.jsonl$/u,
]);

export function isKbRuntimeAuthority(name: string): boolean {
  return (
    KB_RUNTIME_EXACT_AUTHORITIES.has(name) || KB_RUNTIME_PATTERNED_AUTHORITIES.some((pattern) => pattern.test(name))
  );
}
