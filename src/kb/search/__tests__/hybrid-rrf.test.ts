import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type * as EmbeddingModule from '../embedding.js';
import type { ConsumerHandle, ConsumerHandleStatus } from '../../../coordinator/consumer-driver.js';
import { createEquipmentSlot, createSlotRegistry } from '../../../coordinator/equipment/slots.js';
import { runtimeActivationFromHandle } from '../../../coordinator/equipment/runtime-activation.js';
import type { KbRuntime } from '../../contracts.js';
import type { EntityGraph, KbEntryId } from '../../entry-types.js';
import { createHybridFusion } from '../hybrid.js';
import type { TextRetrievalResult, VectorRetrievalResult, VectorRetrieval } from '../contract.js';
import { createOramaBaseProjection } from '../orama-backend.js';

const equipmentViewResolvers = new WeakMap<KbRuntime, () => ReturnType<typeof runtimeActivationFromHandle> | null>();
type TaggedVectorRetrieval = VectorRetrieval & { readonly backendKind?: 'needle' | 'orama' };

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

const hybridMockState = vi.hoisted(() => ({
  createEmbeddingProvider: null as null | ((...args: any[]) => Promise<any>),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
  };
});

vi.mock('../embedding.js', async () => {
  const actual = await vi.importActual<typeof EmbeddingModule>('../embedding.js');
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
    import('../../ops/search.js'),
    import('../../ops/reindex.js'),
    import('../../runtime.js'),
    import('../../paths.js'),
  ]);
  return {
    searchKb,
    reindex,
    createKbRuntime: runtime.createKbRuntime,
    captureKbCorpusSnapshot: runtime.captureKbCorpusSnapshot,
    paths,
  };
}

function createRuntime(
  createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  let kb!: ReturnType<typeof createKbRuntime>;
  // eslint-disable-next-line prefer-const -- self-referential closure via equipmentViewResolvers.get(kb)
  kb = createKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir(),
    getEquipmentView: () => equipmentViewResolvers.get(kb)?.() ?? null,
  });
  return kb;
}

function seedNeedleRouteState(
  kb: {
    db: { prepare: (...args: any[]) => { run: (...params: any[]) => unknown } };
    invalidateCorpusStateSnapshot?: () => void;
  },
  snapshot: {
    snapshotId: string;
    contentSeq: number;
    metadataSeq: number;
    contentManifestHash: string;
    metadataManifestHash: string;
  },
): Extract<ConsumerHandleStatus, { authority: 'corpus' }> {
  kb.db
    .prepare(
      `
        INSERT INTO corpus_state (
          id,
          snapshot_id,
          content_seq,
          metadata_seq,
          content_manifest_hash,
          metadata_manifest_hash,
          last_mutation
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          snapshot_id = excluded.snapshot_id,
          content_seq = excluded.content_seq,
          metadata_seq = excluded.metadata_seq,
          content_manifest_hash = excluded.content_manifest_hash,
          metadata_manifest_hash = excluded.metadata_manifest_hash,
          last_mutation = excluded.last_mutation
      `,
    )
    .run(
      snapshot.snapshotId,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.contentManifestHash,
      snapshot.metadataManifestHash,
      '2026-04-01T00:00:00.000Z',
    );

  kb.invalidateCorpusStateSnapshot?.();

  return {
    authority: 'corpus',
    snapshotId: snapshot.snapshotId,
    contentSeq: snapshot.contentSeq,
    contentManifestHash: snapshot.contentManifestHash,
    pending: false,
    lastApplyError: null,
  };
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

function createCorpusHandle(
  initial: Partial<Extract<ConsumerHandleStatus, { authority: 'corpus' }>>,
): ConsumerHandle {
  const status: Extract<ConsumerHandleStatus, { authority: 'corpus' }> = {
    authority: 'corpus',
    snapshotId: null,
    contentSeq: 0,
    contentManifestHash: null,
    pending: false,
    lastApplyError: null,
    ...initial,
  };

  return {
    id: 'mock-needle-handle',
    registrationKind: 'equipment',
    async stop() {},
    async unregister() {},
    status: () => ({ ...status }),
  };
}

function equipVectorSlot(runtime: KbRuntime, retrieval: TaggedVectorRetrieval, handle: ConsumerHandle): void {
  const registry = createSlotRegistry();
  const slot = createEquipmentSlot<VectorRetrieval>({
    id: 'kb.vector',
    defaultOwner: () => createOramaBaseProjection(runtime),
  });
  registry.declare(slot);
  slot.equip(retrieval, handle);
  equipmentViewResolvers.set(runtime, () => {
    const slotView = registry.list().find((entry) => entry.id === slot.id);
    return slotView?.handle ? runtimeActivationFromHandle(slot.currentOwner(), slotView.handle) : null;
  });
}

function installMockHybridSearch(
  kb: KbRuntime & {
    readIndex: () => { entries: Record<string, any> } | null;
  },
  routeState: Extract<ConsumerHandleStatus, { authority: 'corpus' }>,
  searchVector: (query: Float32Array, candidateK: number) => Promise<MockNeedleChunkHit[]>,
) {
  hybridMockState.createEmbeddingProvider = vi.fn().mockResolvedValue({
    embedQuery: vi.fn().mockResolvedValue(new Float32Array([0.25, 0.75])),
  });
  equipVectorSlot(kb, {
    backendKind: 'needle',
    search: async (
      embedding: number[],
      topK: number,
      scope?: 'all' | 'notes' | 'sources' | 'communities',
    ) => {
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
  }, createCorpusHandle(routeState));
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
    hybridMockState.createEmbeddingProvider = null;
    vi.resetModules();
  });

  it('reorders the top-3 exactly per the AC7 text-plus-vector RRF fixture', () => {
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
    const { searchKb, reindex, createKbRuntime, captureKbCorpusSnapshot, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'rendering-anchor', {
      title: 'Rendering Anchor',
      body: 'Rendering guides keep frames stable.',
    });
    writeNote(paths.notesDir(), 'semantic-vector', {
      title: 'Semantic Vector',
      body: 'Archive only.',
    });
    writeNote(paths.notesDir(), 'memory-node', {
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
    installMockHybridSearch(
      kb,
      seedNeedleRouteState(kb, captureKbCorpusSnapshot(kb)),
      vi.fn().mockResolvedValue([
        { chunkId: 'semantic:0', entryId: 'note:semantic-vector', score: 0.99 },
      ]),
    );

    const response = await searchKb(kb, 'rendering vram', 3, 'all', 'hybrid');

    expect(response.mode).toBe('hybrid');
    expect(resultNotes(response.results)[0]).toBe('rendering-anchor');
    expect(resultNotes(response.results)).toContain('memory-node');
    expect(resultFor(response.results, 'memory-node').graphRank).toBeGreaterThan(0);
    expect(resultFor(response.results, 'memory-node').matchedBy).toEqual([]);
  });
});
