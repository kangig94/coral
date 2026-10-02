import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import type { ConsumerHandleStatus } from '#src/store/consumer-contract.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { type KbEntryId, type KbSearchResponse } from '#src/kb/entry-types.js';
import {
  bindEmbedding,
  bindOramaFtsForTest,
  createCorpusHandle,
  bindVectorBacked,
  seedVectorRouteState,
} from '#tests/unit/kb/expansion-test-helpers.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { applyBoundCorpusConsumerForTest, createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

const writableDbByRuntime = new WeakMap<KbRuntime, ReturnType<typeof openKbTestStoreDb>>();

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
  };
});

async function loadKbModules() {
  vi.resetModules();
  const [{ searchKb }, { reindex }, runtime, paths] = await Promise.all([
    import('#src/kb/ops/search.js'),
    import('#src/kb/ops/reindex.js'),
    import('#src/kb/runtime.js'),
    import('#src/kb/paths.js'),
  ]);
  return {
    searchKb,
    reindex,
    createKbRuntime: runtime.createKbRuntime,
    paths,
  };
}

function createRuntime(
  _createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  _paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  const db = openKbTestStoreDb(':memory:');
  const { kb } = createKbTestRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: kbRuntimePaths('prod').root,
    db,
  });
  writableDbByRuntime.set(kb, db);
  bindOramaFtsForTest(kb);
  return kb;
}

function seedRouteState(
  kb: KbRuntime,
  snapshot: Parameters<typeof seedVectorRouteState>[1],
  options?: Parameters<typeof seedVectorRouteState>[2],
): ReturnType<typeof seedVectorRouteState> {
  return seedVectorRouteState(writableDbByRuntime.get(kb)!, snapshot, options);
}

async function applyOramaProjection(kb: KbRuntime): Promise<void> {
  await applyBoundCorpusConsumerForTest(kb, writableDbByRuntime.get(kb)!);
}

function writeNote(
  noteDir: string,
  slug: string,
  {
    title,
    tags = [],
    principles = [],
    body,
    entrySeq = 1,
  }: {
    title: string;
    tags?: string[];
    principles?: string[];
    body: string;
    entrySeq?: number;
  },
): void {
  writeFileSync(
    join(noteDir, `${slug}.md`),
    `---
tags: [${tags.join(', ')}]
principles: [${principles.join(', ')}]
source:
  - kangig94/coral
createdAt: 2026-03-23
updatedAt: 2026-03-23
entrySeq: ${entrySeq}
---
# ${title}

${body}
`,
    'utf-8',
  );
}

function writeCommunity(
  communityDir: string,
  slug: string,
  {
    title,
    members,
    level = 0,
    parent,
    children,
    summary,
    body,
  }: {
    title: string;
    members: string[];
    level?: number;
    parent?: string;
    children?: string[];
    summary?: string;
    body: string;
  },
): void {
  const lines = [
    '---',
    'createdAt: 2026-04-02',
    'updatedAt: 2026-04-02',
    `level: ${level}`,
    ...(parent === undefined ? [] : [`parent: ${parent}`]),
    ...(children === undefined ? [] : ['children:', ...children.map((child) => `  - ${child}`)]),
    '---',
    `# ${title}`,
    '',
    ...(summary === undefined ? [] : ['## Summary', '', summary, '']),
    '## Members',
    ...members.map((member) => `- #${member}`),
    '',
    body,
    '',
  ];
  writeFileSync(join(communityDir, `${slug}.md`), `${lines.join('\n')}\n`, 'utf-8');
}

function resultNotes(results: { note: string }[]): string[] {
  return results.map((result) => result.note);
}

function resultFor<T extends { note: string }>(results: T[], target: string): T {
  const result = results.find((entry) => entry.note === target);
  expect(result).toBeDefined();
  return result!;
}

function expectMigratedShape(response: KbSearchResponse): void {
  expect(Array.isArray(response.retrievalDiagnostics)).toBe(true);
  for (const result of response.results) {
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(result).not.toHaveProperty('graphRank');
  }
}

