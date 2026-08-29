import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { writeCurateState } from '#src/kb/curate/state/index.js';
import { createKbProjectionInput } from '#src/kb/projection-input.js';
import { communityEntryId, noteEntryId, sourceEntryId, type EntityGraph, type KbIndex } from '#src/kb/entry-types.js';
import { buildCommunityIndexEntry, buildNoteIndexEntry, buildSourceIndexEntry } from '#src/kb/corpus/index/records.js';
import { type createKbRuntime } from '#src/kb/runtime.js';
import { createOramaBaseProjection } from '#src/engines/orama/base-projection.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { curateDb } from '../../../../src/kb/curate/db-access.js';

const TOP_K = 10;
const QUERY_PANEL = ['graph retrieval', 'sqlite planner', 'community summary', 'metadata tags'];

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

function canonicalizeHits(
  hits: ReadonlyArray<{
    documentId: string;
    score: number;
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

async function expectCanonicalEquivalent(
  deltaRuntime: ReturnType<typeof createKbRuntime>,
  fullRuntime: ReturnType<typeof createKbRuntime>,
): Promise<void> {
  const deltaProjection = createOramaBaseProjection(
    deltaRuntime,
    new OramaSnapshotStore(
      { files: deltaRuntime.projectionArtifacts.files },
      deltaRuntime.projectionArtifacts.runtimeDir,
    ),
  );
  const fullProjection = createOramaBaseProjection(
    fullRuntime,
    new OramaSnapshotStore(
      { files: fullRuntime.projectionArtifacts.files },
      fullRuntime.projectionArtifacts.runtimeDir,
    ),
  );

  for (const query of QUERY_PANEL) {
    const deltaTextHits = canonicalizeHits((await deltaProjection.search(query, TOP_K, 'all')).hits);
    const fullTextHits = canonicalizeHits((await fullProjection.search(query, TOP_K, 'all')).hits);
    expect(deltaTextHits.length).toBe(fullTextHits.length);
    for (let index = 0; index < deltaTextHits.length; index += 1) {
      expect(deltaTextHits[index]?.documentId).toBe(fullTextHits[index]?.documentId);
      expect(Math.abs((deltaTextHits[index]?.score ?? 0) - (fullTextHits[index]?.score ?? 0))).toBeLessThanOrEqual(
        1e-9,
      );
    }
  }
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
    },
    relationships: [],
  };
  writeFileSync(runtime.entityGraphPath(), `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  const entries: KbIndex['entries'] = {
    [noteEntryId('graph-rag')]: buildNoteIndexEntry({
      slug: 'graph-rag',
      title: 'Graph RAG',
      body: 'Graph structure improves retrieval quality for note search.',
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
      body: 'SQLite query planning benefits from predictable metadata.',
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
      body: 'Metadata-only updates should preserve text authority.',
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
      body: 'A source document covering retrieval theory and graph search.',
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

  runtime.writeIndex({
    entries,
    principles: {
      'deterministic-ordering': 'Sort values before assigning identifiers.',
    },
    entityMeta: graph.entityMeta,
    relationships: graph.relationships,
  });
  writeCurateState(curateDb(runtime), {
    processedThrough: null,
    discoveryHighSeq: 0,
    discoveryOffset: 0,
    lastRunDay: null,
    lastAttemptedThrough: null,
    retryNotBefore: null,
    activeClaim: null,
    pendingDiscoveries: [],
    communitySummaryTopologyHash: undefined,
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
    claimLaneDisabledAt: null,
    communityBatchLaneDisabledAt: null,
    initialized: true,
  });
}

async function installCurrentFullSnapshot(runtime: ReturnType<typeof createKbRuntime>): Promise<void> {
  const projection = createOramaBaseProjection(
    runtime,
    new OramaSnapshotStore({ files: runtime.projectionArtifacts.files }, runtime.projectionArtifacts.runtimeDir),
  );
  const preparedProjection = await projection.prepareFullSnapshot(createKbProjectionInput(runtime));
  await projection.installFullSnapshot(runtime.captureCorpusSnapshot(), preparedProjection);
}

async function createSeededRuntime(root: string): Promise<ReturnType<typeof createKbRuntime>> {
  const runtime = createTestKbRuntime({
    markdownRoot: root,
    runtimeDir: join(root, '.runtime'),
    db: createKbTestDb(join(root, '.runtime')),
  });
  seedCorpus(runtime);
  await installCurrentFullSnapshot(runtime);
  return runtime;
}

describe('orama projection invariants', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop()!, { recursive: true, force: true });
    }
  });

  it('keeps full consumer installs deterministic across two seeded runtimes', async () => {
    const leftRoot = mkdtempSync(join(tmpdir(), 'coral-orama-left-'));
    const rightRoot = mkdtempSync(join(tmpdir(), 'coral-orama-right-'));
    tempRoots.push(leftRoot, rightRoot);

    const leftRuntime = await createSeededRuntime(leftRoot);
    const rightRuntime = await createSeededRuntime(rightRoot);

    await expectCanonicalEquivalent(leftRuntime, rightRuntime);
  });
});
