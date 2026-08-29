import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OramaModule from '@orama/orama';
import type * as NodeOs from 'node:os';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import type { KbRuntime } from '#src/kb/contract.js';
import type { EntityGraph, KbSearchResponse } from '#src/kb/entry-types.js';
import {
  bindEmbedding,
  bindOramaFtsForTest,
  createCorpusHandle,
  bindVectorBacked,
  seedVectorRouteState,
} from '#tests/unit/kb/expansion-test-helpers.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';
import { applyBoundCorpusConsumerForTest, createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  oramaSearch: null as null | ((...args: unknown[]) => unknown),
}));

const writableDbByRuntime = new WeakMap<KbRuntime, ReturnType<typeof createKbTestDb>>();

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
  _createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  _paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  const db = createKbTestDb(kbRuntimePaths('prod').root);
  const { kb } = createKbTestRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: kbRuntimePaths('prod').root,
    db,
  });
  writableDbByRuntime.set(kb, db);
  bindOramaFtsForTest(kb);
  return kb;
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

describe('kb search mode branching', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-search-mode-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    mockState.oramaSearch = null;
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('does not pay Orama text-search cost for explicit vector mode', async () => {
    const actualOrama = await vi.importActual<typeof OramaModule>('@orama/orama');
    const oramaSearchSpy = vi.fn((...args: Parameters<typeof actualOrama.search>) => actualOrama.search(...args));
    const embedQuery = vi.fn().mockResolvedValue(new Float32Array([1, 0]));
    const embedDocuments = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])));
    const vectorSearchSpy = vi.fn().mockResolvedValue({
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

    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    await bindEmbedding(kb, { embedDocuments, embedQuery });
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'vector-note', {
      title: 'Vector Note',
      body: 'Archive only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    bindVectorBacked(
      kb,
      {
        search: vectorSearchSpy,
      },
      createCorpusHandle(
        seedVectorRouteState(writableDbByRuntime.get(kb)!, kb.captureCorpusSnapshot(), {
          invalidateCorpusStateSnapshot: () => kb.invalidateCorpusStateSnapshot(),
        }),
      ),
    );
    oramaSearchSpy.mockClear();

    const response = await searchKb(kb, 'semantic', 5, 'all', 'vector');

    expect(response.mode).toBe('vector');
    expectMigratedShape(response);
    expect(resultNotes(response.results)).toEqual(['vector-note']);
    expect(resultFor(response.results, 'vector-note').evidence.map((item) => item.roleId)).toEqual(['vector']);
    expect(oramaSearchSpy).not.toHaveBeenCalled();
  });

  it('keeps explicit text mode on the lexical path', async () => {
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
    await applyOramaProjection(kb);

    bindVectorBacked(
      kb,
      {
        search: vi.fn(async () => ({ hits: [] })),
      },
      createCorpusHandle(
        seedVectorRouteState(writableDbByRuntime.get(kb)!, kb.captureCorpusSnapshot(), {
          invalidateCorpusStateSnapshot: () => kb.invalidateCorpusStateSnapshot(),
        }),
      ),
    );

    const response = await searchKb(kb, 'rendering', 5, 'all', 'text');

    expect(response.mode).toBe('text');
    expectMigratedShape(response);
    expect(resultNotes(response.results)).toEqual(['rendering-guides']);
    expect(resultFor(response.results, 'rendering-guides').evidence.map((item) => item.roleId)).toEqual(['text']);
  });

  it('promotes explicit auto mode to hybrid when semantic evidence is present', async () => {
    const embedQuery = vi.fn().mockResolvedValue(new Float32Array([1, 0]));
    const embedDocuments = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])));
    const vectorSearchSpy = vi.fn().mockResolvedValue({
      hits: [
        {
          entryId: 'note:auto-vector',
          slug: 'auto-vector',
          kind: 'note',
          title: 'Auto Vector',
          tags: [],
          principles: [],
          score: 0.99,
          rank: 1,
        },
      ],
    });

    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    await bindEmbedding(kb, { embedDocuments, embedQuery });
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'auto-vector', {
      title: 'Auto Vector',
      body: 'Archive only.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    bindVectorBacked(
      kb,
      {
        search: vectorSearchSpy,
      },
      createCorpusHandle(
        seedVectorRouteState(writableDbByRuntime.get(kb)!, kb.captureCorpusSnapshot(), {
          invalidateCorpusStateSnapshot: () => kb.invalidateCorpusStateSnapshot(),
        }),
      ),
    );

    const response = await searchKb(kb, 'semantic', 5, 'all', 'auto');

    expect(response.mode).toBe('hybrid');
    expectMigratedShape(response);
    expect(resultFor(response.results, 'auto-vector').evidence.some((item) => item.roleId === 'vector')).toBe(true);
  });

  it('preserves explicit hybrid mode on the hybrid intent path', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    await bindEmbedding(kb, {
      embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([0]))),
      embedQuery: vi.fn().mockResolvedValue(new Float32Array([0])),
    });
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'hybrid-rendering', {
      title: 'Hybrid Rendering',
      body: 'Rendering guides keep frames stable.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);
    bindVectorBacked(
      kb,
      {
        search: vi.fn(async () => ({ hits: [] })),
      },
      createCorpusHandle(
        seedVectorRouteState(writableDbByRuntime.get(kb)!, kb.captureCorpusSnapshot(), {
          invalidateCorpusStateSnapshot: () => kb.invalidateCorpusStateSnapshot(),
        }),
      ),
    );

    const response = await searchKb(kb, 'rendering', 5, 'all', 'hybrid');

    expect(response.mode).toBe('hybrid');
    expectMigratedShape(response);
    expect(resultNotes(response.results)).toEqual(['hybrid-rendering']);
  });

  it('uses the corpus structural key without rereading the entity graph for fresh indexed graph search', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'memory-entry', {
      title: 'Opaque Memory Entry',
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
    await applyOramaProjection(kb);
    expect(kb.readIndexOrEmpty().structuralKey).toBeDefined();

    const readEntityGraphSpy = vi.spyOn(kb, 'readEntityGraph');
    const response = await searchKb(kb, 'vram', 5, 'all', 'auto');

    expect(response.mode).toBe('text');
    expectMigratedShape(response);
    expect(resultNotes(response.results)).toEqual(['memory-entry']);
    expect(readEntityGraphSpy).not.toHaveBeenCalled();
  });
});
