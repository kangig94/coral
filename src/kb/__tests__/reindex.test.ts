import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import { communityEntryId, noteEntryId } from '../types.js';

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

type FakeDb = {
  dropped: string[];
  created: Record<string, unknown[]>;
  emptySchemas: Record<string, unknown>;
  tableNames: Set<string>;
  connection: {
    tableNames: () => Promise<string[]>;
    dropTable: (name: string) => Promise<void>;
    createTable: (name: string, rows: Record<string, unknown>[]) => Promise<void>;
    createEmptyTable: (name: string, schema: unknown) => Promise<void>;
  };
};

function createFakeDb(): FakeDb {
  const tableNames = new Set<string>();
  const created: Record<string, unknown[]> = {};
  const emptySchemas: Record<string, unknown> = {};
  const dropped: string[] = [];

  return {
    dropped,
    created,
    emptySchemas,
    tableNames,
    connection: {
      tableNames: async () => [...tableNames],
      dropTable: async (name: string) => {
        dropped.push(name);
        tableNames.delete(name);
      },
      createTable: async (name: string, rows: Record<string, unknown>[]) => {
        created[name] = rows;
        tableNames.add(name);
      },
      createEmptyTable: async (name: string, schema: unknown) => {
        emptySchemas[name] = schema;
        tableNames.add(name);
      },
    },
  };
}

