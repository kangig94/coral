import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OramaModule from '@orama/orama';
import type * as NodeOs from 'node:os';
import type * as EmbeddingModule from '../search/embedding.js';
import type * as RouterModule from '../search/router.js';
import type { ConsumerHandle, ConsumerHandleStatus } from '../../coordinator/consumer-driver.js';
import { createEquipmentSlot, createSlotRegistry } from '../../coordinator/equipment/slots.js';
import { runtimeActivationFromHandle } from '../../coordinator/equipment/runtime-activation.js';
import type { KbRuntime } from '../contracts.js';
import type { EntityGraph } from '../entry-types.js';
import type { VectorRetrieval } from '../search/contract.js';
import { createOramaBaseProjection } from '../search/orama-backend.js';

const equipmentViewResolvers = new WeakMap<KbRuntime, () => ReturnType<typeof runtimeActivationFromHandle> | null>();
type TaggedVectorRetrieval = VectorRetrieval & { readonly backendKind?: 'needle' | 'orama' };

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  oramaSearch: null as null | ((...args: unknown[]) => unknown),
  createEmbeddingProvider: null as null | ((...args: unknown[]) => unknown),
  createRouter: null as null | ((...args: unknown[]) => unknown),
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
  };
});

vi.mock('@orama/orama', async () => {
  const actual = await vi.importActual<typeof OramaModule>('@orama/orama');
  return {
    ...actual,
    search: (...args: Parameters<typeof actual.search>) =>
      mockState.oramaSearch === null
        ? actual.search(...args)
        : (mockState.oramaSearch(...args) as ReturnType<typeof actual.search>),
  };
});

vi.mock('../search/embedding.js', async () => {
  const actual = await vi.importActual<typeof EmbeddingModule>('../search/embedding.js');
  return {
    ...actual,
    createEmbeddingProvider: (...args: Parameters<typeof actual.createEmbeddingProvider>) =>
      mockState.createEmbeddingProvider === null
        ? actual.createEmbeddingProvider(...args)
        : (mockState.createEmbeddingProvider(...args) as ReturnType<typeof actual.createEmbeddingProvider>),
  };
});

vi.mock('../search/router.js', async () => {
  const actual = await vi.importActual<typeof RouterModule>('../search/router.js');
  return {
    ...actual,
    createRouter: (...args: Parameters<typeof actual.createRouter>) =>
      mockState.createRouter === null
        ? actual.createRouter(...args)
        : (mockState.createRouter(...args) as ReturnType<typeof actual.createRouter>),
  };
});

async function loadKbModules() {
  vi.resetModules();
  const [{ searchKb }, { reindex }, runtime, paths] = await Promise.all([
    import('../ops/search.js'),
    import('../ops/reindex.js'),
    import('../runtime.js'),
    import('../paths.js'),
  ]);
  return {
    searchKb,
    reindex,
    createKbRuntime: runtime.createKbRuntime,
    captureKbCorpusSnapshot: runtime.captureKbCorpusSnapshot,
    paths,
  };
}

function asUnknownHandler<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => TResult,
): (...args: unknown[]) => unknown {
  return (...args: unknown[]) => handler(...(args as TArgs));
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
    body,
  }: {
    title: string;
    tags?: string[];
    body: string;
  },
): void {
  writeFileSync(
    join(noteDir, `${slug}.md`),
    `---
tags: [${tags.join(', ')}]
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-23
updatedAt: 2026-03-23
entrySeq: 1
---
# ${title}

${body}
`,
    'utf-8',
  );
}

function resultNotes(results: { note: string }[]): string[] {
  return results.map((result) => result.note);
}

describe('kb search AC8 mode branching', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-search-ac8-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    mockState.oramaSearch = null;
    mockState.createEmbeddingProvider = null;
    mockState.createRouter = null;
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it("does not pay Orama text-search or router cost for explicit vector mode", async () => {
    const actualOrama = await vi.importActual<typeof OramaModule>('@orama/orama');
    const oramaSearchSpy = vi.fn((...args: Parameters<typeof actualOrama.search>) => actualOrama.search(...args));
    const createRouterSpy = vi.fn(() => {
      throw new Error('explicit vector mode should not create a router');
    });
    const embedQuery = vi.fn().mockResolvedValue(new Float32Array([1, 0]));
    const createEmbeddingProviderSpy = vi.fn().mockResolvedValue({ embedQuery });
    const needleSearchSpy = vi.fn().mockResolvedValue({
      hits: [
        {
          entryId: 'note:vector-note',
          slug: 'vector-note',
          kind: 'note',
          title: 'Vector Note',
          tags: [],
          principles: [],
          score: 0.99,
          rank: 1,
        },
      ],
    });

    mockState.oramaSearch = asUnknownHandler(oramaSearchSpy);
    mockState.createRouter = asUnknownHandler(createRouterSpy);
    mockState.createEmbeddingProvider = asUnknownHandler(createEmbeddingProviderSpy);

    const { searchKb, reindex, createKbRuntime, captureKbCorpusSnapshot, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    writeNote(paths.notesDir(), 'vector-note', {
      title: 'Vector Note',
      body: 'Archive only.',
    });

    await reindex(kb);
    equipVectorSlot(
      kb,
      {
        backendKind: 'needle',
        search: needleSearchSpy,
      },
      createCorpusHandle(
        seedNeedleRouteState(
          {
            db: kb.db,
            invalidateCorpusStateSnapshot: () => kb.invalidateCorpusStateSnapshot(),
          },
          captureKbCorpusSnapshot(kb),
        ),
      ),
    );
    oramaSearchSpy.mockClear();

    const response = await searchKb(kb, 'semantic', 5, 'all', 'vector');

    expect(response.mode).toBe('vector');
    expect(resultNotes(response.results)).toEqual(['vector-note']);
    expect(oramaSearchSpy).not.toHaveBeenCalled();
    expect(createRouterSpy).not.toHaveBeenCalled();
  });

  it('does not build router-backed graph state for explicit text mode', async () => {
    const actualRouter = await vi.importActual<typeof RouterModule>('../search/router.js');
    const createRouterSpy = vi.fn((...args: Parameters<typeof actualRouter.createRouter>) => actualRouter.createRouter(...args));

    const { searchKb, reindex, createKbRuntime, captureKbCorpusSnapshot, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    writeNote(paths.notesDir(), 'rendering-guides', {
      title: 'Rendering Guides',
      tags: ['gpu-device-memory'],
      body: 'Rendering guides keep frames stable.',
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

    const createEmbeddingProviderSpy = vi.fn(() => {
      throw new Error('explicit text mode should not create an embedding provider');
    });

    mockState.createRouter = asUnknownHandler(createRouterSpy);
    mockState.createEmbeddingProvider = asUnknownHandler(createEmbeddingProviderSpy);
    equipVectorSlot(
      kb,
      {
        backendKind: 'needle',
        search: vi.fn(async () => ({ hits: [] })),
      },
      createCorpusHandle(
        seedNeedleRouteState(
          {
            db: kb.db,
            invalidateCorpusStateSnapshot: () => kb.invalidateCorpusStateSnapshot(),
          },
          captureKbCorpusSnapshot(kb),
        ),
      ),
    );

    const response = await searchKb(kb, 'rendering', 5, 'all', 'text');

    expect(response.mode).toBe('text');
    expect(resultNotes(response.results)).toEqual(['rendering-guides']);
    expect(createRouterSpy).not.toHaveBeenCalled();
    expect(createEmbeddingProviderSpy).not.toHaveBeenCalled();
  });
});