type MockVectorChunkHit = {
  chunkId: string;
  entryId: KbEntryId;
  score: number;
};

function scopeAllowsVectorKind(
  kind: 'note' | 'source',
  scope: 'all' | 'notes' | 'sources' | 'communities' | undefined,
): boolean {
  if (scope === undefined || scope === 'all') {
    return true;
  }
  if (scope === 'notes') {
    return kind === 'note';
  }
  if (scope === 'sources') {
    return kind === 'source';
  }
  return false;
}

function aggregateMockVectorHits(
  kb: {
    readIndex: () => { entries: Record<string, any> } | null;
  },
  rawHits: MockVectorChunkHit[],
  scope: 'all' | 'notes' | 'sources' | 'communities' | undefined,
) {
  const index = kb.readIndex();
  if (index === null) {
    return [];
  }

  const aggregated = new Map<
    string,
    {
      entryId: KbEntryId;
      slug: string;
      kind: 'note' | 'source';
      title: string;
      tags: string[];
      principles: string[];
      score: number;
    }
  >();

  for (const rawHit of rawHits) {
    const entry = index.entries[rawHit.entryId];
    if (entry === undefined || (entry.kind !== 'note' && entry.kind !== 'source')) {
      continue;
    }
    if (!scopeAllowsVectorKind(entry.kind, scope)) {
      continue;
    }

    const previous = aggregated.get(rawHit.entryId);
    if (previous !== undefined && previous.score >= rawHit.score) {
      continue;
    }

    aggregated.set(rawHit.entryId, {
      entryId: rawHit.entryId,
      slug: entry.slug,
      kind: entry.kind,
      title: entry.title,
      tags: [...entry.tags],
      principles: entry.kind === 'note' ? [...entry.principles] : [],
      score: rawHit.score,
    });
  }

  return [...aggregated.values()]
    .sort((left, right) => right.score - left.score || left.entryId.localeCompare(right.entryId))
    .map((hit, index) => ({
      ...hit,
      rank: index + 1,
    }));
}

async function installMockHybridSearch(
  kb: KbRuntime & {
    readIndex: () => { entries: Record<string, any> } | null;
  },
  routeState: Extract<ConsumerHandleStatus, { authority: 'corpus' }>,
  {
    searchVector,
    embedQuery = vi.fn().mockResolvedValue(new Float32Array([0.25, 0.75])),
  }: {
    searchVector: (query: Float32Array, candidateK: number) => Promise<MockVectorChunkHit[]>;
    embedQuery?: (query: string) => Promise<Float32Array>;
  },
) {
  await bindEmbedding(kb, {
    embedDocuments: vi.fn(async () => []),
    embedQuery,
  });
  bindVectorBacked(
    kb,
    {
      search: async (embedding: number[], topK: number, scope?: 'all' | 'notes' | 'sources' | 'communities') => {
        let candidateK = Math.max(topK, 1);
        const candidateCap = Math.max(topK, 10 * topK);
        let rawHits = await searchVector(Float32Array.from(embedding), candidateK);
        let hits = aggregateMockVectorHits(kb, rawHits, scope);
        let exhausted = rawHits.length < candidateK;

        while (hits.length < topK && !exhausted && candidateK < candidateCap) {
          candidateK = Math.min(candidateCap, candidateK * 2);
          rawHits = await searchVector(Float32Array.from(embedding), candidateK);
          hits = aggregateMockVectorHits(kb, rawHits, scope);
          exhausted = rawHits.length < candidateK;
        }

        return { hits: hits.slice(0, topK) };
      },
    },
    createCorpusHandle(routeState),
  );

  return {
    embedQuery,
  };
}

