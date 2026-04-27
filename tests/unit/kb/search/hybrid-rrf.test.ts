import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type { EntityGraph, KbEntryId } from '#src/kb/entry-types.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { createHybridFusion } from '#src/kb/search/hybrid.js';
import type { TextRetrievalResult, VectorRetrievalResult } from '#src/kb/search/contract.js';
import {
  bindEmbedding,
  createCorpusHandle,
  bindVectorBacked,
  seedNeedleRouteState,
} from '#tests/unit/kb/expansion-test-helpers.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

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
  createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  return createKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir('prod'),
    db: createKbTestDb(paths.kbRuntimeDir('prod')),
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

async function installMockHybridSearch(
  kb: KbRuntime & {
    readIndex: () => { entries: Record<string, any> } | null;
  },
  routeState: ReturnType<typeof seedNeedleRouteState>,
  searchVector: (query: Float32Array, candidateK: number) => Promise<MockNeedleChunkHit[]>,
) {
  await bindEmbedding(kb, {
    embedDocuments: vi.fn(async () => []),
    embedQuery: vi.fn().mockResolvedValue(new Float32Array([0.25, 0.75])),
  });
  bindVectorBacked(
    kb,
    {
      backendKind: 'needle',
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
}

function resultNotes(results: { note: string }[]): string[] {
  return results.map((result) => result.note);
}

function resultFor<T extends { note: string }>(results: T[], target: string): T {
  const result = results.find((entry) => entry.note === target);
  expect(result).toBeDefined();
  return result!;
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

function textResult(entryId: `note:${string}`, rank: number): TextRetrievalResult['hits'][number] {
  const slug = entryId.slice(entryId.indexOf(':') + 1);
  return {
    entryId,
    slug,
    kind: 'note',
    title: slug.toUpperCase(),
    tags: [],
    principles: [],
    score: 1,
    rank,
    document: {
      id: entryId,
      entryId,
      slug,
      kind: 'note',
      freshness: 'fresh',
      title: slug.toUpperCase(),
      body: `${slug} body`,
      tags: [],
      principles: [],
      contentHash: `content:${slug}`,
      metadataHash: `metadata:${slug}`,
      vector: [],
    },
  };
}

function vectorResult(entryId: `note:${string}`, rank: number): VectorRetrievalResult['hits'][number] {
  const slug = entryId.slice(entryId.indexOf(':') + 1);
  return {
    entryId,
    slug,
    kind: 'note',
    title: slug.toUpperCase(),
    tags: [],
    principles: [],
    score: 1,
    rank,
  };
}

describe('hybrid reciprocal rank fusion', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-hybrid-rrf-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('reorders the top-3 exactly for the text-plus-vector RRF fixture', () => {
    const hybrid = createHybridFusion();
    const fused = hybrid.fuse(
      {
        hits: [textResult('note:a', 1), textResult('note:b', 2), textResult('note:c', 3)],
      },
      {
        hits: [vectorResult('note:c', 1), vectorResult('note:a', 2)],
      },
      {
        hits: [],
      },
    );

    expect(fused.hits.map((hit) => hit.entryId)).toEqual(['note:a', 'note:c', 'note:b']);
    expect(fused.hits[0]?.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused.hits[1]?.score).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(fused.hits[2]?.score).toBeCloseTo(1 / 62, 12);
  });

  it('keeps graph participation in explicit hybrid mode through the router-backed fusion path', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'rendering-anchor', {
      title: 'Rendering Anchor',
      body: 'Rendering guides keep frames stable.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'semantic-vector', {
      title: 'Semantic Vector',
      body: 'Archive only.',
    });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'memory-node', {
      title: 'Opaque Memory Node',
      tags: ['gpu-device-memory'],
      body: 'Archive only.',
    });

    await kb.writeEntityGraph({
      entityMeta: {
        'gpu-device-memory': {
          type: 'component',
          description: 'GPU device memory.',
          aliases: ['vram'],
        },
      },
      relationships: [],
    } satisfies EntityGraph);

    await reindex(kb);
    await installMockHybridSearch(
      kb,
      seedNeedleRouteState(kb, kb.captureCorpusSnapshot()),
      vi.fn().mockResolvedValue([{ chunkId: 'semantic:0', entryId: 'note:semantic-vector', score: 0.99 }]),
    );

    const response = await searchKb(kb, 'rendering vram', 3, 'all', 'hybrid');

    expect(response.mode).toBe('hybrid');
    expect(resultNotes(response.results)[0]).toBe('rendering-anchor');
    expect(resultNotes(response.results)).toContain('memory-node');
    expect(resultFor(response.results, 'memory-node').graphRank).toBeGreaterThan(0);
    expect(resultFor(response.results, 'memory-node').matchedBy).toEqual([]);
  });
});
