import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ORAMA_PROJECTION_IDENTITY_HASH,
  createOramaProjectionIdentityInput,
  oramaProjectionTokenizerTier,
  type OramaProjectionMetadata,
} from '#src/engines/orama/artifact-port.js';
import { OramaBaseProjection } from '#src/engines/orama/base-projection.js';
import type { OramaAnalyzerManager } from '#src/engines/orama/analyzer.js';
import type { OramaTokenizerAnalyzer } from '#src/engines/orama/document-builder.js';
import { oramaIndexMetadataPath } from '#src/engines/orama/paths.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import { buildNoteIndexEntry } from '#src/kb/corpus/index/records.js';
import { noteEntryId, type KbIndex } from '#src/kb/entry-types.js';
import type { KbCorpusSnapshot, KbRuntime } from '#src/kb/contract.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import type { KbProjectionInput } from '#src/kb/projection-input-contract.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import type { CorpusConsumerApplyContext } from '#src/store/consumer-contract.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';

vi.setConfig({ testTimeout: 30_000 });

const tempRoots: string[] = [];

type NoteSpec = {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly entrySeq: number;
};

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function allocateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-orama-ac7-'));
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

function createKbFixture(): { readonly kb: KbRuntime; readonly runtime: Runtime } {
  const root = allocateRoot();
  const runtime = withKoEnv(createRealRuntime('prod'));
  return {
    runtime,
    kb: createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: join(root, '.runtime'),
      db: createKbTestDb(join(root, '.runtime')),
      runtime,
    }),
  };
}

function renderNote(note: NoteSpec): string {
  return [
    '---',
    'tags: [orama]',
    'principles: []',
    'source:',
    '  - kangig94/coral',
    'createdAt: 2026-06-20T00:00:00.000Z',
    'updatedAt: 2026-06-20T00:00:00.000Z',
    `entrySeq: ${note.entrySeq}`,
    '---',
    `# ${note.title}`,
    '',
    note.body,
    '',
  ].join('\n');
}

function resetCorpusDirs(kb: KbRuntime): void {
  rmSync(kb.notesDir(), { recursive: true, force: true });
  rmSync(kb.sourcesDir(), { recursive: true, force: true });
  rmSync(kb.communitiesDir(), { recursive: true, force: true });
  mkdirSync(kb.notesDir(), { recursive: true });
  mkdirSync(kb.sourcesDir(), { recursive: true });
  mkdirSync(kb.communitiesDir(), { recursive: true });
}

function seedNotes(kb: KbRuntime, notes: readonly NoteSpec[], reason: string): KbCorpusSnapshot {
  resetCorpusDirs(kb);
  const entries: KbIndex['entries'] = {};
  for (const note of notes) {
    writeFileSync(kb.notePath(note.slug), renderNote(note), 'utf-8');
    entries[noteEntryId(note.slug)] = buildNoteIndexEntry({
      slug: note.slug,
      title: note.title,
      tags: ['orama'],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-06-20T00:00:00.000Z',
      updatedAt: '2026-06-20T00:00:00.000Z',
      body: note.body,
      entrySeq: note.entrySeq,
    });
  }

  kb.writeIndex({
    entries,
    principles: {},
    entityMeta: {},
    relationships: [],
  });
  kb.recordMutationCommitted('both', reason);
  return kb.captureCorpusSnapshot();
}

function createSnapshotStore(kb: KbRuntime): OramaSnapshotStore {
  return new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir);
}

function createKiwiAnalyzer(): OramaTokenizerAnalyzer {
  return {
    tokens: (raw) => [`kiwi_${raw}`],
  };
}

function createManager(activeKo: boolean): OramaAnalyzerManager {
  const analyzer = activeKo ? createKiwiAnalyzer() : null;
  return {
    withAnalyzerLease: async (_runtime, declaredAnalyzers, run) =>
      run({
        analyzer,
        activeAnalyzers: activeKo ? declaredAnalyzers : [],
      }),
    effectiveDeclaredAnalyzers: (declaredAnalyzers) => (activeKo ? declaredAnalyzers : []),
    currentAnalyzer: () => analyzer,
    isTerminalLoadError: () => false,
  };
}

function createProjection(
  kb: KbRuntime,
  snapshotStore: OramaSnapshotStore,
  runtime: Runtime,
  manager: OramaAnalyzerManager,
): OramaBaseProjection {
  return new OramaBaseProjection(kb, snapshotStore, {
    analyzerManager: manager,
    kiwiRuntime: runtime,
  });
}

