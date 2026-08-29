import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ORAMA_PROJECTION_IDENTITY_HASH,
  createOramaProjectionIdentityInput,
  type OramaProjectionMetadata,
} from '#src/engines/orama/artifact-port.js';
import { OramaBaseProjection } from '#src/engines/orama/base-projection.js';
import type { OramaAnalyzerManager } from '#src/engines/orama/analyzer.js';
import type { OramaTokenizerAnalyzer } from '#src/engines/orama/document-builder.js';
import { oramaIndexMetadataPath } from '#src/engines/orama/paths.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import { kiwiArtifactStateKey } from '#src/engines/kiwi/artifact.js';
import { KiwiAnalyzerManager } from '#src/engines/kiwi/analyzer-manager.js';
import { createScope } from '#src/infra/disposable-scope.js';
import type { KbEngineRuntime, KbRuntime } from '#src/kb/contract.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index/records.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { missingKiwiArtifactState } from '#tests/helpers/kiwi-artifact-state.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function allocateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-orama-ac14-'));
  tempRoots.push(root);
  return root;
}

function withKoEnv(runtime: Runtime): Runtime {
  return {
    ...runtime,
    env: {
      ...runtime.env,
      get: (key) => (key === 'CORAL_KB_EXTRA_LANGS' ? 'ko' : runtime.env.get(key)),
      fullSnapshot: () => ({ ...runtime.env.fullSnapshot(), CORAL_KB_EXTRA_LANGS: 'ko' }),
      coralSnapshot: () => ({ ...runtime.env.coralSnapshot(), CORAL_KB_EXTRA_LANGS: 'ko' }),
    },
  };
}

function seedNote(kb: KbRuntime): void {
  mkdirSync(kb.notesDir(), { recursive: true });
  const body = 'Terminal analyzer failure must preserve searchable marker text.';
  writeFileSync(
    kb.notePath('kiwi-terminal-failure'),
    [
      '---',
      'tags: [kiwi]',
      'principles: []',
      'source:',
      '  - kangig94/coral',
      'createdAt: 2026-06-19T00:00:00.000Z',
      'updatedAt: 2026-06-19T00:00:00.000Z',
      'entrySeq: 1',
      '---',
      '# Kiwi Terminal Failure',
      '',
      body,
      '',
    ].join('\n'),
    'utf-8',
  );
  kb.writeIndex({
    entries: {
      [noteEntryId('kiwi-terminal-failure')]: buildNoteIndexEntry({
        slug: 'kiwi-terminal-failure',
        title: 'Kiwi Terminal Failure',
        tags: ['kiwi'],
        principles: [],
        source: ['kangig94/coral'],
        createdAt: '2026-06-19T00:00:00.000Z',
        updatedAt: '2026-06-19T00:00:00.000Z',
        bodyHash: computeBodySurfaceHash(body),
        entrySeq: 1,
      }),
    },
    principles: {},
    entityMeta: {},
    relationships: [],
  });
  kb.recordMutationCommitted('both', 'seed ac14 corpus');
}

function readMetadata(kb: KbRuntime): OramaProjectionMetadata {
  return JSON.parse(
    readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf-8'),
  ) as OramaProjectionMetadata;
}

function engineRuntime(kb: KbRuntime): KbEngineRuntime {
  return {
    runtimeDir: kb.runtimeDir,
    ownProjectionDir: join(kb.runtimeDir, 'orama'),
    ownProjectionStagingDir: join(kb.runtimeDir, 'orama-staging'),
    time: kb.time,
    ids: kb.ids,
    declaredAnalyzers: kb.declaredAnalyzers,
    projectionArtifacts: kb.projectionArtifacts,
    corpusProjectionReader: kb.corpusProjectionReader,
    capabilities: kb.capabilities,
    roleCatalog: kb.roleCatalog,
    journalReader: { readCursor: () => 0 },
    corpusStateReader: {
      readConsumerCursor: () => kb.captureCorpusSnapshot(),
      readCurrentSnapshot: () => kb.captureCorpusSnapshot(),
    },
  };
}

