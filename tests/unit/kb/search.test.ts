import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type { ConsumerHandleStatus } from '#src/store/consumer-contract.js';
import type { KbRuntime } from '#src/kb/contract.js';
import type { EntityGraph, KbEntryId, KbSearchResponse } from '#src/kb/entry-types.js';
import {
  bindEmbedding,
  bindOramaFtsForTest,
  createCorpusHandle,
  bindVectorBacked,
  seedNeedleRouteState,
} from '#tests/unit/kb/expansion-test-helpers.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { applyBoundCorpusConsumerForTest, createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { curateDb } from '../../../src/kb/curate/db-access.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

const writableDbByRuntime = new WeakMap<KbRuntime, ReturnType<typeof createKbTestDb>>();

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
  paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  const db = createKbTestDb(paths.kbRuntimeDir('prod'));
  const { kb } = createKbTestRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir('prod'),
    db,
  });
  writableDbByRuntime.set(kb, db);
  bindOramaFtsForTest(kb);
  return kb;
}

function seedRouteState(
  kb: KbRuntime,
  snapshot: Parameters<typeof seedNeedleRouteState>[1],
  options?: Parameters<typeof seedNeedleRouteState>[2],
): ReturnType<typeof seedNeedleRouteState> {
  return seedNeedleRouteState(writableDbByRuntime.get(kb)!, snapshot, options);
}

async function applyOramaProjection(kb: KbRuntime): Promise<void> {
  await applyBoundCorpusConsumerForTest(kb, writableDbByRuntime.get(kb)!);
}

function setMtime(path: string, mtime: Date): void {
  utimesSync(path, mtime, mtime);
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
  writeFileSync(join(communityDir, `${slug}.md`), `${lines.join('\n')}\n`, 'utf-8');
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
  kb: KbRuntime,
  reindex: (kb: any) => Promise<any>,
  writeCommunities: () => void,
) {
  await reindex(kb);
  await applyOramaProjection(kb);
  writeCommunities();
  await reindex(kb);
  await applyOramaProjection(kb);
  await markCommunityStateFresh(kb);
  await reindex(kb);
  await applyOramaProjection(kb);
}