async function loadKbModules() {
  vi.resetModules();
  const [{ reindex }, runtime, paths] = await Promise.all([
    import('../reindex.js'),
    import('../runtime.js'),
    import('../paths.js'),
  ]);
  return {
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

function setAdapter(
  kb: ReturnType<typeof createRuntime>,
  adapter: {
    getDb: () => Promise<unknown>;
    ensureTables: () => Promise<void>;
  } | null,
): void {
  Object.defineProperty(kb, 'adapter', {
    configurable: true,
    get: () => adapter,
  });
}

describe('kb reindex', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-reindex-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('rebuilds the JSON index unconditionally in text mode without warning by default', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    mkdirSync(paths.principlesDir(), { recursive: true });
    writeFileSync(
      join(paths.notesDir(), 'coral-kb-mode.md'),
      `---
tags: [coral, kb]
principles: [contract-first-design]
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-21T00:00:00.000Z
entrySeq: 11
---
# KB Mode

## Rule
Keep the JSON index authoritative.
`,
      'utf-8',
    );
    writeFileSync(
      join(paths.principlesDir(), 'contract-first-design.md'),
      `---
createdAt: 2026-03-20
updatedAt: 2026-03-20
---
Make the contract explicit first.
`,
      'utf-8',
    );
    kb.writeIndex({
      entries: {
        [noteEntryId('stale')]: {
          kind: 'note',
          slug: 'stale',
          title: 'Stale',
          tags: ['old'],
          principles: ['old-principle'],
          source: ['kangig94/coral'],
          createdAt: '2026-03-01',
          updatedAt: '2026-03-01',
          related: [],
          entrySeq: 1,
        },
      },
      principles: {},
    });

    const result = await reindex(kb);

    expect(result).toMatchObject({
      notes: 1,
      communities: 0,
      principles: 1,
      tags: 2,
      mode: 'text',
    });
    expect(result.warning).toBeUndefined();
    expect(kb.readIndex()).toEqual({
      entries: {
        [noteEntryId('coral-kb-mode')]: {
          kind: 'note',
          slug: 'coral-kb-mode',
          title: 'KB Mode',
          tags: ['coral', 'kb'],
          principles: ['contract-first-design'],
          source: ['kangig94/coral'],
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-21T00:00:00.000Z',
          related: [],
          entrySeq: 11,
        },
      },
      principles: {
        'contract-first-design': 'Make the contract explicit first.',
      },
    });
    expect(readFileSync(join(mockState.tmpHome, '.coral', 'data', 'kb', 'index.json'), 'utf-8')).toContain(
      '"coral-kb-mode"',
    );
  });

  it('indexes communities as first-class entries during text rebuild', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.communitiesDir(), { recursive: true });
    writeFileSync(
      join(paths.communitiesDir(), 'graph-rag.md'),
      `---
level: 0
members:
  - graph-rag
  - retrieval
summary: Shared retrieval patterns.
generatedBy: curate
createdAt: 2026-04-02
updatedAt: 2026-04-02
---
# Graph RAG

## Members
- #graph-rag
- #retrieval
`,
      'utf-8',
    );

    const result = await reindex(kb);

    expect(result).toMatchObject({
      notes: 0,
      sources: 0,
      communities: 1,
      principles: 0,
      tags: 2,
      mode: 'text',
    });
    expect(kb.readIndex()).toEqual({
      entries: {
        [communityEntryId('graph-rag')]: {
          kind: 'community',
          slug: 'graph-rag',
          title: 'Graph RAG',
          level: 0,
          members: ['graph-rag', 'retrieval'],
          summary: 'Shared retrieval patterns.',
          generatedBy: 'curate',
          createdAt: '2026-04-02',
          updatedAt: '2026-04-02',
        },
      },
      principles: {},
    });
  });

  it('rebuilds text mode cleanly when enhanced mode was previously active but is now unavailable', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    mkdirSync(paths.principlesDir(), { recursive: true });
    writeFileSync(
      join(paths.notesDir(), 'coral-kb-mode.md'),
      `---
tags: [coral]
principles: [contract-first-design]
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-21T00:00:00.000Z
entrySeq: 11
---
# KB Mode
`,
      'utf-8',
    );
    writeFileSync(
      join(paths.principlesDir(), 'contract-first-design.md'),
      `---
createdAt: 2026-03-20
updatedAt: 2026-03-20
---
Make the contract explicit first.
`,
      'utf-8',
    );
    kb.writeIndexState({
      mutationSeq: 3,
      indexedSeq: 3,
    });

    const result = await reindex(kb);

    expect(result.mode).toBe('text');
    expect(result.warning).toBeUndefined();
  });

  it('rebuilds LanceDB tables in enhanced mode and clears stale index state for the rebuilt snapshot', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    mkdirSync(paths.principlesDir(), { recursive: true });
    writeFileSync(
      join(paths.notesDir(), 'coral-kb-mode.md'),
      `---
tags: [coral, kb]
principles: [contract-first-design]
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-21T00:00:00.000Z
entrySeq: 11
---
# KB Mode

## Rule
Keep the JSON index authoritative.
`,
      'utf-8',
    );
    writeFileSync(
      join(paths.principlesDir(), 'contract-first-design.md'),
      `---
createdAt: 2026-03-20
updatedAt: 2026-03-20
---
Make the contract explicit first.
`,
      'utf-8',
    );
    kb.writeIndexState({
      mutationSeq: 5,
      indexedSeq: 3,
      staleReason: 'old failure',
    });

    const fakeDb = createFakeDb();
    fakeDb.tableNames.add('notes');
    fakeDb.tableNames.add('tags');
    fakeDb.tableNames.add('principles');
    setAdapter(kb, {
      getDb: async () => fakeDb.connection,
      ensureTables: async () => {},
    });

    const result = await reindex(kb);

    expect(result.mode).toBe('text');
    expect(result.warning).toBeUndefined();
    expect(fakeDb.dropped).toEqual(['notes', 'tags', 'principles']);
    expect(fakeDb.created.notes).toEqual([
      {
        id: 'coral-kb-mode',
        path: 'notes/coral-kb-mode.md',
        note_slug: 'coral-kb-mode',
        note_slug_norm: 'coral-kb-mode',
        domain: 'coral',
        title: 'KB Mode',
        title_norm: 'kb mode',
        body: '## Rule\nKeep the JSON index authoritative.',
        body_norm: '## rule\nkeep the json index authoritative.',
        created: '2026-03-20T00:00:00.000Z',
        updated: '2026-03-21T00:00:00.000Z',
      },
    ]);
    expect(fakeDb.created.tags).toEqual([
      { note_id: 'coral-kb-mode', tag: 'coral', tag_norm: 'coral' },
      { note_id: 'coral-kb-mode', tag: 'kb', tag_norm: 'kb' },
    ]);
    expect(fakeDb.created.principles).toEqual([
      { note_id: 'coral-kb-mode', principle: 'contract-first-design', principle_norm: 'contract-first-design' },
    ]);
    expect(kb.readIndexState()).toEqual({
      mutationSeq: 5,
      indexedSeq: 5,
    });
  });

  it('skips notes with malformed frontmatter instead of crashing', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    mkdirSync(paths.principlesDir(), { recursive: true });

    // Valid note
    writeFileSync(
      join(paths.notesDir(), 'valid-note.md'),
      `---
tags: [test]
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-20
updatedAt: 2026-03-20
entrySeq: 1
---
# Valid Note
Content here.
`,
      'utf-8',
    );

    // Malformed note: source is a bare string instead of an array
    writeFileSync(
      join(paths.notesDir(), 'bad-source.md'),
      `---
tags: [test]
principles: []
source: kangig94/coral
createdAt: 2026-03-20
updatedAt: 2026-03-20
---
# Bad Source
This note has source as a bare string.
`,
      'utf-8',
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await reindex(kb);
    stderrSpy.mockRestore();

    expect(result.notes).toBe(1); // only the valid note indexed
    const index = kb.readIndex();
    expect(index?.entries[noteEntryId('valid-note')]).toBeDefined();
    expect(index?.entries[noteEntryId('bad-source')]).toBeUndefined();
  });
});