describe('Orama AC14 analyzer manager integration', () => {
  it('serves empty degraded search and fires the degrade callback after terminal Kiwi reload failure', async () => {
    const root = allocateRoot();
    const runtime = withKoEnv(createRealRuntime('prod'));
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
      db: createKbTestDb(join(root, '.runtime')),
      runtime,
    });
    seedNote(kb);
    const snapshot = kb.captureCorpusSnapshot();
    const snapshotStore = new OramaSnapshotStore(
      { files: kb.projectionArtifacts.files },
      kb.projectionArtifacts.runtimeDir,
    );
    const kiwiAnalyzer: OramaTokenizerAnalyzer = { tokens: (raw) => [raw] };
    const kiwiBuildManager: OramaAnalyzerManager = {
      withAnalyzerLease: async (_runtime, declared, run) => run({ analyzer: kiwiAnalyzer, activeAnalyzers: declared }),
      effectiveDeclaredAnalyzers: (declared) => declared,
      currentAnalyzer: () => kiwiAnalyzer,
      isTerminalLoadError: () => false,
    };
    const failingManager = new KiwiAnalyzerManager({
      inspectArtifact: () => missingKiwiArtifactState(),
      loadAnalyzer: async () => {
        throw new Error('Kiwi model deleted');
      },
      logger: () => {},
    });
    const degradedEvents: string[] = [];
    failingManager.observeDegraded(createScope(), (event) => {
      degradedEvents.push(event.artifactStateKey);
    });

    const initialProjection = new OramaBaseProjection(kb, snapshotStore, {
      analyzerManager: kiwiBuildManager,
      kiwiRuntime: runtime,
    });
    await initialProjection.installFullSnapshot(
      snapshot,
      await initialProjection.prepareFullSnapshot(createKbProjectionInput(kb)),
    );
    expect(readMetadata(kb).projectionIdentityHash).toBe(ORAMA_PROJECTION_IDENTITY_HASH({ declaredAnalyzers: ['ko'] }));

    const requestedReasons: string[] = [];
    const searchingProjection = new OramaBaseProjection(
      engineRuntime(kb),
      new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir),
      {
        analyzerManager: failingManager,
        kiwiRuntime: runtime,
        requestProjectionReconcile: (reason) => {
          requestedReasons.push(reason);
        },
      },
    );

    const result = await searchingProjection.search('searchable marker', 5, 'all');

    expect(result.hits).toEqual([]);
    expect(failingManager.effectiveDeclaredAnalyzers(kb.declaredAnalyzers, runtime)).toEqual([]);
    expect(degradedEvents).toEqual([kiwiArtifactStateKey(missingKiwiArtifactState())]);
    expect(requestedReasons).toEqual(['terminal-analyzer-failure', 'incompatible']);
    expect(searchingProjection.warnings()).toContain('fts_index_uninitialized');
    const persistedMetadata = readMetadata(kb);
    expect(persistedMetadata.projectionIdentityHash).toBe(
      ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko'])),
    );
    expect(Object.values(persistedMetadata.entryManifest).map((entry) => entry.documentId)).toEqual([
      noteEntryId('kiwi-terminal-failure'),
    ]);
  });

  it('serves the Intl artifact without synchronously rebuilding when a Kiwi upgrade is pending', async () => {
    const root = allocateRoot();
    const runtime = withKoEnv(createRealRuntime('prod'));
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
      db: createKbTestDb(join(root, '.runtime')),
      runtime,
    });
    seedNote(kb);
    const snapshot = kb.captureCorpusSnapshot();

    const intlBaselineManager: OramaAnalyzerManager = {
      withAnalyzerLease: async (_runtime, _declared, run) => run({ analyzer: null, activeAnalyzers: [] }),
      effectiveDeclaredAnalyzers: () => [],
      currentAnalyzer: () => null,
      isTerminalLoadError: () => false,
    };
    const buildProjection = new OramaBaseProjection(
      kb,
      new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir),
      { analyzerManager: intlBaselineManager },
    );
    await buildProjection.installFullSnapshot(
      snapshot,
      await buildProjection.prepareFullSnapshot(createKbProjectionInput(kb)),
    );
    const intlIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], []));
    expect(readMetadata(kb).projectionIdentityHash).toBe(intlIdentity);

    // Mid-run upgrade window: the Kiwi model has landed and the analyzer is loaded,
    // so the expected tier is now Kiwi, but the persisted index is still the valid
    // Intl one and the background Kiwi reindex has not swapped in yet. A search
    // arrives during this window.
    const kiwiAnalyzer: OramaTokenizerAnalyzer = { tokens: (raw) => [raw] };
    const kiwiLoadedManager: OramaAnalyzerManager = {
      withAnalyzerLease: async (_runtime, declared, run) => run({ analyzer: kiwiAnalyzer, activeAnalyzers: declared }),
      effectiveDeclaredAnalyzers: (declared) => declared,
      currentAnalyzer: () => kiwiAnalyzer,
      isTerminalLoadError: () => false,
    };
    const requestedReasons: string[] = [];
    const searchStore = new OramaSnapshotStore(
      { files: kb.projectionArtifacts.files },
      kb.projectionArtifacts.runtimeDir,
    );
    const searchingProjection = new OramaBaseProjection(engineRuntime(kb), searchStore, {
      analyzerManager: kiwiLoadedManager,
      kiwiRuntime: runtime,
      requestProjectionReconcile: (reason) => {
        requestedReasons.push(reason);
      },
    });

    const result = await searchingProjection.search('searchable marker', 5, 'all');

    expect(result.hits.map((hit) => hit.documentId)).toContain(noteEntryId('kiwi-terminal-failure'));
    expect(readMetadata(kb).projectionIdentityHash).toBe(intlIdentity);
    expect(searchingProjection.warnings()).toContain('fts_index_stale_tier');
    expect(requestedReasons).toEqual(['stale-tier']);

    const kiwiIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko']));
    await searchingProjection.installFullSnapshot(
      snapshot,
      await searchingProjection.prepareFullSnapshot(createKbProjectionInput(kb)),
    );

    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentity);
    expect(searchingProjection.warnings()).not.toContain('fts_index_stale_tier');
  });
});
