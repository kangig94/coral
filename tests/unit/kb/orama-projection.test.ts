import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { writeCurateState } from '#src/kb/curate/state/index.js';
import {
  communityEntryId,
  noteEntryId,
  sourceEntryId,
  type EntityGraph,
  type KbIndex,
} from '#src/kb/entry-types.js';
import {
  buildCommunityIndexEntry,
  buildNoteIndexEntry,
  buildSourceIndexEntry,
  cloneKbIndex,
} from '#src/kb/corpus/index-records.js';
import { createKbRuntime } from '#src/kb/runtime.js';
import { createOramaBaseProjection } from '#src/kb/search/orama/backend.js';
import { bindEmbedding } from '#tests/unit/kb/expansion-test-helpers.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

const TOP_K = 10;
const QUERY_PANEL = ['graph retrieval', 'sqlite planner', 'community summary', 'metadata tags'];

type MutationScenario = {
  name: string;
  apply(runtime: ReturnType<typeof createKbRuntime>): Promise<{
    changedEntryIds: string[];
    deletedEntryIds: string[];
  }>;
};

function embedText(text: string): Float32Array {
  const buckets = [0, 0, 0, 0];
  for (let index = 0; index < text.length; index += 1) {
    buckets[index % buckets.length] += text.charCodeAt(index) * (index + 1);
  }

  let magnitude = 0;
  for (const bucket of buckets) {
    magnitude += bucket * bucket;
  }
  const scale = magnitude === 0 ? 1 : 1 / Math.sqrt(magnitude);
  return Float32Array.from(buckets.map((bucket) => bucket * scale));
}

