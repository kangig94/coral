import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type { EntityGraph } from '../types.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

const hybridMockState = vi.hoisted(() => ({
  ensureVectorIndex: null as null | ((...args: any[]) => Promise<any>),
  createEmbeddingProvider: null as null | ((...args: any[]) => Promise<any>),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
  };
});

vi.mock('../vector-sync.js', async () => {
  const actual = await vi.importActual<typeof import('../vector-sync.js')>('../vector-sync.js');
  return {
    ...actual,
    ensureVectorIndex: (...args: Parameters<typeof actual.ensureVectorIndex>) =>
      hybridMockState.ensureVectorIndex === null ? actual.ensureVectorIndex(...args) : hybridMockState.ensureVectorIndex(...args),
  };
});

vi.mock('../embedding.js', async () => {
  const actual = await vi.importActual<typeof import('../embedding.js')>('../embedding.js');
  return {
    ...actual,
    createEmbeddingProvider: (...args: Parameters<typeof actual.createEmbeddingProvider>) =>
      hybridMockState.createEmbeddingProvider === null
        ? actual.createEmbeddingProvider(...args)
        : hybridMockState.createEmbeddingProvider(...args),
  };
});

async function loadKbModules() {
  vi.resetModules();
  const [{ searchKb }, { reindex }, runtime, paths] = await Promise.all([
    import('../search.js'),
    import('../reindex.js'),
    import('../runtime.js'),
    import('../paths.js'),
  ]);
  return {
    searchKb,
    reindex,
    createKbRuntime: runtime.createKbRuntime,
    paths,
  };
}

function createRuntime(
  createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  return createKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir(),
  });
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

