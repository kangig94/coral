import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ORAMA_PROJECTION_IDENTITY_HASH,
  createOramaProjectionIdentityInput,
  type OramaProjectionMetadata,
} from '#src/engines/orama/artifact-port.js';
import { OramaBaseProjection } from '#src/engines/orama/backend.js';
import { oramaIndexMetadataPath } from '#src/engines/orama/paths.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import { KiwiAnalyzerManager } from '#src/engines/kiwi/analyzer-manager.js';
import type { KiwiModelArtifactState } from '#src/engines/kiwi/model-artifact.js';
import type { KbEngineRuntime, KbRuntime } from '#src/kb/contract.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index-records.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

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

function missingKiwiState(): KiwiModelArtifactState {
  return {
    targetDir: '/tmp/kiwi',
    manifestPath: '/tmp/kiwi/manifest.json',
    installed: false,
    manifest: null,
    missingFiles: ['cong.mdl'],
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
  it('rebuilds to Intl baseline tier after terminal Kiwi reload failure before serving search', async () => {
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
    const manager = new KiwiAnalyzerManager({
      inspectModelArtifact: () => missingKiwiState(),
      loadAnalyzer: async () => {
        throw new Error('Kiwi model deleted');
      },
      logger: () => {},
    });

    const initialProjection = new OramaBaseProjection(kb, snapshotStore, { analyzerManager: manager });
    await initialProjection.installFullSnapshot(
      snapshot,
      await initialProjection.prepareFullSnapshot(createKbProjectionInput(kb)),
    );
    expect(readMetadata(kb).projectionIdentityHash).toBe(
      ORAMA_PROJECTION_IDENTITY_HASH({ declaredAnalyzers: ['ko'] }),
    );

    const searchingProjection = new OramaBaseProjection(
      engineRuntime(kb),
      new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir),
      { analyzerManager: manager, kiwiRuntime: runtime },
    );

    const result = await searchingProjection.search('searchable marker', 5, 'all');

    expect(result.hits.map((hit) => hit.documentId)).toContain(noteEntryId('kiwi-terminal-failure'));
    expect(manager.effectiveDeclaredAnalyzers(kb.declaredAnalyzers, runtime)).toEqual([]);
    const rebuiltMetadata = readMetadata(kb);
    const degradedIdentity = ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], []));
    expect(rebuiltMetadata.projectionIdentityHash).toBe(degradedIdentity);
    expect(rebuiltMetadata.projectionIdentityHash).not.toBe(ORAMA_PROJECTION_IDENTITY_HASH({ declaredAnalyzers: [] }));
    expect(Object.values(rebuiltMetadata.entryManifest).map((entry) => entry.documentId)).toEqual([
      noteEntryId('kiwi-terminal-failure'),
    ]);
  });
});