async function installFullSnapshot(
  projection: OramaBaseProjection,
  kb: KbRuntime,
  snapshot: KbCorpusSnapshot,
): Promise<void> {
  await projection.installFullSnapshot(snapshot, await projection.prepareFullSnapshot(createKbProjectionInput(kb)));
}

function makeContext(
  snapshot: KbCorpusSnapshot,
  currentSnapshot: KbCorpusSnapshot,
  projectionInput: KbProjectionInput,
): CorpusConsumerApplyContext {
  return {
    snapshot,
    journalReader: { readCursor: () => 0 },
    corpusStateReader: {
      readConsumerCursor: () => snapshot,
      readCurrentSnapshot: () => currentSnapshot,
    },
    projectionInput,
    signal: new AbortController().signal,
  };
}

function readMetadata(kb: KbRuntime): OramaProjectionMetadata {
  return JSON.parse(
    readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf-8'),
  ) as OramaProjectionMetadata;
}

function readCacheMetadata(snapshotStore: OramaSnapshotStore): OramaProjectionMetadata {
  const metadata = snapshotStore.getCache()?.metadata;
  expect(metadata).toBeDefined();
  return metadata!;
}

function intlIdentityHash(): string {
  return ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], []));
}

function kiwiIdentityHash(): string {
  return ORAMA_PROJECTION_IDENTITY_HASH(createOramaProjectionIdentityInput(['ko'], ['ko']));
}

async function expectSearchDocumentIds(
  projection: OramaBaseProjection,
  query: string,
  expectedDocumentIds: readonly string[],
): Promise<void> {
  const actual = (await projection.search(query, 10, 'all')).hits.map((hit) => hit.documentId).sort();
  expect(actual).toEqual([...expectedDocumentIds].sort());
}