function writeSource(
  sourceDir: string,
  slug: string,
  {
    title,
    type = 'article',
    tags = [],
    body,
    importedAt = '2026-03-23',
    entrySeq = 1,
  }: {
    title: string;
    type?: string;
    tags?: string[];
    body: string;
    importedAt?: string;
    entrySeq?: number;
  },
): void {
  writeFileSync(
    join(sourceDir, `${slug}.md`),
    `---
title: ${title}
type: ${type}
tags: [${tags.join(', ')}]
importedAt: ${importedAt}
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
  writeFileSync(
    join(communityDir, `${slug}.md`),
    `${lines.join('\n')}\n`,
    'utf-8',
  );
}

/**
 * Ensure manually-written community files are indexed with fresh Orama freshness.
 *
 * The entity-graph topology refresh deletes community files on the first reindex
 * (topology hash changes from undefined to the empty-graph hash). Community summary
 * freshness requires stored fingerprints that can only be computed after the index
 * includes the community entries. Three reindex passes resolve the bootstrap:
 *   1. First reindex establishes the empty-graph topology hash in curate state.
 *   2. Re-write community files; second reindex indexes them (still stale).
 *   3. markCommunityStateFresh stores correct summary fingerprints.
 *   4. Third reindex inserts community Orama documents as fresh.
 */
async function ensureFreshCommunityIndex(
  kb: { readIndex: () => any },
  reindex: (kb: any) => Promise<any>,
  writeCommunities: () => void,
) {
  await reindex(kb);
  writeCommunities();
  await reindex(kb);
  await markCommunityStateFresh(kb);
  await reindex(kb);
}

async function markCommunityStateFresh(kb: { readIndex: () => any }) {
  const [{ computeCommunitySummaryInputFingerprints, computeCommunityTopologyFingerprint }, { readCurateState, writeCurateState }] =
    await Promise.all([import('../community-detection.js'), import('../curate-state.js')]);
  const index = kb.readIndex();
  expect(index).not.toBeNull();

  const communities = Object.values(index!.entries)
    .filter((entry: any) => entry.kind === 'community')
    .map((community: any) => ({
      slug: community.slug,
      title: community.title,
      level: community.level,
      members: community.members,
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(community.summary === undefined ? {} : { summary: community.summary }),
    }));
  const topologyHash = computeCommunityTopologyFingerprint(index!);
  const fingerprints = computeCommunitySummaryInputFingerprints(communities, kb as any, index!);

  writeCurateState(kb as any, {
    ...readCurateState(kb as any),
    communityTopologyHash: topologyHash,
    communitySummaryTopologyHash: topologyHash,
    communitySummaryInputFingerprints: fingerprints,
  });
}

function resultNotes(results: { note: string }[]): string[] {
  return results.map((result) => result.note);
}

function position(notes: string[], target: string): number {
  const index = notes.indexOf(target);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function resultFor<T extends { note: string }>(results: T[], target: string): T {
  const result = results.find((entry) => entry.note === target);
  expect(result).toBeDefined();
  return result!;
}

function mockHybridSearch(
  kb: {
    acquireVectorLease: (...args: any[]) => Promise<any>;
    readIndexState: () => { contentSeq: number; mutationSeq: number };
  },
  {
    searchVector,
    embedQuery = vi.fn().mockResolvedValue(new Float32Array([0.25, 0.75])),
    specId = 'spec-1',
    snapshotId = 'snapshot-1',
    indexedSeq = kb.readIndexState().contentSeq,
  }: {
    searchVector: (query: Float32Array, candidateK: number) => Promise<Array<{ chunkId: string; entryId: string; score: number }>>;
    embedQuery?: (query: string) => Promise<Float32Array>;
    specId?: string;
    snapshotId?: string;
    indexedSeq?: number;
  },
) {
  const release = vi.fn().mockResolvedValue(undefined);

  hybridMockState.ensureVectorIndex = vi.fn().mockResolvedValue({
    mode: 'hybrid',
    specId,
    vectorStatus: {
      indexedSeq,
      activeSnapshotId: snapshotId,
    },
  });
  hybridMockState.createEmbeddingProvider = vi.fn().mockResolvedValue({
    embedQuery,
  });
  kb.acquireVectorLease = vi.fn().mockResolvedValue({
    store: {
      searchVector,
    },
    specId,
    snapshotId,
    generation: 1,
    vectorStatus: {
      indexedSeq,
      activeSnapshotId: snapshotId,
    },
    release,
  });

  return {
    release,
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
    hybridMockState.ensureVectorIndex = null;
    hybridMockState.createEmbeddingProvider = null;
    vi.resetModules();
  });

  it('returns relevant results for a single keyword in text mode', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'rendering-guides', {
      title: 'Rendering Guides',
      tags: ['graphics'],
      body: 'Guiding contracts keep rendering predictable.',
    });
    writeNote(paths.notesDir(), 'pipeline-checklist', {
      title: 'Pipeline Checklist',
      tags: ['ops'],
      body: 'Rendering checklists help teams ship stable frames.',
    });
    writeNote(paths.notesDir(), 'contract-log', {
      title: 'Contract Log',
      tags: ['ops'],
      body: 'Audit notes only.',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'rendering', 10);

    expect(response.mode).toBe('text');
    expect(resultNotes(response.results)).toContain('rendering-guides');
    expect(resultNotes(response.results)).toContain('pipeline-checklist');
    expect(resultNotes(response.results)).not.toContain('contract-log');
  });

  it('uses pairwise assertions for multi-keyword BM25 ordering', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'rendering-guiding-contracts', {
      title: 'Rendering Guiding Contracts',
      body: 'Rendering guiding contracts keep teams aligned.',
    });
    writeNote(paths.notesDir(), 'rendering-guiding', {
      title: 'Rendering Guiding',
      body: 'Rendering guidance keeps pipelines readable.',
    });
    writeNote(paths.notesDir(), 'contracts-only', {
      title: 'Contracts Only',
      body: 'Contracts need audits.',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'rendering guiding contracts', 10);
    const notesByRank = resultNotes(response.results);

    expect(position(notesByRank, 'rendering-guiding-contracts')).toBeLessThan(
      position(notesByRank, 'rendering-guiding'),
    );
    expect(position(notesByRank, 'rendering-guiding')).toBeLessThan(position(notesByRank, 'contracts-only'));
  });

  it('returns subset hits at threshold 1, ranks stronger matches first, and keeps snippets for subset content hits', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'wfpg-cone-aperture', {
      title: 'WFPG Cone Aperture',
      body: 'WFPG cone aperture work keeps the calibration stable.',
    });
    writeNote(paths.notesDir(), 'wfpg-aperture-notes', {
      title: 'WFPG Aperture Notes',
      body: 'WFPG measurements focus on aperture changes during calibration.',
    });
    writeNote(paths.notesDir(), 'single-term', {
      title: 'Single Term',
      body: 'Cone checks only.',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'WFPG cone aperture', 10);
    const notesByRank = resultNotes(response.results);

    expect(notesByRank).toContain('wfpg-cone-aperture');
    expect(notesByRank).toContain('wfpg-aperture-notes');
    expect(notesByRank).toContain('single-term');
    expect(position(notesByRank, 'wfpg-cone-aperture')).toBeLessThan(position(notesByRank, 'wfpg-aperture-notes'));
    expect(position(notesByRank, 'wfpg-aperture-notes')).toBeLessThan(position(notesByRank, 'single-term'));

    const subsetMatch = resultFor(response.results, 'wfpg-aperture-notes');
    expect(subsetMatch.snippet).toBeDefined();
    expect(subsetMatch.snippet?.toLowerCase()).not.toContain('wfpg cone aperture');
  });

  it('derives matchedBy from token overlap across filename, principle, tag, title, and content', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'contract-first-design-surface', {
      title: 'Workflow Memo',
      tags: ['tokenized-tag'],
      principles: ['contract-first-design'],
      body: 'Alignment matters here.',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'contract first design tokenized tag workflow alignment', 10);
    const match = resultFor(response.results, 'contract-first-design-surface');

    expect(match.matchedBy).toEqual(['filename', 'principle', 'tag', 'title', 'content']);
  });

  it('finds content match and snippet for accented body text via Orama-aligned token anchor', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'cafe-memo', {
      title: 'Cafe Memo',
      body: 'café',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'cafe', 10);
    const match = resultFor(response.results, 'cafe-memo');

    expect(match.matchedBy).toEqual(expect.arrayContaining(['title', 'content']));
    expect(match.snippet).toBeDefined();
  });

  it('treats hyphenated metadata as equivalent to whitespace queries', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'contract-first-design', {
      title: 'Reference Note',
      tags: ['contract-first-design'],
      principles: ['contract-first-design'],
      body: 'This body avoids the query tokens.',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'contract first design', 10);
    const match = resultFor(response.results, 'contract-first-design');

    expect(match.matchedBy).toEqual(['filename', 'principle', 'tag']);
  });

  it('seeds graph ranking from aliases and bounded one-hop expansion instead of raw token overlap alone', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'memory-entry', {
      title: 'Opaque Memory Entry',
      tags: ['gpu-device-memory'],
      body: 'Archive only.',
    });
    writeNote(paths.notesDir(), 'runtime-entry', {
      title: 'Opaque Runtime Entry',
      tags: ['cuda-runtime-api'],
      body: 'Archive only.',
    });

    const graph: EntityGraph = {
      entityMeta: {
        'gpu-device-memory': {
          type: 'component',
          description: 'GPU device memory.',
          aliases: ['vram'],
        },
        'cuda-runtime-api': {
          type: 'technology',
          description: 'CUDA runtime APIs.',
        },
      },
      relationships: [
        {
          source: 'cuda-runtime-api',
          target: 'gpu-device-memory',
          type: 'enables',
          description: 'The runtime API manages device memory.',
          evidence: ['note:memory-entry'],
        },
      ],
    };
    kb.writeEntityGraph(graph);

    await reindex(kb);

    const aliasResponse = await searchKb(kb, 'vram', 5);
    expect(aliasResponse.mode).toBe('text');
    expect(resultNotes(aliasResponse.results).slice(0, 2)).toEqual(['memory-entry', 'runtime-entry']);
    expect(resultFor(aliasResponse.results, 'memory-entry').matchedBy).toEqual([]);
    expect(resultFor(aliasResponse.results, 'runtime-entry').matchedBy).toEqual([]);

    const exactResponse = await searchKb(kb, 'gpu-device-memory', 5);
    expect(resultNotes(exactResponse.results).slice(0, 2)).toEqual(['memory-entry', 'runtime-entry']);

    const phraseResponse = await searchKb(kb, 'cuda runtime api', 5);
    expect(resultNotes(phraseResponse.results).slice(0, 2)).toEqual(['runtime-entry', 'memory-entry']);
  });

  it('injects fresh community summaries into related note results when the graph and summaries are current', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    mkdirSync(paths.communitiesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'graph-rag-overview', {
      title: 'Graph RAG Overview',
      tags: ['graph-rag', 'retrieval'],
      body: 'Retrieval behavior depends on graph structure.',
    });
    writeNote(paths.notesDir(), 'retrieval-eval', {
      title: 'Retrieval Evaluation',
      tags: ['retrieval'],
      body: 'Retrieval quality depends on graph traces.',
    });

    kb.writeEntityGraph({
      entityMeta: {
        'graph-rag': {
          type: 'concept',
          description: 'Graph-backed retrieval.',
        },
        retrieval: {
          type: 'operation',
          description: 'Retrieval workflows.',
        },
      },
      relationships: [
        {
          source: 'graph-rag',
          target: 'retrieval',
          type: 'enables',
          description: 'Graph structure improves retrieval.',
          evidence: ['note:graph-rag-overview', 'note:retrieval-eval'],
        },
      ],
    });

    await reindex(kb);
    writeCommunity(paths.communitiesDir(), 'graph-rag-context', {
      title: 'Graph RAG',
      members: ['graph-rag', 'retrieval'],
      summary: 'Shared graph-backed retrieval patterns.',
      body: 'Community body.',
    });
    await reindex(kb);
    await markCommunityStateFresh(kb);

    const response = await searchKb(kb, 'retrieval', 5, 'all');

    expect(response.mode).toBe('text');
    expect(resultFor(response.results, 'graph-rag-overview').communityContext).toEqual([
      'Graph RAG: Shared graph-backed retrieval patterns.',
    ]);
    expect(resultFor(response.results, 'retrieval-eval').communityContext).toEqual([
      'Graph RAG: Shared graph-backed retrieval patterns.',
    ]);
  });

  it('filters stale community documents at query time for all and community scopes', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const { readCurateState, writeCurateState } = await import('../curate-state.js');
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    mkdirSync(paths.communitiesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'retrieval-note', {
      title: 'Retrieval Note',
      tags: ['retrieval'],
      body: 'Shared retrieval patterns appear here.',
    });
    writeCommunity(paths.communitiesDir(), 'graph-rag', {
      title: 'Graph RAG',
      members: ['retrieval'],
      summary: 'Shared retrieval patterns.',
      body: 'Shared retrieval patterns appear here too.',
    });

    await reindex(kb);
    writeCurateState(kb, {
      ...readCurateState(kb),
      communityTopologyHash: 'stale-topology',
      communitySummaryTopologyHash: 'stale-topology',
      communitySummaryInputFingerprints: {
        'graph-rag': 'stale-fingerprint',
      },
    });

    const allScope = await searchKb(kb, 'shared retrieval patterns', 5, 'all');
    const communityScope = await searchKb(kb, 'shared retrieval patterns', 5, 'communities');

    expect(resultNotes(allScope.results)).toContain('retrieval-note');
    expect(resultNotes(allScope.results)).not.toContain('graph-rag');
    expect(communityScope.results).toEqual([]);
  });

  it('rebuilds graph-aware search state on the next search after a manual entity graph edit', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'memory-entry', {
      title: 'Opaque Memory Entry',
      tags: ['gpu-device-memory'],
      body: 'Archive only.',
    });

    await reindex(kb);
    expect((await searchKb(kb, 'vram', 5)).results).toEqual([]);

    writeFileSync(
      kb.entityGraphPath(),
      `${JSON.stringify(
        {
          entityMeta: {
            'gpu-device-memory': {
              type: 'component',
              description: 'GPU device memory.',
              aliases: ['vram'],
            },
          },
          relationships: [],
        } satisfies EntityGraph,
        null,
        2,
      )}\n`,
      'utf-8',
    );
    // Ensure the entity graph file mtime is strictly after the index file
    // so detectTextArtifactRebuildInfo triggers a rebuild.
    const futureTime = new Date(Date.now() + 60_000);
    utimesSync(kb.entityGraphPath(), futureTime, futureTime);

    const response = await searchKb(kb, 'vram', 5);

    expect(resultNotes(response.results)).toEqual(['memory-entry']);
    expect(resultFor(response.results, 'memory-entry').matchedBy).toEqual([]);
  });

  it('fuses Orama and vector ranks with RRF for note and source entries', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    mkdirSync(paths.sourcesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'rendering-alpha', {
      title: 'Rendering Alpha',
      body: 'Rendering guides keep frames stable.',
    });
    writeNote(paths.notesDir(), 'beta-archive', {
      title: 'Beta Archive',
      body: 'Rendering notes keep pipelines aligned.',
    });
    writeSource(paths.sourcesDir(), 'gamma-reference', {
      title: 'Gamma Reference',
      body: 'Archive only.',
    });

    await reindex(kb);

    mockHybridSearch(kb, {
      searchVector: vi.fn().mockResolvedValue([
        { chunkId: 'beta:0', entryId: 'note:beta-archive', score: 0.99 },
        { chunkId: 'gamma:0', entryId: 'source:gamma-reference', score: 0.98 },
      ]),
    });

    const response = await searchKb(kb, 'rendering', 3);
    const notesByRank = resultNotes(response.results);

    expect(response.mode).toBe('hybrid');
    expect(position(notesByRank, 'beta-archive')).toBeLessThan(position(notesByRank, 'rendering-alpha'));
    expect(position(notesByRank, 'rendering-alpha')).toBeLessThan(position(notesByRank, 'gamma-reference'));
    expect(resultFor(response.results, 'beta-archive').matchedBy).toEqual(expect.arrayContaining(['content']));
    expect(resultFor(response.results, 'gamma-reference').matchedBy).toEqual([]);
  });

  it('widens vector candidates until topK distinct entries survive chunk aggregation', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'alpha-archive', {
      title: 'Alpha',
      body: 'Archive only.',
    });
    writeNote(paths.notesDir(), 'beta-history', {
      title: 'Beta',
      body: 'History only.',
    });

    await reindex(kb);

    const searchVector = vi.fn().mockImplementation(async (_query: Float32Array, candidateK: number) => {
      if (candidateK === 2) {
        return [
          { chunkId: 'alpha:0', entryId: 'note:alpha-archive', score: 0.99 },
          { chunkId: 'alpha:1', entryId: 'note:alpha-archive', score: 0.95 },
        ];
      }

      return [
        { chunkId: 'alpha:0', entryId: 'note:alpha-archive', score: 0.99 },
        { chunkId: 'alpha:1', entryId: 'note:alpha-archive', score: 0.95 },
        { chunkId: 'beta:0', entryId: 'note:beta-history', score: 0.88 },
        { chunkId: 'beta:1', entryId: 'note:beta-history', score: 0.84 },
      ];
    });

    mockHybridSearch(kb, { searchVector });

    const response = await searchKb(kb, 'semantic', 2);

    expect(response.mode).toBe('hybrid');
    expect(searchVector).toHaveBeenNthCalledWith(1, expect.any(Float32Array), 2);
    expect(searchVector).toHaveBeenNthCalledWith(2, expect.any(Float32Array), 4);
    expect(resultNotes(response.results)).toEqual(['alpha-archive', 'beta-history']);
    expect(resultFor(response.results, 'alpha-archive').matchedBy).toEqual([]);
    expect(resultFor(response.results, 'beta-history').matchedBy).toEqual([]);
    expect(resultFor(response.results, 'alpha-archive').snippet).toBeUndefined();
  });

  it('filters vector-only hits to the requested source scope', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    mkdirSync(paths.sourcesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'vector-note', {
      title: 'Vector Note',
      body: 'Archive only.',
    });
    writeSource(paths.sourcesDir(), 'vector-source', {
      title: 'Vector Source',
      body: 'History only.',
    });

    await reindex(kb);

    mockHybridSearch(kb, {
      searchVector: vi.fn().mockResolvedValue([
        { chunkId: 'note:0', entryId: 'note:vector-note', score: 0.99 },
        { chunkId: 'source:0', entryId: 'source:vector-source', score: 0.97 },
      ]),
    });

    const response = await searchKb(kb, 'semantic', 2, 'sources');

    expect(response.mode).toBe('hybrid');
    expect(resultNotes(response.results)).toEqual(['vector-source']);
    expect(resultFor(response.results, 'vector-source').kind).toBe('source');
    expect(resultFor(response.results, 'vector-source').matchedBy).toEqual([]);
  });

  it('keeps communities text-only in all scope while allowing vector-backed note results', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    mkdirSync(paths.communitiesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'latent-note', {
      title: 'Latent Note',
      body: 'Archive only.',
    });
    const writeCommunities = () => {
      writeCommunity(paths.communitiesDir(), 'graph-rag', {
        title: 'Graph RAG',
        members: ['graph-rag', 'retrieval'],
        summary: 'Shared retrieval patterns.',
        body: 'Retrieval patterns stay clustered here.',
      });
    };
    writeCommunities();

    await ensureFreshCommunityIndex(kb, reindex, writeCommunities);

    mockHybridSearch(kb, {
      searchVector: vi.fn().mockResolvedValue([{ chunkId: 'latent:0', entryId: 'note:latent-note', score: 0.99 }]),
    });

    const response = await searchKb(kb, 'retrieval', 2, 'all');

    expect(response.mode).toBe('hybrid');
    expect(resultNotes(response.results)).toEqual(expect.arrayContaining(['graph-rag', 'latent-note']));
    expect(resultFor(response.results, 'graph-rag').kind).toBe('community');
    expect(resultFor(response.results, 'graph-rag').matchedBy.length).toBeGreaterThan(0);
    expect(resultFor(response.results, 'latent-note').matchedBy).toEqual([]);
  });

  it('keeps community-only searches in pure text mode even when vector search is configured', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.communitiesDir(), { recursive: true });

    const writeCommunities = () => {
      writeCommunity(paths.communitiesDir(), 'graph-rag', {
        title: 'Graph RAG',
        members: ['graph-rag', 'retrieval'],
        summary: 'Shared retrieval patterns.',
        body: 'Retrieval patterns stay clustered here.',
      });
    };
    writeCommunities();

    await ensureFreshCommunityIndex(kb, reindex, writeCommunities);

    const acquireVectorLease = vi.spyOn(kb, 'acquireVectorLease');
    hybridMockState.ensureVectorIndex = vi.fn().mockResolvedValue({
      mode: 'hybrid',
      specId: 'spec-1',
      vectorStatus: {
        indexedSeq: kb.readIndexState().contentSeq,
        activeSnapshotId: 'snapshot-1',
      },
    });
    hybridMockState.createEmbeddingProvider = vi.fn().mockResolvedValue({
      embedQuery: vi.fn().mockResolvedValue(new Float32Array([0.25, 0.75])),
    });

    const response = await searchKb(kb, 'retrieval', 5, 'communities');

    expect(response.mode).toBe('text');
    expect(resultNotes(response.results)).toEqual(['graph-rag']);
    expect(acquireVectorLease).not.toHaveBeenCalled();
    expect(hybridMockState.ensureVectorIndex).not.toHaveBeenCalled();
    expect(hybridMockState.createEmbeddingProvider).not.toHaveBeenCalled();
  });

  it('keeps hybrid search enabled when only metadataSeq advances beyond the vector snapshot', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'hybrid-metadata-note', {
      title: 'Hybrid Metadata Note',
      body: 'Semantic retrieval target.',
    });

    await reindex(kb);
    kb.writeIndexState({
      contentSeq: 5,
      metadataSeq: 9,
      mutationSeq: 9,
      textIndexedSeq: 9,
      vector: { bySpec: {} },
    });

    mockHybridSearch(kb, {
      indexedSeq: 5,
      searchVector: vi.fn().mockResolvedValue([
        { chunkId: 'hybrid:0', entryId: 'note:hybrid-metadata-note', score: 0.99 },
      ]),
    });

    const response = await searchKb(kb, 'semantic', 5);

    expect(response.mode).toBe('hybrid');
    expect(resultNotes(response.results)).toContain('hybrid-metadata-note');
  });

  it('falls back to text mode when the vector snapshot lags behind contentSeq', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'stale-vector-note', {
      title: 'Stale Vector Note',
      body: 'Rendering guides keep frames stable.',
    });

    await reindex(kb);
    kb.writeIndexState({
      contentSeq: 6,
      metadataSeq: 9,
      mutationSeq: 9,
      textIndexedSeq: 9,
      vector: { bySpec: {} },
    });

    mockHybridSearch(kb, {
      indexedSeq: 5,
      searchVector: vi.fn().mockResolvedValue([{ chunkId: 'stale:0', entryId: 'note:stale-vector-note', score: 0.99 }]),
    });

    const response = await searchKb(kb, 'rendering', 5);

    expect(response.mode).toBe('text');
    expect(resultFor(response.results, 'stale-vector-note').matchedBy).toEqual(
      expect.arrayContaining(['content']),
    );
  });

  it('falls back to text mode when vector query embedding fails', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'rendering-guides', {
      title: 'Rendering Guides',
      body: 'Rendering guides keep frames stable.',
    });

    await reindex(kb);

    const { release } = mockHybridSearch(kb, {
      searchVector: vi.fn().mockResolvedValue([{ chunkId: 'rendering:0', entryId: 'note:rendering-guides', score: 0.99 }]),
      embedQuery: vi.fn().mockRejectedValue(new Error('embedding offline')),
    });

    const response = await searchKb(kb, 'rendering', 5);

    expect(response.mode).toBe('text');
    expect(resultNotes(response.results)).toEqual(['rendering-guides']);
    expect(resultFor(response.results, 'rendering-guides').matchedBy).toEqual(
      expect.arrayContaining(['filename', 'title', 'content']),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('auto-rebuilds when the search index is missing', async () => {
    const { searchKb, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);

    await expect(searchKb(kb, 'rendering', 10)).resolves.toEqual({
      results: [],
      mode: 'text',
    });
    expect(kb.readIndex()).toEqual({
      entries: {},
      principles: {},
    });
  });
});
