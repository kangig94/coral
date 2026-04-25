import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OramaModule from '@orama/orama';
import type * as NodeOs from 'node:os';
import type * as EmbeddingModule from '#src/kb/search/embedding.js';
import type * as RouterModule from '#src/kb/search/router.js';
import type { EntityGraph } from '#src/kb/entry-types.js';
import {
  createCorpusHandle,
  equipVectorSlot,
  equipmentViewResolvers,
  seedNeedleRouteState,
} from '#tests/unit/kb/equipment-test-helpers.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

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

vi.mock('#src/kb/search/embedding.js', async () => {
  const actual = await vi.importActual<typeof EmbeddingModule>('#src/kb/search/embedding.js');
  return {
    ...actual,
    createEmbeddingProvider: (...args: Parameters<typeof actual.createEmbeddingProvider>) =>
      mockState.createEmbeddingProvider === null
        ? actual.createEmbeddingProvider(...args)
        : (mockState.createEmbeddingProvider(...args) as ReturnType<typeof actual.createEmbeddingProvider>),
  };
});

vi.mock('#src/kb/search/router.js', async () => {
  const actual = await vi.importActual<typeof RouterModule>('#src/kb/search/router.js');
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
    runtimeDir: paths.kbRuntimeDir('prod'),
    db: createKbTestDb(paths.kbRuntimeDir('prod')),
    getEquipmentView: () => equipmentViewResolvers.get(kb)?.() ?? null,
  });
  return kb;
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

  it('does not pay Orama text-search or router cost for explicit vector mode', async () => {
    const actualOrama = await vi.importActual<typeof OramaModule>('@orama/orama');
    const oramaSearchSpy = vi.fn((...args: Parameters<typeof actualOrama.search>) => actualOrama.search(...args));
    const createRouterSpy = vi.fn(() => {
      throw new Error('explicit vector mode should not create a router');
    });
    const embedQuery = vi.fn().mockResolvedValue(new Float32Array([1, 0]));
    const embedDocuments = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])));
    const createEmbeddingProviderSpy = vi.fn().mockResolvedValue({ embedDocuments, embedQuery });
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

    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'vector-note', {
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
          kb.captureCorpusSnapshot(),
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
    const actualRouter = await vi.importActual<typeof RouterModule>('#src/kb/search/router.js');
    const createRouterSpy = vi.fn((...args: Parameters<typeof actualRouter.createRouter>) =>
      actualRouter.createRouter(...args),
    );

    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'rendering-guides', {
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
          kb.captureCorpusSnapshot(),
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