describe('kb search', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-search-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('returns relevant results for a single keyword in text mode', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'rendering-guides', {
      title: 'Rendering Guides',
      tags: ['graphics'],
      body: 'Guiding contracts keep rendering predictable.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'pipeline-checklist', {
      title: 'Pipeline Checklist',
      tags: ['ops'],
      body: 'Rendering checklists help teams ship stable frames.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'contract-log', {
      title: 'Contract Log',
      tags: ['ops'],
      body: 'Audit notes only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);

    const response = await searchKb(kb, 'rendering', 10);

    expect(response.mode).toBe('text');
    expectMigratedShape(response);
    expect(resultNotes(response.results)).toContain('rendering-guides');
    expect(resultNotes(response.results)).toContain('pipeline-checklist');
    expect(resultNotes(response.results)).not.toContain('contract-log');
  });

  it('filters stale community documents at query time for all and community scopes', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.communitiesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'retrieval-note', {
      title: 'Retrieval Note',
      tags: ['retrieval'],
      body: 'Shared retrieval patterns appear here.',
    });
    writeCommunity(paths.communitiesDir(process.env.CORAL_KB_PATH!), 'graph-rag', {
      title: 'Graph RAG',
      members: ['retrieval'],
      summary: 'Shared retrieval patterns.',
      body: 'Shared retrieval patterns appear here too.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);

    const allScope = await searchKb(kb, 'shared retrieval patterns', 5, 'all');
    const communityScope = await searchKb(kb, 'shared retrieval patterns', 5, 'communities');

    expect(resultNotes(allScope.results)).toContain('retrieval-note');
    expect(resultNotes(allScope.results)).not.toContain('graph-rag');
    expect(communityScope.results).toEqual([]);
  });

  it('reports kb.vector remediation for explicit vector search without vector binding', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'vector-alpha', {
      title: 'Vector Alpha',
      body: 'Archive only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    await bindEmbedding(kb, {
      embedDocuments: vi.fn(async () => []),
      embedQuery: vi.fn().mockResolvedValue(new Float32Array([0.25, 0.75])),
    });

    const error = await searchKb(kb, 'semantic', 2, 'all', 'vector').catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'binding_empty',
      userMessage: 'Vector search needs kb.vector.',
      remediation:
        "Run `coral-cli expansion list` to find an engine that fills 'kb.vector', then `coral-cli expansion equip <name>`. FTS-only search continues to work zero-config.",
      context: { binding: 'kb.vector' },
    });
    expect((error as { userMessage: string }).userMessage).not.toContain('embedder');
    expect((error as { remediation: string }).remediation).not.toContain('--binding');
  });

  it('keeps hybrid search enabled when the vector snapshot lags behind contentSeq', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'stale-vector-note', {
      title: 'Stale Vector Note',
      body: 'Rendering guides keep frames stable.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    const snapshot = kb.captureCorpusSnapshot();
    const routeState = seedRouteState(
      kb,
      {
        ...snapshot,
        contentSeq: snapshot.contentSeq + 1,
        snapshotId: `${snapshot.snapshotId}-stale`,
        contentManifestHash: `stale-${snapshot.contentManifestHash}`,
        metadataManifestHash: snapshot.metadataManifestHash,
      },
      {
        cursorContentManifestHash: snapshot.contentManifestHash,
      },
    );

    await installMockHybridSearch(kb, routeState, {
      searchVector: vi.fn().mockResolvedValue([{ chunkId: 'stale:0', entryId: 'note:stale-vector-note', score: 0.99 }]),
    });

    const response = await searchKb(kb, 'rendering', 5);

    expect(response.mode).toBe('hybrid');
    expect(resultFor(response.results, 'stale-vector-note').matchedBy).toEqual(expect.arrayContaining(['content']));
  });

  it('auto-rebuilds when the search index is missing', async () => {
    const { searchKb, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);

    await expect(searchKb(kb, 'rendering', 10)).resolves.toEqual({
      results: [],
      mode: 'text',
      retrievalDiagnostics: [],
      warnings: ['kb_search_degraded_until_coordinator_rebuild'],
    });
    expect(kb.readIndex()).toBeNull();
  });
});
