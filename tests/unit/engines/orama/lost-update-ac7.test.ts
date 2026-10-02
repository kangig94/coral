import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { OramaBaseProjection } from '#src/engines/orama/base-projection.js';
import type { OramaAnalyzerManager } from '#src/engines/orama/analyzer.js';
import { oramaIndexMetadataPath } from '#src/engines/orama/paths.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index/records.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';

let root: string;
let kb: KbRuntime;
let runtime: ReturnType<typeof createRealRuntime>;
let db: ReturnType<typeof openKbTestStoreDb>;
let store: OramaSnapshotStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coral-orama-ac7-'));
  runtime = createRealRuntime('prod', { baseDir: root });
  const env = runtime.env;
  runtime = {
    ...runtime,
    env: {
      ...env,
      get: (key) => (key === 'CORAL_KB_EXTRA_LANGS' ? 'ko' : env.get(key)),
      fullSnapshot: () => ({ ...env.fullSnapshot(), CORAL_KB_EXTRA_LANGS: 'ko' }),
      coralSnapshot: () => ({ ...env.coralSnapshot(), CORAL_KB_EXTRA_LANGS: 'ko' }),
    },
  };
  db = openKbTestStoreDb(':memory:');
  kb = createTestKbRuntime({ markdownRoot: root, runtimeDir: join(root, '.runtime'), db, runtime });
  store = new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function projection(kiwi: boolean, snapshotStore = store) {
  const analyzer = kiwi ? { tokens: (raw: string) => [`kiwi_${raw}`] } : null;
  const manager: OramaAnalyzerManager = {
    withAnalyzerLease: async (_runtime, declared, run) => run({ analyzer, activeAnalyzers: kiwi ? declared : [] }),
    effectiveDeclaredAnalyzers: (declared) => (kiwi ? declared : []),
    currentAnalyzer: () => analyzer,
    isTerminalLoadError: () => false,
  };
  return new OramaBaseProjection(kb, snapshotStore, { analyzerManager: manager, kiwiRuntime: runtime });
}

function seed(body: string) {
  mkdirSync(kb.notesDir(), { recursive: true });
  writeFileSync(
    kb.notePath('race'),
    `---\ntags: []\nprinciples: []\nsource: []\ncreatedAt: 2026-06-20T00:00:00.000Z\nupdatedAt: 2026-06-20T00:00:00.000Z\n---\n# Race\n\n${body}\n`,
  );
  kb.writeIndex({
    entries: {
      'note:race': buildNoteIndexEntry({
        slug: 'race',
        title: 'Race',
        body,
        tags: [],
        principles: [],
        source: [],
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-06-20T00:00:00.000Z',
      }),
    },
    principles: {},
    entityMeta: {},
    relationships: [],
  });
  kb.recordMutationCommitted('both', 'race');
  return kb.captureCorpusSnapshot();
}

it('prevents an older full install with a different tokenizer from replacing the winner', async () => {
  const older = seed('olderonly');
  const stale = projection(true);
  const prepared = await stale.prepareFullSnapshot(createKbProjectionInput(kb));
  const newer = seed('neweronly');
  const current = projection(false);
  expect(stale.projectionIdentityHash()).not.toBe(current.projectionIdentityHash());
  await current.installFullSnapshot(newer, await current.prepareFullSnapshot(createKbProjectionInput(kb)));
  const winner = readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf8');

  await stale.installFullSnapshot(older, prepared);

  expect(readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf8')).toBe(winner);
  const cold = projection(
    false,
    new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir),
  );
  expect((await cold.search('neweronly', 5, 'all')).hits.map((hit) => hit.documentId)).toEqual(['note:race']);
  expect((await cold.search('olderonly', 5, 'all')).hits).toEqual([]);
});

it('prevents an older delta from persisting over a newer install with a different tokenizer', async () => {
  const base = seed('baseonly');
  const current = projection(false);
  await current.installFullSnapshot(base, await current.prepareFullSnapshot(createKbProjectionInput(kb)));
  const older = seed('staleonly');
  const input = createKbProjectionInput(kb);
  const newer = seed('newestonly');
  const winner = projection(true);
  expect(current.projectionIdentityHash()).not.toBe(winner.projectionIdentityHash());
  const prepared = await winner.prepareFullSnapshot(createKbProjectionInput(kb));
  const load = store.load.bind(store);
  let raced = false;
  vi.spyOn(store, 'load').mockImplementation(async () => {
    const loaded = await load();
    if (!raced) {
      raced = true;
      await winner.installFullSnapshot(newer, prepared);
    }
    return loaded;
  });

  await current.apply({
    snapshot: older,
    journalReader: { readCursor: () => 0 },
    corpusStateReader: { readConsumerCursor: () => older, readCurrentSnapshot: () => older },
    projectionInput: input,
    signal: new AbortController().signal,
  });

  expect(raced).toBe(true);
  expect(JSON.parse(readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf8')).snapshotId).toBe(
    newer.snapshotId,
  );
  const cold = projection(
    true,
    new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir),
  );
  expect((await cold.search('newestonly', 5, 'all')).hits.map((hit) => hit.documentId)).toEqual(['note:race']);
  expect((await cold.search('staleonly', 5, 'all')).hits).toEqual([]);
});
