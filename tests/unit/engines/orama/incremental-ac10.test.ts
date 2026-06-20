import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OramaBaseProjection, createOramaBaseProjection } from '#src/engines/orama/backend.js';
import { oramaIndexMetadataPath, oramaIndexPath } from '#src/engines/orama/paths.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import {
  type OramaEntryManifest,
  type OramaProjectionMetadata,
} from '#src/engines/orama/artifact-port.js';
import {
  buildCommunityIndexEntry,
  buildNoteIndexEntry,
  buildSourceIndexEntry,
} from '#src/kb/corpus/index-records.js';
import { communityEntryId, noteEntryId, sourceEntryId, type KbIndex } from '#src/kb/entry-types.js';
import type { KbCorpusSnapshot, KbEngineRuntimeBase, KbRuntime } from '#src/kb/contract.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import type { KbProjectionInput } from '#src/kb/projection-input-contract.js';
import type { CorpusConsumerApplyContext } from '#src/store/consumer-contract.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import type { Runtime } from '#src/runtime/ports.js';

// Each case builds full Orama indexes (full-rebuild + incremental + compare);
// give headroom so they don't flake under full-suite parallel worker load.
vi.setConfig({ testTimeout: 30_000 });

const TOP_K = 10;
const EQUIVALENCE_QUERIES = [
  'graph retrieval',
  'incremental golden',
  'settled current',
  'sqlite planner',
  'deleteonly marker',
] as const;

type NoteSpec = {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  principles?: string[];
  entrySeq: number;
};

type SourceSpec = {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  entrySeq: number;
};

type CommunitySpec = {
  slug: string;
  title: string;
  body: string;
  members: string[];
  level?: number;
  parent?: string;
  children?: string[];
  summary?: string;
  updatedAt?: string;
};