async function markCommunityStateFresh(kb: { readIndex: () => any; recordMutationCommitted?: any }) {
  const [
    { computeCommunityTopologyFingerprint },
    { computeCommunitySummaryInputFingerprints },
    { readCurateState, writeCurateState },
  ] = await Promise.all([
    import('#src/kb/curate/community/detection.js'),
    import('#src/kb/curate/community/summary.js'),
    import('#src/kb/curate/state/index.js'),
  ]);
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
  const topologyHash = computeCommunityTopologyFingerprint(index);
  const fingerprints = computeCommunitySummaryInputFingerprints(communities, kb as any, index);

  writeCurateState(curateDb(kb as any), {
    ...readCurateState(curateDb(kb as any)),
    communityTopologyHash: topologyHash,
    communitySummaryTopologyHash: topologyHash,
    communitySummaryInputFingerprints: fingerprints,
  });
  // Mirror production: curate state freshness changes are paired with a metadata
  // mutation record so the corpus snapshot bumps and downstream consumers (Orama
  // projection apply) re-materialize with the new community freshness.
  kb.recordMutationCommitted?.('metadata', 'test:markCommunityStateFresh');
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

function expectMigratedShape(response: KbSearchResponse): void {
  expect(Array.isArray(response.retrievalDiagnostics)).toBe(true);
  for (const result of response.results) {
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(result).not.toHaveProperty('graphRank');
  }
}

type MockNeedleChunkHit = {
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

function aggregateMockNeedleHits(
  kb: {
    readIndex: () => { entries: Record<string, any> } | null;
  },
  rawHits: MockNeedleChunkHit[],
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
    searchVector: (query: Float32Array, candidateK: number) => Promise<MockNeedleChunkHit[]>;
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
        let hits = aggregateMockNeedleHits(kb, rawHits, scope);
        let exhausted = rawHits.length < candidateK;

        while (hits.length < topK && !exhausted && candidateK < candidateCap) {
          candidateK = Math.min(candidateCap, candidateK * 2);
          rawHits = await searchVector(Float32Array.from(embedding), candidateK);
          hits = aggregateMockNeedleHits(kb, rawHits, scope);
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

  it('uses pairwise assertions for multi-keyword BM25 ordering', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'rendering-guiding-contracts', {
      title: 'Rendering Guiding Contracts',
      body: 'Rendering guiding contracts keep teams aligned.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'rendering-guiding', {
      title: 'Rendering Guiding',
      body: 'Rendering guidance keeps pipelines readable.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'contracts-only', {
      title: 'Contracts Only',
      body: 'Contracts need audits.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);

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
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'wfpg-cone-aperture', {
      title: 'WFPG Cone Aperture',
      body: 'WFPG cone aperture work keeps the calibration stable.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'wfpg-aperture-notes', {
      title: 'WFPG Aperture Notes',
      body: 'WFPG measurements focus on aperture changes during calibration.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'single-term', {
      title: 'Single Term',
      body: 'Cone checks only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);

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
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'contract-first-design-surface', {
      title: 'Workflow Memo',
      tags: ['tokenized-tag'],
      principles: ['contract-first-design'],
      body: 'Alignment matters here.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);

    const response = await searchKb(kb, 'contract first design tokenized tag workflow alignment', 10);
    const match = resultFor(response.results, 'contract-first-design-surface');

    expect(match.matchedBy).toEqual(['filename', 'principle', 'tag', 'title', 'content']);
  });

  it('finds content match and snippet for accented body text via Orama-aligned token anchor', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'cafe-memo', {
      title: 'Cafe Memo',
      body: 'café',
    });

    await reindex(kb);
    await applyOramaProjection(kb);

    const response = await searchKb(kb, 'cafe', 10);
    const match = resultFor(response.results, 'cafe-memo');

    expect(match.matchedBy).toEqual(expect.arrayContaining(['title', 'content']));
    expect(match.snippet).toBeDefined();
  });

  it('treats hyphenated metadata as equivalent to whitespace queries', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'contract-first-design', {
      title: 'Reference Note',
      tags: ['contract-first-design'],
      principles: ['contract-first-design'],
      body: 'This body avoids the query tokens.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);

    const response = await searchKb(kb, 'contract first design', 10);
    const match = resultFor(response.results, 'contract-first-design');

    expect(match.matchedBy).toEqual(['filename', 'principle', 'tag']);
  });

  it('seeds graph ranking from aliases and bounded one-hop expansion instead of raw token overlap alone', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'memory-entry', {
      title: 'Opaque Memory Entry',
      tags: ['gpu-device-memory'],
      body: 'Archive only.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'runtime-entry', {
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
    await kb.writeEntityGraph(graph);

    await reindex(kb);
    await applyOramaProjection(kb);

    const aliasResponse = await searchKb(kb, 'vram', 5);
    expect(aliasResponse.mode).toBe('text');
    expectMigratedShape(aliasResponse);
    expect(resultNotes(aliasResponse.results).slice(0, 2)).toEqual(['memory-entry', 'runtime-entry']);
    expect(resultFor(aliasResponse.results, 'memory-entry').matchedBy).toEqual([]);
    expect(resultFor(aliasResponse.results, 'memory-entry').evidence.some((item) => item.roleId === 'graph')).toBe(
      true,
    );
    expect(resultFor(aliasResponse.results, 'runtime-entry').matchedBy).toEqual([]);
    expect(resultFor(aliasResponse.results, 'runtime-entry').evidence.some((item) => item.roleId === 'graph')).toBe(
      true,
    );

    const exactResponse = await searchKb(kb, 'gpu-device-memory', 5);
    expectMigratedShape(exactResponse);
    expect(resultNotes(exactResponse.results).slice(0, 2)).toEqual(['memory-entry', 'runtime-entry']);

    const phraseResponse = await searchKb(kb, 'cuda runtime api', 5);
    expectMigratedShape(phraseResponse);
    expect(resultNotes(phraseResponse.results).slice(0, 2)).toEqual(['runtime-entry', 'memory-entry']);
  });

  it('injects fresh community summaries into related note results when the graph and summaries are current', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.communitiesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'graph-rag-overview', {
      title: 'Graph RAG Overview',
      tags: ['graph-rag', 'retrieval'],
      body: 'Retrieval behavior depends on graph structure.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'retrieval-eval', {
      title: 'Retrieval Evaluation',
      tags: ['retrieval'],
      body: 'Retrieval quality depends on graph traces.',
    });

    await kb.writeEntityGraph({
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
    await applyOramaProjection(kb);
    writeCommunity(paths.communitiesDir(process.env.CORAL_KB_PATH!), 'graph-rag-context', {
      title: 'Graph RAG',
      members: ['graph-rag', 'retrieval'],
      summary: 'Shared graph-backed retrieval patterns.',
      body: 'Community body.',
    });
    await reindex(kb);
    await applyOramaProjection(kb);
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
    const { readCurateState, writeCurateState } = await import('#src/kb/curate/state/index.js');
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
    writeCurateState(curateDb(kb), {
      ...readCurateState(curateDb(kb)),
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

  it('rebuilds graph-aware search state after ensureCorpusFreshness observes a manual entity graph edit', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'memory-entry', {
      title: 'Opaque Memory Entry',
      tags: ['gpu-device-memory'],
      body: 'Archive only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
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
    const indexMtimeMs = statSync(join(kb.runtimeDir, 'index.json')).mtimeMs;
    let editedGraphMtimeMs = Date.now();
    while (editedGraphMtimeMs <= indexMtimeMs) {
      editedGraphMtimeMs = Date.now();
    }
    setMtime(kb.entityGraphPath(), new Date(editedGraphMtimeMs));
    await kb.ensureCorpusFreshness();
    await applyBoundCorpusConsumerForTest(kb, writableDbByRuntime.get(kb)!);
    const response = await searchKb(kb, 'vram', 5);

    expect(resultNotes(response.results)).toEqual(['memory-entry']);
    expect(resultFor(response.results, 'memory-entry').matchedBy).toEqual([]);
  });

  it('fuses Orama and vector ranks with RRF for note and source entries', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.sourcesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'rendering-alpha', {
      title: 'Rendering Alpha',
      body: 'Rendering guides keep frames stable.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'beta-archive', {
      title: 'Beta Archive',
      body: 'Rendering notes keep pipelines aligned.',
    });
    writeSource(paths.sourcesDir(process.env.CORAL_KB_PATH!), 'gamma-reference', {
      title: 'Gamma Reference',
      body: 'Archive only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    await installMockHybridSearch(kb, seedRouteState(kb, kb.captureCorpusSnapshot()), {
      searchVector: vi.fn().mockResolvedValue([
        { chunkId: 'beta:0', entryId: 'note:beta-archive', score: 0.99 },
        { chunkId: 'gamma:0', entryId: 'source:gamma-reference', score: 0.98 },
      ]),
    });

    const response = await searchKb(kb, 'rendering', 3);
    const notesByRank = resultNotes(response.results);

    expect(response.mode).toBe('hybrid');
    expectMigratedShape(response);
    expect(position(notesByRank, 'beta-archive')).toBeLessThan(position(notesByRank, 'rendering-alpha'));
    expect(position(notesByRank, 'rendering-alpha')).toBeLessThan(position(notesByRank, 'gamma-reference'));
    expect(resultFor(response.results, 'beta-archive').matchedBy).toEqual(expect.arrayContaining(['content']));
    expect(resultFor(response.results, 'beta-archive').evidence.map((item) => item.roleId)).toEqual(['text', 'vector']);
    expect(resultFor(response.results, 'gamma-reference').matchedBy).toEqual([]);
    expect(resultFor(response.results, 'gamma-reference').evidence.map((item) => item.roleId)).toEqual(['vector']);
  });

  it('routes explicit vector search through needle when equipment content manifests match', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'needle-alpha', {
      title: 'Needle Alpha',
      body: 'Archive only.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'needle-beta', {
      title: 'Needle Beta',
      body: 'Archive only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    await installMockHybridSearch(kb, seedRouteState(kb, kb.captureCorpusSnapshot()), {
      searchVector: vi.fn().mockResolvedValue([
        { chunkId: 'needle:0', entryId: 'note:needle-beta', score: 0.99 },
        { chunkId: 'needle:1', entryId: 'note:needle-alpha', score: 0.97 },
      ]),
    });

    const response = await searchKb(kb, 'semantic', 2, 'all', 'vector');

    expect(response.mode).toBe('vector');
    expectMigratedShape(response);
    expect(resultNotes(response.results)).toEqual(['needle-beta', 'needle-alpha']);
    expect(resultFor(response.results, 'needle-beta').matchedBy).toEqual([]);
    expect(resultFor(response.results, 'needle-beta').evidence.map((item) => item.roleId)).toEqual(['vector']);
  });

  it('reports kb.embedding remediation for explicit vector search without embedding binding', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'needle-alpha', {
      title: 'Needle Alpha',
      body: 'Archive only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    await expect(searchKb(kb, 'semantic', 2, 'all', 'vector')).rejects.toMatchObject({
      code: 'binding_empty',
      userMessage: 'Vector search needs kb.embedding.',
      remediation:
        "Run `coral-cli expansion list` to find an engine that fills 'kb.embedding', then `coral-cli expansion equip <name>`. FTS-only search continues to work zero-config.",
      context: { binding: 'kb.embedding' },
    });
  });

  it('reports kb.vector remediation for explicit vector search without vector binding', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'needle-alpha', {
      title: 'Needle Alpha',
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

  it('widens vector candidates until topK distinct entries survive chunk aggregation', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'alpha-archive', {
      title: 'Alpha',
      body: 'Archive only.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'beta-history', {
      title: 'Beta',
      body: 'History only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    const routeState = seedRouteState(kb, kb.captureCorpusSnapshot());

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

    await installMockHybridSearch(kb, routeState, { searchVector });

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
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.sourcesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'vector-note', {
      title: 'Vector Note',
      body: 'Archive only.',
    });
    writeSource(paths.sourcesDir(process.env.CORAL_KB_PATH!), 'vector-source', {
      title: 'Vector Source',
      body: 'History only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    await installMockHybridSearch(kb, seedRouteState(kb, kb.captureCorpusSnapshot()), {
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
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.communitiesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'latent-note', {
      title: 'Latent Note',
      body: 'Archive only.',
    });
    const writeCommunities = () => {
      writeCommunity(paths.communitiesDir(process.env.CORAL_KB_PATH!), 'graph-rag', {
        title: 'Graph RAG',
        members: ['graph-rag', 'retrieval'],
        summary: 'Shared retrieval patterns.',
        body: 'Retrieval patterns stay clustered here.',
      });
    };
    writeCommunities();

    await ensureFreshCommunityIndex(kb, reindex, writeCommunities);
    await installMockHybridSearch(kb, seedRouteState(kb, kb.captureCorpusSnapshot()), {
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
    mkdirSync(paths.communitiesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    const writeCommunities = () => {
      writeCommunity(paths.communitiesDir(process.env.CORAL_KB_PATH!), 'graph-rag', {
        title: 'Graph RAG',
        members: ['graph-rag', 'retrieval'],
        summary: 'Shared retrieval patterns.',
        body: 'Retrieval patterns stay clustered here.',
      });
    };
    writeCommunities();

    await ensureFreshCommunityIndex(kb, reindex, writeCommunities);
    const { embedQuery } = await installMockHybridSearch(kb, seedRouteState(kb, kb.captureCorpusSnapshot()), {
      searchVector: vi.fn().mockResolvedValue([]),
      embedQuery: vi.fn().mockResolvedValue(new Float32Array([0.25, 0.75])),
    });

    const response = await searchKb(kb, 'retrieval', 5, 'communities');

    expect(response.mode).toBe('text');
    expect(resultNotes(response.results)).toEqual(['graph-rag']);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('keeps hybrid search enabled when only metadataSeq advances beyond the vector snapshot', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'hybrid-metadata-note', {
      title: 'Hybrid Metadata Note',
      body: 'Semantic retrieval target.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    const snapshot = kb.captureCorpusSnapshot();
    const routeState = seedRouteState(
      kb,
      {
        ...snapshot,
        metadataSeq: snapshot.metadataSeq + 4,
        snapshotId: `${snapshot.snapshotId}-metadata`,
      },
      {
        cursorContentManifestHash: snapshot.contentManifestHash,
      },
    );

    await installMockHybridSearch(kb, routeState, {
      searchVector: vi
        .fn()
        .mockResolvedValue([{ chunkId: 'hybrid:0', entryId: 'note:hybrid-metadata-note', score: 0.99 }]),
    });

    const response = await searchKb(kb, 'semantic', 5);

    expect(response.mode).toBe('hybrid');
    expect(resultNotes(response.results)).toContain('hybrid-metadata-note');
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

  it('falls back to text mode when vector query embedding fails', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'rendering-guides', {
      title: 'Rendering Guides',
      body: 'Rendering guides keep frames stable.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    await installMockHybridSearch(kb, seedRouteState(kb, kb.captureCorpusSnapshot()), {
      searchVector: vi
        .fn()
        .mockResolvedValue([{ chunkId: 'rendering:0', entryId: 'note:rendering-guides', score: 0.99 }]),
      embedQuery: vi.fn().mockRejectedValue(new Error('embedding offline')),
    });

    const response = await searchKb(kb, 'rendering', 5);

    expect(response.mode).toBe('text');
    expect(resultNotes(response.results)).toEqual(['rendering-guides']);
    expect(resultFor(response.results, 'rendering-guides').matchedBy).toEqual(
      expect.arrayContaining(['filename', 'title', 'content']),
    );
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