function renderNote({
  title,
  tags,
  principles = [],
  source = ['kangig94/coral'],
  entrySeq,
  body,
}: {
  title: string;
  tags: string[];
  principles?: string[];
  source?: string[];
  entrySeq: number;
  body: string;
}): string {
  return [
    '---',
    `tags: [${tags.join(', ')}]`,
    `principles: [${principles.join(', ')}]`,
    'source:',
    ...source.map((entry) => `  - ${entry}`),
    'createdAt: 2026-04-01T00:00:00.000Z',
    'updatedAt: 2026-04-01T00:00:00.000Z',
    `entrySeq: ${entrySeq}`,
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function renderSource({
  title,
  tags,
  entrySeq,
  body,
}: {
  title: string;
  tags: string[];
  entrySeq: number;
  body: string;
}): string {
  return [
    '---',
    `title: ${title}`,
    'type: article',
    `tags: [${tags.join(', ')}]`,
    'importedAt: 2026-04-01',
    `entrySeq: ${entrySeq}`,
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function renderCommunity({
  title,
  members,
  summary,
  body,
}: {
  title: string;
  members: string[];
  summary: string;
  body: string;
}): string {
  return [
    '---',
    'createdAt: 2026-04-02',
    'updatedAt: 2026-04-02',
    'level: 1',
    '---',
    `# ${title}`,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Members',
    ...members.map((member) => `- #${member}`),
    '',
    body,
    '',
  ].join('\n');
}

async function listStoredDocuments(runtime: ReturnType<typeof createKbRuntime>) {
  const orama = await runtime.loadOramaSnapshotIfPresent();
  expect(orama).not.toBeNull();
  if (orama === null) {
    throw new Error('Expected persisted Orama snapshot to be present.');
  }

  const db = orama.db as typeof orama.db & {
    documentsStore: { getAll(docs: unknown): Record<number, Record<string, unknown>> };
    data: { docs: unknown };
  };
  const docs = db.documentsStore.getAll(db.data.docs);

  return Object.values(docs)
    .map((document) => ({
      entryId: String(document.entryId),
      contentHash: String(document.contentHash),
      metadataHash: String(document.metadataHash),
      vector: [...((document.vector as number[]) ?? [])],
    }))
    .sort((left, right) => left.entryId.localeCompare(right.entryId));
}

function canonicalizeHits(
  hits: Array<{
    entryId: string;
    score: number;
  }>,
) {
  return [...hits].sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (Math.abs(scoreDelta) > 1e-12) {
      return scoreDelta;
    }
    return left.entryId.localeCompare(right.entryId);
  });
}

async function expectCanonicalEquivalent(
  deltaRuntime: ReturnType<typeof createKbRuntime>,
  fullRuntime: ReturnType<typeof createKbRuntime>,
): Promise<void> {
  const deltaProjection = createOramaBaseProjection(deltaRuntime);
  const fullProjection = createOramaBaseProjection(fullRuntime);

  for (const query of QUERY_PANEL) {
    const deltaTextHits = canonicalizeHits((await deltaProjection.search(query, TOP_K, 'all')).hits);
    const fullTextHits = canonicalizeHits((await fullProjection.search(query, TOP_K, 'all')).hits);
    expect(deltaTextHits.length).toBe(fullTextHits.length);
    for (let index = 0; index < deltaTextHits.length; index += 1) {
      expect(deltaTextHits[index]?.entryId).toBe(fullTextHits[index]?.entryId);
      expect(Math.abs((deltaTextHits[index]?.score ?? 0) - (fullTextHits[index]?.score ?? 0))).toBeLessThanOrEqual(1e-9);
    }

    const queryVector = Array.from(embedText(query));
    const deltaVectorHits = canonicalizeHits((await deltaProjection.search(queryVector, TOP_K, 'all')).hits);
    const fullVectorHits = canonicalizeHits((await fullProjection.search(queryVector, TOP_K, 'all')).hits);
    expect(deltaVectorHits.length).toBe(fullVectorHits.length);
    for (let index = 0; index < deltaVectorHits.length; index += 1) {
      expect(deltaVectorHits[index]?.entryId).toBe(fullVectorHits[index]?.entryId);
      expect(Math.abs((deltaVectorHits[index]?.score ?? 0) - (fullVectorHits[index]?.score ?? 0))).toBeLessThanOrEqual(1e-9);
    }
  }

  expect(await listStoredDocuments(deltaRuntime)).toEqual(await listStoredDocuments(fullRuntime));
}

function seedCorpus(runtime: ReturnType<typeof createKbRuntime>): void {
  mkdirSync(runtime.notesDir(), { recursive: true });
  mkdirSync(runtime.sourcesDir(), { recursive: true });
  mkdirSync(runtime.communitiesDir(), { recursive: true });

  writeFileSync(
    runtime.notePath('graph-rag'),
    renderNote({
      title: 'Graph RAG',
      tags: ['graph-rag', 'retrieval'],
      principles: ['deterministic-ordering'],
      entrySeq: 1,
      body: 'Graph structure improves retrieval quality for note search.',
    }),
    'utf-8',
  );
  writeFileSync(
    runtime.notePath('sqlite-planner'),
    renderNote({
      title: 'SQLite Planner',
      tags: ['sqlite', 'planner'],
      entrySeq: 2,
      body: 'SQLite query planning benefits from predictable metadata.',
    }),
    'utf-8',
  );
  writeFileSync(
    runtime.notePath('metadata-note'),
    renderNote({
      title: 'Metadata Note',
      tags: ['metadata', 'commit'],
      entrySeq: 3,
      body: 'Metadata-only updates should preserve text authority.',
    }),
    'utf-8',
  );
  for (let index = 0; index < 40; index += 1) {
    const slug = `bulk-${String(index).padStart(2, '0')}`;
    writeFileSync(
      runtime.notePath(slug),
      renderNote({
        title: `Bulk ${index}`,
        tags: ['bulk', `topic-${index}`],
        entrySeq: index + 10,
        body: `Bulk note ${index} keeps the projection corpus large enough for inbound sync threshold tests.`,
      }),
      'utf-8',
    );
  }

  writeFileSync(
    runtime.sourcePath('retrieval-paper'),
    renderSource({
      title: 'Retrieval Paper',
      tags: ['retrieval', 'paper'],
      entrySeq: 4,
      body: 'A source document covering retrieval theory and graph search.',
    }),
    'utf-8',
  );
  writeFileSync(
    runtime.communityPath('retrieval-community'),
    renderCommunity({
      title: 'Retrieval Community',
      members: ['graph-rag', 'retrieval'],
      summary: 'Shared retrieval patterns across notes and sources.',
      body: 'Community body describing retrieval themes.',
    }),
    'utf-8',
  );

  const graph: EntityGraph = {
    entityMeta: {
      'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
      retrieval: { type: 'operation', description: 'Retrieval workflows.' },
      sqlite: { type: 'technology', description: 'SQLite query planning.' },
    },
    relationships: [
      {
        source: 'graph-rag',
        target: 'retrieval',
        type: 'enables',
        description: 'Graph RAG enables retrieval workflows.',
        evidence: ['note:graph-rag'],
      },
    ],
  };
  writeFileSync(runtime.entityGraphPath(), `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const entries: KbIndex['entries'] = {
    [noteEntryId('graph-rag')]: buildNoteIndexEntry({
      slug: 'graph-rag',
      title: 'Graph RAG',
      tags: ['graph-rag', 'retrieval'],
      principles: ['deterministic-ordering'],
      source: ['kangig94/coral'],
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      entrySeq: 1,
    }),
    [noteEntryId('sqlite-planner')]: buildNoteIndexEntry({
      slug: 'sqlite-planner',
      title: 'SQLite Planner',
      tags: ['sqlite', 'planner'],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      entrySeq: 2,
    }),
    [noteEntryId('metadata-note')]: buildNoteIndexEntry({
      slug: 'metadata-note',
      title: 'Metadata Note',
      tags: ['metadata', 'commit'],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      entrySeq: 3,
    }),
    [sourceEntryId('retrieval-paper')]: buildSourceIndexEntry({
      slug: 'retrieval-paper',
      title: 'Retrieval Paper',
      type: 'article',
      tags: ['retrieval', 'paper'],
      importedAt: '2026-04-01',
      entrySeq: 4,
    }),
    [communityEntryId('retrieval-community')]: buildCommunityIndexEntry({
      slug: 'retrieval-community',
      title: 'Retrieval Community',
      level: 1,
      members: ['graph-rag', 'retrieval'],
      summary: 'Shared retrieval patterns across notes and sources.',
      createdAt: '2026-04-02',
      updatedAt: '2026-04-02',
    }),
  };
  for (let index = 0; index < 40; index += 1) {
    const slug = `bulk-${String(index).padStart(2, '0')}`;
    entries[noteEntryId(slug)] = buildNoteIndexEntry({
      slug,
      title: `Bulk ${index}`,
      tags: ['bulk', `topic-${index}`],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      entrySeq: index + 10,
    });
  }

  runtime.writeIndex({
    entries,
    principles: {
      'deterministic-ordering': 'Sort values before assigning identifiers.',
    },
    entityMeta: graph.entityMeta,
    relationships: graph.relationships,
  });
  writeCurateState(runtime, {
    processedThrough: null,
    discoveryHighSeq: 0,
    discoveryOffset: 0,
    lastRunDay: null,
    lastAttemptedThrough: null,
    retryNotBefore: null,
    activeClaim: null,
    pendingDiscoveries: [],
    pendingRepair: null,
    communityTopologyHash: undefined,
    communitySummaryTopologyHash: undefined,
    communitySummaryInputFingerprints: undefined,
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
    initialized: true,
  });
}

async function installCurrentFullSnapshot(runtime: ReturnType<typeof createKbRuntime>): Promise<void> {
  const projection = createOramaBaseProjection(runtime);
  const preparedProjection = await projection.prepareFullSnapshotForCurrentCorpus(runtime.readIndexOrEmpty());
  await projection.installFullSnapshot(runtime.captureCorpusSnapshot(), preparedProjection);
}

async function createSeededRuntime(root: string): Promise<ReturnType<typeof createKbRuntime>> {
  const runtime = createTestKbRuntime({
    markdownRoot: root,
    runtimeDir: join(root, '.runtime'),
    db: createKbTestDb(join(root, '.runtime')),
  });
  await bindEmbedding(runtime, {
    async embedDocuments(texts: string[]) {
      return texts.map(embedText);
    },
    async embedQuery(text: string) {
      return embedText(text);
    },
  });
  seedCorpus(runtime);
  await installCurrentFullSnapshot(runtime);
  return runtime;
}

async function applyScenarioAndInstall(
  scenario: MutationScenario,
  runtime: ReturnType<typeof createKbRuntime>,
): Promise<void> {
  const projection = createOramaBaseProjection(runtime);
  await scenario.apply(runtime);
  const snapshot = runtime.captureCorpusSnapshot();

  const preparedProjection = await projection.prepareFullSnapshotForCurrentCorpus(runtime.readIndexOrEmpty());
  await projection.installFullSnapshot(snapshot, preparedProjection);
}

const scenarios: MutationScenario[] = [
  {
    name: 'single-entry content mutation',
    async apply(runtime) {
      writeFileSync(
        runtime.notePath('graph-rag'),
        renderNote({
          title: 'Graph RAG',
          tags: ['graph-rag', 'retrieval'],
          principles: ['deterministic-ordering'],
          entrySeq: 1,
          body: 'Graph structure improves retrieval quality and grounded ranking for note search.',
        }),
        'utf-8',
      );
      return { changedEntryIds: [noteEntryId('graph-rag')], deletedEntryIds: [] };
    },
  },
  {
    name: 'single-entry metadata-only mutation',
    async apply(runtime) {
      writeFileSync(
        runtime.notePath('metadata-note'),
        renderNote({
          title: 'Metadata Note',
          tags: ['metadata', 'dispatch'],
          entrySeq: 3,
          body: 'Metadata-only updates should preserve text authority.',
        }),
        'utf-8',
      );
      const nextIndex = cloneKbIndex(runtime.readIndexOrEmpty());
      nextIndex.entries[noteEntryId('metadata-note')] = buildNoteIndexEntry({
        slug: 'metadata-note',
        title: 'Metadata Note',
        tags: ['metadata', 'dispatch'],
        principles: [],
        source: ['kangig94/coral'],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        entrySeq: 3,
      });
      runtime.writeIndex(nextIndex);
      return { changedEntryIds: [noteEntryId('metadata-note')], deletedEntryIds: [] };
    },
  },
  {
    name: 'metadata-only mutation with entity-graph rewrite',
    async apply(runtime) {
      writeFileSync(
        runtime.notePath('metadata-note'),
        renderNote({
          title: 'Metadata Note',
          tags: ['metadata', 'entity-graph'],
          entrySeq: 3,
          body: 'Metadata-only updates should preserve text authority.',
        }),
        'utf-8',
      );
      const graph: EntityGraph = {
        entityMeta: {
          'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
          retrieval: { type: 'operation', description: 'Retrieval workflows.' },
          'entity-graph': { type: 'concept', description: 'Entity graph authority.' },
        },
        relationships: [
          {
            source: 'entity-graph',
            target: 'retrieval',
            type: 'enables',
            description: 'Entity graph relationships inform retrieval.',
            evidence: ['note:metadata-note'],
          },
        ],
      };
      writeFileSync(runtime.entityGraphPath(), `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

      const nextIndex = cloneKbIndex(runtime.readIndexOrEmpty());
      nextIndex.entries[noteEntryId('metadata-note')] = buildNoteIndexEntry({
        slug: 'metadata-note',
        title: 'Metadata Note',
        tags: ['metadata', 'entity-graph'],
        principles: [],
        source: ['kangig94/coral'],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        entrySeq: 3,
      });
      nextIndex.entityMeta = graph.entityMeta;
      nextIndex.relationships = graph.relationships;
      runtime.writeIndex(nextIndex);
      return { changedEntryIds: [noteEntryId('metadata-note')], deletedEntryIds: [] };
    },
  },
  {
    name: 'community rewrite',
    async apply(runtime) {
      writeFileSync(
        runtime.communityPath('retrieval-community'),
        renderCommunity({
          title: 'Retrieval Community',
          members: ['graph-rag', 'retrieval', 'sqlite'],
          summary: 'Updated community summary covering retrieval and sqlite planning.',
          body: 'Community body describing retrieval themes and sqlite coordination.',
        }),
        'utf-8',
      );
      const nextIndex = cloneKbIndex(runtime.readIndexOrEmpty());
      nextIndex.entries[communityEntryId('retrieval-community')] = buildCommunityIndexEntry({
        slug: 'retrieval-community',
        title: 'Retrieval Community',
        level: 1,
        members: ['graph-rag', 'retrieval', 'sqlite'],
        summary: 'Updated community summary covering retrieval and sqlite planning.',
        createdAt: '2026-04-02',
        updatedAt: '2026-04-02',
      });
      runtime.writeIndex(nextIndex);
      return { changedEntryIds: [communityEntryId('retrieval-community')], deletedEntryIds: [] };
    },
  },
  {
    name: 'entity-graph rewrite',
    async apply(runtime) {
      const graph: EntityGraph = {
        entityMeta: {
          'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
          retrieval: { type: 'operation', description: 'Retrieval workflows.' },
          planner: { type: 'operation', description: 'Planning workflows.' },
        },
        relationships: [
          {
            source: 'planner',
            target: 'retrieval',
            type: 'enables',
            description: 'Planning supports retrieval.',
            evidence: ['note:sqlite-planner'],
          },
        ],
      };
      writeFileSync(runtime.entityGraphPath(), `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');
      const nextIndex = cloneKbIndex(runtime.readIndexOrEmpty());
      nextIndex.entityMeta = graph.entityMeta;
      nextIndex.relationships = graph.relationships;
      runtime.writeIndex(nextIndex);
      return { changedEntryIds: [], deletedEntryIds: [] };
    },
  },
  {
    name: 'small-diff inbound sync',
    async apply(runtime) {
      writeFileSync(
        runtime.notePath('graph-rag'),
        renderNote({
          title: 'Graph RAG',
          tags: ['graph-rag', 'retrieval'],
          principles: ['deterministic-ordering'],
          entrySeq: 1,
          body: 'Inbound sync updated the graph retrieval note body.',
        }),
        'utf-8',
      );
      writeFileSync(
        runtime.sourcePath('retrieval-paper'),
        renderSource({
          title: 'Retrieval Paper',
          tags: ['retrieval', 'paper'],
          entrySeq: 4,
          body: 'Inbound sync updated the retrieval source body with fresh references.',
        }),
        'utf-8',
      );
      return {
        changedEntryIds: [noteEntryId('graph-rag'), sourceEntryId('retrieval-paper')],
        deletedEntryIds: [],
      };
    },
  },
  {
    name: 'large-diff inbound sync',
    async apply(runtime) {
      const changedEntryIds: string[] = [];
      for (let index = 0; index < 40; index += 1) {
        const slug = `bulk-${String(index).padStart(2, '0')}`;
        writeFileSync(
          runtime.notePath(slug),
          renderNote({
            title: `Bulk ${index}`,
            tags: ['bulk', `topic-${index}`],
            entrySeq: index + 10,
            body: `Large inbound sync refreshed bulk note ${index} with corpus-visible text changes.`,
          }),
          'utf-8',
        );
        changedEntryIds.push(noteEntryId(slug));
      }
      return { changedEntryIds, deletedEntryIds: [] };
    },
  },
];

describe('orama projection invariants', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  it.each(scenarios)('keeps full consumer installs deterministic for $name', async (scenario) => {
    const leftRoot = mkdtempSync(join(tmpdir(), 'coral-orama-left-'));
    const rightRoot = mkdtempSync(join(tmpdir(), 'coral-orama-right-'));
    tempRoots.push(leftRoot, rightRoot);

    const leftRuntime = await createSeededRuntime(leftRoot);
    const rightRuntime = await createSeededRuntime(rightRoot);

    await applyScenarioAndInstall(scenario, leftRuntime);
    await applyScenarioAndInstall(scenario, rightRuntime);

    await expectCanonicalEquivalent(leftRuntime, rightRuntime);
  });
});