describe('Orama AC7 identity-aware lost-update guard', () => {
  it('skips a strictly older full-install race even when the target identity differs', async () => {
    const { kb, runtime } = createKbFixture();
    const intlManager = createManager(false);
    const kiwiManager = createManager(true);
    const snapshotStore = createSnapshotStore(kb);

    const olderSnapshot = seedNotes(
      kb,
      [
        {
          slug: 'older-full-race',
          title: 'Older Full Race',
          body: 'The olderonly full install marker must never return.',
          entrySeq: 1,
        },
      ],
      'seed older full-install source',
    );
    const staleKiwiProjection = createProjection(kb, snapshotStore, runtime, kiwiManager);
    const olderPrepared = await staleKiwiProjection.prepareFullSnapshot(createKbProjectionInput(kb));

    const newerSnapshot = seedNotes(
      kb,
      [
        {
          slug: 'newer-full-race',
          title: 'Newer Full Race',
          body: 'The neweronly full install marker must survive.',
          entrySeq: 2,
        },
      ],
      'seed newer full-install winner',
    );
    const currentIntlProjection = createProjection(kb, snapshotStore, runtime, intlManager);
    await installFullSnapshot(currentIntlProjection, kb, newerSnapshot);
    expect(readMetadata(kb).projectionIdentityHash).toBe(intlIdentityHash());

    await staleKiwiProjection.installFullSnapshot(olderSnapshot, olderPrepared);

    const diskMetadata = readMetadata(kb);
    const cacheMetadata = readCacheMetadata(snapshotStore);
    expect(diskMetadata.snapshotId).toBe(newerSnapshot.snapshotId);
    expect(diskMetadata.projectionIdentityHash).toBe(intlIdentityHash());
    expect(cacheMetadata.snapshotId).toBe(newerSnapshot.snapshotId);
    expect(cacheMetadata.projectionIdentityHash).toBe(intlIdentityHash());

    const coldProjection = createProjection(kb, createSnapshotStore(kb), runtime, intlManager);
    await expectSearchDocumentIds(coldProjection, 'neweronly', [noteEntryId('newer-full-race')]);
    await expectSearchDocumentIds(coldProjection, 'olderonly', []);
  });

  it('skips a strictly older post-delta persist race even when a newer install changed identity', async () => {
    const { kb, runtime } = createKbFixture();
    const intlManager = createManager(false);
    const kiwiManager = createManager(true);
    const snapshotStore = createSnapshotStore(kb);
    const baseProjection = createProjection(kb, snapshotStore, runtime, intlManager);

    const baseSnapshot = seedNotes(
      kb,
      [
        {
          slug: 'delta-race-note',
          title: 'Delta Race',
          body: 'The baseonly delta marker starts the artifact.',
          entrySeq: 1,
        },
      ],
      'seed delta race base',
    );
    await installFullSnapshot(baseProjection, kb, baseSnapshot);

    const staleDeltaSnapshot = seedNotes(
      kb,
      [
        {
          slug: 'delta-race-note',
          title: 'Delta Race',
          body: 'The staleonly delta marker must not clobber the winner.',
          entrySeq: 2,
        },
      ],
      'seed stale delta source',
    );
    const staleDeltaInput = createKbProjectionInput(kb);

    const newerSnapshot = seedNotes(
      kb,
      [
        {
          slug: 'delta-race-note',
          title: 'Delta Race',
          body: 'The newestonly delta marker must survive the stale delta.',
          entrySeq: 3,
        },
      ],
      'seed newer delta winner',
    );
    const kiwiProjection = createProjection(kb, snapshotStore, runtime, kiwiManager);
    const newerPrepared = await kiwiProjection.prepareFullSnapshot(createKbProjectionInput(kb));
    const staleIntlProjection = createProjection(kb, snapshotStore, runtime, intlManager);
    const originalLoad = snapshotStore.load.bind(snapshotStore);
    let raced = false;
    vi.spyOn(snapshotStore, 'load').mockImplementation(async () => {
      const loaded = await originalLoad();
      if (!raced) {
        raced = true;
        await kiwiProjection.installFullSnapshot(newerSnapshot, newerPrepared);
      }
      return loaded;
    });

    await staleIntlProjection.apply(makeContext(staleDeltaSnapshot, staleDeltaSnapshot, staleDeltaInput));

    expect(raced).toBe(true);
    const diskMetadata = readMetadata(kb);
    const cacheMetadata = readCacheMetadata(snapshotStore);
    expect(diskMetadata.snapshotId).toBe(newerSnapshot.snapshotId);
    expect(diskMetadata.projectionIdentityHash).toBe(kiwiIdentityHash());
    expect(cacheMetadata.snapshotId).toBe(newerSnapshot.snapshotId);
    expect(cacheMetadata.projectionIdentityHash).toBe(kiwiIdentityHash());

    const coldProjection = createProjection(kb, createSnapshotStore(kb), runtime, kiwiManager);
    await expectSearchDocumentIds(coldProjection, 'newestonly', [noteEntryId('delta-race-note')]);
    await expectSearchDocumentIds(coldProjection, 'staleonly', []);
  });

  it('allows equal-snapshot tier reconciles to converge for upgrade and degrade', async () => {
    const { kb, runtime } = createKbFixture();
    const intlManager = createManager(false);
    const kiwiManager = createManager(true);
    const snapshotStore = createSnapshotStore(kb);
    const snapshot = seedNotes(
      kb,
      [
        {
          slug: 'equal-tier-reconcile',
          title: 'Equal Tier Reconcile',
          body: 'The equalsnapshot tier reconcile marker stays byte-identical.',
          entrySeq: 1,
        },
      ],
      'seed equal-snapshot tier reconcile',
    );
    const projectionInput = createKbProjectionInput(kb);

    const intlProjection = createProjection(kb, snapshotStore, runtime, intlManager);
    await installFullSnapshot(intlProjection, kb, snapshot);
    expect(oramaProjectionTokenizerTier(readMetadata(kb))).toBe('intl');

    const kiwiProjection = createProjection(kb, snapshotStore, runtime, kiwiManager);
    await kiwiProjection.apply(makeContext(snapshot, snapshot, projectionInput));

    expect(readMetadata(kb).snapshotId).toBe(snapshot.snapshotId);
    expect(readMetadata(kb).projectionIdentityHash).toBe(kiwiIdentityHash());
    expect(oramaProjectionTokenizerTier(readMetadata(kb))).toBe('kiwi');
    expect(oramaProjectionTokenizerTier(readCacheMetadata(snapshotStore))).toBe('kiwi');

    const degradedIntlProjection = createProjection(kb, snapshotStore, runtime, intlManager);
    await degradedIntlProjection.apply(makeContext(snapshot, snapshot, projectionInput));

    expect(readMetadata(kb).snapshotId).toBe(snapshot.snapshotId);
    expect(readMetadata(kb).projectionIdentityHash).toBe(intlIdentityHash());
    expect(oramaProjectionTokenizerTier(readMetadata(kb))).toBe('intl');
    expect(oramaProjectionTokenizerTier(readCacheMetadata(snapshotStore))).toBe('intl');
  });
});