type CorpusSpec = {
  notes?: readonly NoteSpec[];
  sources?: readonly SourceSpec[];
  communities?: readonly CommunitySpec[];
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function allocateRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createRuntime(root: string, runtime?: Runtime): KbRuntime {
  return createTestKbRuntime({
    markdownRoot: root,
    runtimeDir: join(root, '.runtime'),
    db: createKbTestDb(join(root, '.runtime')),
    ...(runtime === undefined ? {} : { runtime }),
  });
}

function renderNote(note: NoteSpec): string {
  return [
    '---',
    `tags: [${(note.tags ?? []).join(', ')}]`,
    `principles: [${(note.principles ?? []).join(', ')}]`,
    'source:',
    '  - kangig94/coral',
    'createdAt: 2026-04-01T00:00:00.000Z',
    'updatedAt: 2026-04-01T00:00:00.000Z',
    `entrySeq: ${note.entrySeq}`,
    '---',
    `# ${note.title}`,
    '',
    note.body,
    '',
  ].join('\n');
}

function renderSource(source: SourceSpec): string {
  return [
    '---',
    `title: ${source.title}`,
    'type: article',
    `tags: [${(source.tags ?? []).join(', ')}]`,
    'importedAt: 2026-04-01',
    `entrySeq: ${source.entrySeq}`,
    '---',
    `# ${source.title}`,
    '',
    source.body,
    '',
  ].join('\n');
}

function renderCommunity(community: CommunitySpec): string {
  return [
    '---',
    'createdAt: 2026-04-01T00:00:00.000Z',
    `updatedAt: ${community.updatedAt ?? '2026-04-01T00:00:00.000Z'}`,
    `level: ${community.level ?? 0}`,
    ...(community.parent === undefined ? [] : [`parent: ${community.parent}`]),
    ...(community.children === undefined ? [] : [`children: [${community.children.join(', ')}]`]),
    '---',
    `# ${community.title}`,
    '',
    community.body,
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

function seedCorpus(kb: KbRuntime, spec: CorpusSpec, reason: string): KbCorpusSnapshot {
  resetCorpusDirs(kb);
  const entries: KbIndex['entries'] = {};

  for (const note of spec.notes ?? []) {
    writeFileSync(kb.notePath(note.slug), renderNote(note), 'utf-8');
    entries[noteEntryId(note.slug)] = buildNoteIndexEntry({
      slug: note.slug,
      title: note.title,
      tags: note.tags ?? [],
      principles: note.principles ?? [],
      source: ['kangig94/coral'],
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      body: note.body,
      entrySeq: note.entrySeq,
    });
  }

  for (const source of spec.sources ?? []) {
    writeFileSync(kb.sourcePath(source.slug), renderSource(source), 'utf-8');
    entries[sourceEntryId(source.slug)] = buildSourceIndexEntry({
      slug: source.slug,
      title: source.title,
      type: 'article',
      tags: source.tags ?? [],
      importedAt: '2026-04-01',
      body: source.body,
      entrySeq: source.entrySeq,
    });
  }

  for (const community of spec.communities ?? []) {
    writeFileSync(kb.communityPath(community.slug), renderCommunity(community), 'utf-8');
    entries[communityEntryId(community.slug)] = buildCommunityIndexEntry({
      slug: community.slug,
      title: community.title,
      level: community.level ?? 0,
      members: community.members,
      ...(community.parent === undefined ? {} : { parent: community.parent }),
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(community.summary === undefined ? {} : { summary: community.summary }),
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: community.updatedAt ?? '2026-04-01T00:00:00.000Z',
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

function newProjection(kb: KbRuntime): {
  projection: OramaBaseProjection;
  snapshotStore: OramaSnapshotStore;
} {
  const snapshotStore = new OramaSnapshotStore(
    { files: kb.projectionArtifacts.files },
    kb.projectionArtifacts.runtimeDir,
  );
  return {
    projection: new OramaBaseProjection(kb, snapshotStore),
    snapshotStore,
  };
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

async function applySnapshot(
  projection: OramaBaseProjection,
  kb: KbRuntime,
  snapshot: KbCorpusSnapshot,
): Promise<void> {
  await projection.apply(makeContext(snapshot, snapshot, createKbProjectionInput(kb)));
}

async function installFullSnapshot(kb: KbRuntime): Promise<OramaBaseProjection> {
  const projection = createOramaBaseProjection(kb);
  const prepared = await projection.prepareFullSnapshot(createKbProjectionInput(kb));
  await projection.installFullSnapshot(kb.captureCorpusSnapshot(), prepared);
  return projection;
}

function readMetadata(kb: KbRuntime): OramaProjectionMetadata {
  return JSON.parse(
    readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf-8'),
  ) as OramaProjectionMetadata;
}

function writeMetadata(kb: KbRuntime, metadata: OramaProjectionMetadata): void {
  writeFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), `${JSON.stringify(metadata, null, 2)}\n`);
}

function expectManifestEntryIds(kb: KbRuntime, entryIds: readonly string[]): void {
  expect(Object.keys(readMetadata(kb).entryManifest).sort()).toEqual([...entryIds].sort());
}

async function expectSearchDocumentIds(
  projection: OramaBaseProjection,
  query: string,
  expectedDocumentIds: readonly string[],
): Promise<void> {
  const documentIds = (await projection.search(query, TOP_K, 'all')).hits.map((hit) => hit.documentId);
  expect([...documentIds].sort()).toEqual([...expectedDocumentIds].sort());
}

function canonicalizeHits(
  hits: ReadonlyArray<{
    documentId: string;
    score: number;
    fields: unknown;
  }>,
) {
  return [...hits].sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (Math.abs(scoreDelta) > 1e-12) {
      return scoreDelta;
    }
    return left.documentId.localeCompare(right.documentId);
  });
}

async function expectEquivalentSearchResults(
  incremental: OramaBaseProjection,
  rebuilt: OramaBaseProjection,
): Promise<void> {
  for (const query of EQUIVALENCE_QUERIES) {
    const incrementalHits = canonicalizeHits((await incremental.search(query, TOP_K, 'all')).hits);
    const rebuiltHits = canonicalizeHits((await rebuilt.search(query, TOP_K, 'all')).hits);
    expect(
      incrementalHits.map((hit) => ({ documentId: hit.documentId, fields: hit.fields })),
      query,
    ).toEqual(rebuiltHits.map((hit) => ({ documentId: hit.documentId, fields: hit.fields })));
  }
}

const INITIAL_CORPUS: CorpusSpec = {
  notes: [
    {
      slug: 'graph-rag',
      title: 'Graph Retrieval',
      tags: ['graph'],
      body: 'Graph retrieval keeps the initial baseline marker.',
      entrySeq: 1,
    },
    {
      slug: 'legacy-delete',
      title: 'Legacy Delete',
      body: 'This note contains the deleteonly sunset deletion marker.',
      entrySeq: 2,
    },
  ],
  sources: [
    {
      slug: 'sqlite-planner',
      title: 'SQLite Planner',
      tags: ['sqlite'],
      body: 'SQLite planner source covers query planning.',
      entrySeq: 3,
    },
  ],
};

const FINAL_CORPUS: CorpusSpec = {
  notes: [
    {
      slug: 'graph-rag',
      title: 'Graph Retrieval',
      tags: ['graph', 'golden'],
      body: 'Graph retrieval now proves incremental golden equivalence with settled current terms.',
      entrySeq: 4,
    },
    {
      slug: 'delta-insert',
      title: 'Delta Insert',
      tags: ['delta'],
      body: 'A newly inserted note mentions settled current projection behavior.',
      entrySeq: 5,
    },
  ],
  sources: [
    {
      slug: 'sqlite-planner',
      title: 'SQLite Planner',
      tags: ['sqlite', 'planner'],
      body: 'SQLite planner source covers final query planning.',
      entrySeq: 6,
    },
  ],
};

describe('orama AC10 incremental projection', () => {
  it('matches a full rebuild after a sequence of insert, update, and delete deltas', async () => {
    const incrementalRuntime = createRuntime(allocateRoot('coral-orama-incremental-'));
    const initialSnapshot = seedCorpus(incrementalRuntime, INITIAL_CORPUS, 'seed initial corpus');
    const { projection: incrementalProjection } = newProjection(incrementalRuntime);
    await applySnapshot(incrementalProjection, incrementalRuntime, initialSnapshot);

    const fullInstallSpy = vi.spyOn(incrementalProjection, 'installFullSnapshot');
    const finalSnapshot = seedCorpus(incrementalRuntime, FINAL_CORPUS, 'apply final corpus');
    await applySnapshot(incrementalProjection, incrementalRuntime, finalSnapshot);

    expect(fullInstallSpy).not.toHaveBeenCalled();
    expect(readMetadata(incrementalRuntime).snapshotId).toBe(finalSnapshot.snapshotId);
    expectManifestEntryIds(incrementalRuntime, [
      noteEntryId('delta-insert'),
      noteEntryId('graph-rag'),
      sourceEntryId('sqlite-planner'),
    ]);
    await expectSearchDocumentIds(incrementalProjection, 'deleteonly sunset deletion', []);
    await expectSearchDocumentIds(incrementalProjection, 'settled current projection behavior', [
      noteEntryId('delta-insert'),
      noteEntryId('graph-rag'),
    ]);

    const fullRuntime = createRuntime(allocateRoot('coral-orama-full-'));
    seedCorpus(fullRuntime, FINAL_CORPUS, 'seed final corpus');
    await installFullSnapshot(fullRuntime);

    await expectEquivalentSearchResults(
      newProjection(incrementalRuntime).projection,
      newProjection(fullRuntime).projection,
    );
  });

  it('treats an artifact ahead of the consumer cursor as the persisted delta base after restart', async () => {
    const kb = createRuntime(allocateRoot('coral-orama-ahead-'));
    const snapshotV1 = seedCorpus(kb, INITIAL_CORPUS, 'seed initial corpus');
    const { projection } = newProjection(kb);
    await applySnapshot(projection, kb, snapshotV1);

    const snapshotV2 = seedCorpus(kb, FINAL_CORPUS, 'persist current corpus ahead of cursor');
    await applySnapshot(projection, kb, snapshotV2);

    const { projection: restarted } = newProjection(kb);
    const fullInstallSpy = vi.spyOn(restarted, 'installFullSnapshot');
    await restarted.apply(makeContext(snapshotV1, snapshotV2, createKbProjectionInput(kb)));

    expect(fullInstallSpy).not.toHaveBeenCalled();
    expect(readMetadata(kb).snapshotId).toBe(snapshotV2.snapshotId);
    await expectSearchDocumentIds(restarted, 'incremental golden', [noteEntryId('graph-rag')]);
  });

  it('removes a deleted manifest entry after restart without rebuilding unrelated entries', async () => {
    const kb = createRuntime(allocateRoot('coral-orama-delete-'));
    const snapshotV1 = seedCorpus(kb, INITIAL_CORPUS, 'seed initial corpus');
    const { projection } = newProjection(kb);
    await applySnapshot(projection, kb, snapshotV1);

    const snapshotV2 = seedCorpus(
      kb,
      {
        notes: INITIAL_CORPUS.notes?.filter((note) => note.slug !== 'legacy-delete'),
        sources: INITIAL_CORPUS.sources,
      },
      'delete one note',
    );

    const { projection: restarted } = newProjection(kb);
    const fullInstallSpy = vi.spyOn(restarted, 'installFullSnapshot');
    await applySnapshot(restarted, kb, snapshotV2);

    expect(fullInstallSpy).not.toHaveBeenCalled();
    expect(readMetadata(kb).snapshotId).toBe(snapshotV2.snapshotId);
    expectManifestEntryIds(kb, [noteEntryId('graph-rag'), sourceEntryId('sqlite-planner')]);
    expect(readMetadata(kb).entryManifest[noteEntryId('legacy-delete')]).toBeUndefined();
    await expectSearchDocumentIds(restarted, 'deleteonly sunset deletion', []);
    await expectSearchDocumentIds(restarted, 'graph retrieval', [noteEntryId('graph-rag')]);
  });

  it('rejects a stale sidecar manifest whose digest no longer matches the artifact', async () => {
    const kb = createRuntime(allocateRoot('coral-orama-stale-manifest-'));
    const snapshotV1 = seedCorpus(kb, INITIAL_CORPUS, 'seed initial corpus');
    const { projection } = newProjection(kb);
    await applySnapshot(projection, kb, snapshotV1);
    const staleSidecar = readFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), 'utf-8');

    const snapshotV2 = seedCorpus(kb, FINAL_CORPUS, 'write newer artifact and sidecar');
    await applySnapshot(projection, kb, snapshotV2);
    writeFileSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), staleSidecar, 'utf-8');

    const { projection: restarted } = newProjection(kb);
    const fullInstallSpy = vi.spyOn(restarted, 'installFullSnapshot');
    await applySnapshot(restarted, kb, snapshotV2);

    expect(fullInstallSpy).toHaveBeenCalledTimes(1);
    expect(readMetadata(kb).snapshotId).toBe(snapshotV2.snapshotId);
    await expectSearchDocumentIds(restarted, 'incremental golden equivalence', [noteEntryId('graph-rag')]);
  });

  it('falls back to one full rebuild when delta application cannot remove a manifest document', async () => {
    const kb = createRuntime(allocateRoot('coral-orama-delta-fallback-'));
    const snapshotV1 = seedCorpus(kb, INITIAL_CORPUS, 'seed initial corpus');
    const { projection } = newProjection(kb);
    await applySnapshot(projection, kb, snapshotV1);

    const snapshotV2 = seedCorpus(kb, FINAL_CORPUS, 'final corpus after delta failure');
    const metadata = readMetadata(kb);
    const graphManifestEntry = metadata.entryManifest[noteEntryId('graph-rag')];
    expect(graphManifestEntry).toBeDefined();
    const corruptedManifest: OramaEntryManifest = {
      ...metadata.entryManifest,
      [noteEntryId('graph-rag')]: {
        ...graphManifestEntry,
        documentId: noteEntryId('missing-graph-rag'),
      },
    };
    writeMetadata(kb, { ...metadata, entryManifest: corruptedManifest });

    const { projection: restarted } = newProjection(kb);
    const fullInstallSpy = vi.spyOn(restarted, 'installFullSnapshot');
    await applySnapshot(restarted, kb, snapshotV2);

    expect(fullInstallSpy).toHaveBeenCalledTimes(1);
    expect(readMetadata(kb).snapshotId).toBe(snapshotV2.snapshotId);
    expectManifestEntryIds(kb, [
      noteEntryId('delta-insert'),
      noteEntryId('graph-rag'),
      sourceEntryId('sqlite-planner'),
    ]);
    await expectSearchDocumentIds(restarted, 'settled current projection behavior', [
      noteEntryId('delta-insert'),
      noteEntryId('graph-rag'),
    ]);
    await expectSearchDocumentIds(restarted, 'deleteonly sunset deletion', []);
  });

  it('uses a full rebuild when a community metadata hash changes between snapshots', async () => {
    const kb = createRuntime(allocateRoot('coral-orama-community-topology-'));
    const communityV1: CorpusSpec = {
      communities: [
        {
          slug: 'retrieval-topology',
          title: 'Retrieval Topology',
          members: ['graph', 'rag'],
          body: 'Community topology keeps oldonlytopology marker.',
        },
      ],
    };
    const communityV2: CorpusSpec = {
      communities: [
        {
          slug: 'retrieval-topology',
          title: 'Retrieval Topology',
          members: ['graph', 'rag'],
          body: 'Community topology now serves rebuiltonlytopology marker.',
          updatedAt: '2026-04-02T00:00:00.000Z',
        },
      ],
    };
    const snapshotV1 = seedCorpus(kb, communityV1, 'seed community topology v1');
    const { projection } = newProjection(kb);
    await applySnapshot(projection, kb, snapshotV1);
    const previousCommunityMetadataHash =
      readMetadata(kb).entryManifest[communityEntryId('retrieval-topology')]?.metadataHash;
    expect(previousCommunityMetadataHash).toBeDefined();

    const snapshotV2 = seedCorpus(kb, communityV2, 'seed community topology v2');
    const fullInstallSpy = vi.spyOn(projection, 'installFullSnapshot');
    await applySnapshot(projection, kb, snapshotV2);

    const metadata = readMetadata(kb);
    expect(fullInstallSpy).toHaveBeenCalledTimes(1);
    expect(metadata.snapshotId).toBe(snapshotV2.snapshotId);
    expect(metadata.entryManifest[communityEntryId('retrieval-topology')]?.metadataHash).not.toBe(
      previousCommunityMetadataHash,
    );
    expectManifestEntryIds(kb, [communityEntryId('retrieval-topology')]);
    await expectSearchDocumentIds(projection, 'rebuiltonlytopology', [
      communityEntryId('retrieval-topology'),
    ]);
    await expectSearchDocumentIds(projection, 'oldonlytopology', []);
  });

  it('recovers from a torn write by rebuilding when the persisted metadata sidecar is missing', async () => {
    const kb = createRuntime(allocateRoot('coral-orama-fallback-'));
    const snapshotV1 = seedCorpus(kb, INITIAL_CORPUS, 'seed initial corpus');
    const { projection } = newProjection(kb);
    await applySnapshot(projection, kb, snapshotV1);

    const snapshotV2 = seedCorpus(kb, FINAL_CORPUS, 'final corpus after sidecar loss');
    rmSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir), { force: true });
    expect(existsSync(oramaIndexPath(kb.projectionArtifacts.runtimeDir))).toBe(true);
    expect(existsSync(oramaIndexMetadataPath(kb.projectionArtifacts.runtimeDir))).toBe(false);

    const { projection: restarted } = newProjection(kb);
    const fullInstallSpy = vi.spyOn(restarted, 'installFullSnapshot');
    await applySnapshot(restarted, kb, snapshotV2);

    expect(fullInstallSpy).toHaveBeenCalledTimes(1);
    expect(readMetadata(kb).snapshotId).toBe(snapshotV2.snapshotId);
    expectManifestEntryIds(kb, [
      noteEntryId('delta-insert'),
      noteEntryId('graph-rag'),
      sourceEntryId('sqlite-planner'),
    ]);
    await expectSearchDocumentIds(restarted, 'settled current projection behavior', [
      noteEntryId('delta-insert'),
      noteEntryId('graph-rag'),
    ]);
  });

  it('re-targets a newer settled snapshot mid-prepare without a full rebuild', async () => {
    const kb = createRuntime(allocateRoot('coral-orama-multi-coalesce-'));
    const snapshotV1 = seedCorpus(
      kb,
      {
        notes: [
          {
            slug: 'alpha-note',
            title: 'Alpha',
            body: 'Alpha v1 baseline token.',
            entrySeq: 1,
          },
        ],
      },
      'seed v1',
    );
    const inputV1 = createKbProjectionInput(kb);
    const { projection: initialProjection } = newProjection(kb);
    await applySnapshot(initialProjection, kb, snapshotV1);

    const snapshotV2 = seedCorpus(
      kb,
      {
        notes: [
          {
            slug: 'alpha-note',
            title: 'Alpha',
            body: 'Alpha v2only intermediate token.',
            entrySeq: 2,
          },
        ],
      },
      'seed v2',
    );
    const inputV2 = createKbProjectionInput(kb);
    const snapshotV3 = seedCorpus(
      kb,
      {
        notes: [
          {
            slug: 'alpha-note',
            title: 'Alpha',
            body: 'Alpha v3latest settled current token.',
            entrySeq: 3,
          },
        ],
      },
      'seed v3',
    );
    const inputV3 = createKbProjectionInput(kb);

    const prepareCurrentProjectionInput = vi
      .fn<(options?: { readonly signal?: AbortSignal }) => Promise<KbProjectionInput>>()
      .mockResolvedValueOnce(inputV2)
      .mockResolvedValueOnce(inputV3);
    let currentSnapshotReads = 0;
    const readCurrentSnapshot = vi.fn(() => {
      currentSnapshotReads += 1;
      return currentSnapshotReads === 1 ? snapshotV2 : snapshotV3;
    });
    const coalescingRuntime: KbEngineRuntimeBase = {
      runtimeDir: kb.runtimeDir,
      time: kb.time,
      ids: kb.ids,
      declaredAnalyzers: kb.declaredAnalyzers,
      projectionArtifacts: kb.projectionArtifacts,
      corpusProjectionReader: {
        prepareCurrentProjectionInput,
        resolveCurrentIndex: () => kb.corpusProjectionReader.resolveCurrentIndex(),
      },
      capabilities: kb.capabilities,
      roleCatalog: kb.roleCatalog,
    };
    const snapshotStore = new OramaSnapshotStore(
      { files: kb.projectionArtifacts.files },
      kb.projectionArtifacts.runtimeDir,
    );
    const projection = new OramaBaseProjection(coalescingRuntime, snapshotStore);
    const FULL_INDEX_LOADS_FOR_DELTA_BASE = 1;
    const METADATA_ONLY_LOADS_FOR_PRE_PERSIST_GUARD = 1;
    const loadSpy = vi.spyOn(snapshotStore, 'load');
    const loadMetadataSpy = vi.spyOn(snapshotStore, 'loadMetadata');
    const fullInstallSpy = vi.spyOn(projection, 'installFullSnapshot');

    await projection.apply({
      snapshot: snapshotV1,
      journalReader: { readCursor: () => 0 },
      corpusStateReader: {
        readConsumerCursor: () => snapshotV1,
        readCurrentSnapshot,
      },
      projectionInput: inputV1,
      signal: new AbortController().signal,
    });

    expect(prepareCurrentProjectionInput).toHaveBeenCalledTimes(2);
    // AC7 uses one full index load for the delta base, then a metadata-only
    // pre-persist guard so stale writers cannot clobber a newer artifact.
    expect(loadSpy).toHaveBeenCalledTimes(FULL_INDEX_LOADS_FOR_DELTA_BASE);
    expect(loadMetadataSpy).toHaveBeenCalledTimes(METADATA_ONLY_LOADS_FOR_PRE_PERSIST_GUARD);
    expect(fullInstallSpy).not.toHaveBeenCalled();
    expect(readMetadata(kb).snapshotId).toBe(snapshotV3.snapshotId);
    expectManifestEntryIds(kb, [noteEntryId('alpha-note')]);
    await expectSearchDocumentIds(projection, 'v3latest', [noteEntryId('alpha-note')]);
    await expectSearchDocumentIds(projection, 'v2only', []);
  });
});
