import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OramaModule from '@orama/orama';
import type * as NodeOs from 'node:os';
import type * as EmbeddingModule from '../search/embedding.js';
import type * as NeedleBackendModule from '../search/needle-backend.js';
import type * as RouterModule from '../search/router.js';
import type { EntityGraph } from '../entry-types.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  oramaSearch: null as null | ((...args: unknown[]) => unknown),
  createEmbeddingProvider: null as null | ((...args: unknown[]) => unknown),
  createNeedleBackend: null as null | ((...args: unknown[]) => unknown),
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

vi.mock('../search/needle-backend.js', async () => {
  const actual = await vi.importActual<typeof NeedleBackendModule>('../search/needle-backend.js');
  return {
    ...actual,
    createNeedleBackend: (...args: Parameters<typeof actual.createNeedleBackend>) =>
      mockState.createNeedleBackend === null
        ? actual.createNeedleBackend(...args)
        : (mockState.createNeedleBackend(...args) as ReturnType<typeof actual.createNeedleBackend>),
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
    mockState.createNeedleBackend = null;
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
    const createNeedleBackendSpy = vi.fn().mockReturnValue({
      isSearchReady: () => true,
      isSnapshotStale: () => false,
      search: async () => ({
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
      }),
    });

    mockState.oramaSearch = asUnknownHandler(oramaSearchSpy);
    mockState.createRouter = asUnknownHandler(createRouterSpy);
    mockState.createEmbeddingProvider = asUnknownHandler(createEmbeddingProviderSpy);
    mockState.createNeedleBackend = asUnknownHandler(createNeedleBackendSpy);

    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    writeNote(paths.notesDir(), 'vector-note', {
      title: 'Vector Note',
      body: 'Archive only.',
    });

    await reindex(kb);
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

    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
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
    const createNeedleBackendSpy = vi.fn(() => {
      throw new Error('explicit text mode should not resolve a vector backend');
    });

    mockState.createRouter = asUnknownHandler(createRouterSpy);
    mockState.createEmbeddingProvider = asUnknownHandler(createEmbeddingProviderSpy);
    mockState.createNeedleBackend = asUnknownHandler(createNeedleBackendSpy);

    const response = await searchKb(kb, 'rendering', 5, 'all', 'text');

    expect(response.mode).toBe('text');
    expect(resultNotes(response.results)).toEqual(['rendering-guides']);
    expect(createRouterSpy).not.toHaveBeenCalled();
    expect(createEmbeddingProviderSpy).not.toHaveBeenCalled();
    expect(createNeedleBackendSpy).not.toHaveBeenCalled();
  });
});
