import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import { communityEntryId, noteEntryId, sourceEntryId, type EntityGraph } from '../types.js';

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
  const [{ reindex }, runtime, paths, read] = await Promise.all([
    import('../reindex.js'),
    import('../runtime.js'),
    import('../paths.js'),
    import('../read.js'),
  ]);
  return {
    reindex,
    createKbRuntime: runtime.createKbRuntime,
    paths,
    readEntry: read.readEntry,
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

function setMtime(path: string, mtime: Date): void {
  utimesSync(path, mtime, mtime);
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
    const { reindex, createKbRuntime, paths, readEntry } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.communitiesDir(), { recursive: true });

    const writeCommunityFile = () => {
      writeFileSync(
        join(paths.communitiesDir(), 'graph-rag.md'),
        `---
createdAt: 2026-04-02
updatedAt: 2026-04-02
level: 1
parent: community:platform-architecture
children:
  - community:graph-rag-leaf
  - community:retrieval-leaf
---
# Graph RAG

## Summary

Shared retrieval patterns.

## Members
- #graph-rag
- #retrieval
`,
        'utf-8',
      );
    };

    // First reindex establishes the empty-graph topology hash.
    // Then re-write the community file (topology refresh deletes it).
    // Second reindex indexes the community (topology hash now matches).
    await reindex(kb);
    writeCommunityFile();

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
          level: 1,
          members: ['graph-rag', 'retrieval'],
          parent: 'community:platform-architecture',
          children: ['community:graph-rag-leaf', 'community:retrieval-leaf'],
          summary: 'Shared retrieval patterns.',
          createdAt: '2026-04-02',
          updatedAt: '2026-04-02',
        },
      },
      principles: {},
    });
    expect(readEntry({ note: 'communities:graph-rag' })).toEqual({
      kind: 'community',
      note: 'graph-rag',
      title: 'Graph RAG',
      content: `## Summary

Shared retrieval patterns.

## Members
- #graph-rag
- #retrieval`,
      tags: [],
      principles: [],
      members: ['graph-rag', 'retrieval'],
      level: 1,
      parent: 'community:platform-architecture',
      children: ['community:graph-rag-leaf', 'community:retrieval-leaf'],
      summary: 'Shared retrieval patterns.',
      updatedAt: '2026-04-02',
    });
  });

  it('loads the entity graph during reindex and reports entity coverage', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    writeFileSync(
      join(paths.notesDir(), 'graph-rag-note.md'),
      `---
tags: [graph-rag, retrieval]
principles: []
source:
  - kangig94/coral
createdAt: 2026-04-02
updatedAt: 2026-04-02
entrySeq: 1
---
# Graph RAG Note

Body.
`,
      'utf-8',
    );

    const graph: EntityGraph = {
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
          description: 'Graph structure supports retrieval.',
          evidence: ['note:graph-rag-note'],
        },
      ],
    };
    kb.writeEntityGraph(graph);

    const result = await reindex(kb);

    expect(result).toMatchObject({
      notes: 1,
      entities: 2,
      relationships: 1,
      entityCoverage: 1,
      mode: 'text',
    });
    expect(kb.readIndex()).toMatchObject({
      entityMeta: graph.entityMeta,
      relationships: graph.relationships,
    });
  });

  it('repairs entity-graph-driven topology on ensureIndex after a manual entity graph edit', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeFileSync(
      join(paths.notesDir(), 'graph-rag-note.md'),
      `---
tags: [graph-rag, retrieval, indexing]
principles: []
source:
  - kangig94/coral
createdAt: 2026-04-02
updatedAt: 2026-04-02
entrySeq: 1
---
# Graph RAG Note

Body.
`,
      'utf-8',
    );

    kb.writeEntityGraph({
      entityMeta: {
        'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
        retrieval: { type: 'operation', description: 'Retrieval workflows.' },
        indexing: { type: 'operation', description: 'Index maintenance.' },
      },
      relationships: [
        {
          source: 'graph-rag',
          target: 'retrieval',
          type: 'enables',
          description: 'Graph structure supports retrieval.',
          evidence: ['note:graph-rag-note'],
        },
        {
          source: 'retrieval',
          target: 'indexing',
          type: 'requires',
          description: 'Retrieval depends on indexes.',
          evidence: ['note:graph-rag-note'],
        },
      ],
    });

    await reindex(kb);

    const editedGraph: EntityGraph = {
      entityMeta: {
        'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
        'vector-store': { type: 'component', description: 'Vector storage.' },
        reranking: { type: 'operation', description: 'Result reranking.' },
      },
      relationships: [
        {
          source: 'graph-rag',
          target: 'vector-store',
          type: 'requires',
          description: 'Graph RAG needs vector storage.',
          evidence: ['note:graph-rag-note'],
        },
        {
          source: 'vector-store',
          target: 'reranking',
          type: 'enables',
          description: 'Vector storage supports reranking.',
          evidence: ['note:graph-rag-note'],
        },
      ],
    };

    writeFileSync(kb.entityGraphPath(), `${JSON.stringify(editedGraph, null, 2)}\n`, 'utf-8');
    setMtime(kb.entityGraphPath(), new Date(Date.now() + 60_000));

    const index = await kb.ensureIndex();
    const communities = Object.values(index.entries).filter((entry) => entry.kind === 'community');

    expect(index.entityMeta).toEqual(editedGraph.entityMeta);
    expect(index.relationships).toEqual(editedGraph.relationships);
    expect(
      communities.some(
        (community) =>
          community.members.includes('graph-rag') &&
          community.members.includes('vector-store') &&
          community.members.includes('reranking'),
      ),
    ).toBe(true);
  });

  it('repairs entity-graph-driven topology on reindex after a manual entity graph edit', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeFileSync(
      join(paths.notesDir(), 'graph-rag-note.md'),
      `---
tags: [graph-rag, retrieval, indexing]
principles: []
source:
  - kangig94/coral
createdAt: 2026-04-02
updatedAt: 2026-04-02
entrySeq: 1
---
# Graph RAG Note

Body.
`,
      'utf-8',
    );

    kb.writeEntityGraph({
      entityMeta: {
        'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
        retrieval: { type: 'operation', description: 'Retrieval workflows.' },
        indexing: { type: 'operation', description: 'Index maintenance.' },
      },
      relationships: [
        {
          source: 'graph-rag',
          target: 'retrieval',
          type: 'enables',
          description: 'Graph structure supports retrieval.',
          evidence: ['note:graph-rag-note'],
        },
        {
          source: 'retrieval',
          target: 'indexing',
          type: 'requires',
          description: 'Retrieval depends on indexes.',
          evidence: ['note:graph-rag-note'],
        },
      ],
    });

    await reindex(kb);

    const editedGraph: EntityGraph = {
      entityMeta: {
        'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
        'vector-store': { type: 'component', description: 'Vector storage.' },
        reranking: { type: 'operation', description: 'Result reranking.' },
      },
      relationships: [
        {
          source: 'graph-rag',
          target: 'vector-store',
          type: 'requires',
          description: 'Graph RAG needs vector storage.',
          evidence: ['note:graph-rag-note'],
        },
        {
          source: 'vector-store',
          target: 'reranking',
          type: 'enables',
          description: 'Vector storage supports reranking.',
          evidence: ['note:graph-rag-note'],
        },
      ],
    };

    writeFileSync(kb.entityGraphPath(), `${JSON.stringify(editedGraph, null, 2)}\n`, 'utf-8');
    setMtime(kb.entityGraphPath(), new Date(Date.now() + 60_000));

    const result = await reindex(kb);
    const index = kb.readIndex();
    const communities = Object.values(index?.entries ?? {}).filter((entry) => entry.kind === 'community');

    expect(result).toMatchObject({
      communities: expect.any(Number),
      entities: 3,
      relationships: 2,
    });
    expect(index).toMatchObject({
      entityMeta: editedGraph.entityMeta,
      relationships: editedGraph.relationships,
    });
    expect(
      communities.some(
        (community) =>
          community.members.includes('graph-rag') &&
          community.members.includes('vector-store') &&
          community.members.includes('reranking'),
      ),
    ).toBe(true);
  });

  it('rebuilds text mode cleanly when the vector store is unavailable', async () => {
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
      contentSeq: 3,
      metadataSeq: 3,
      mutationSeq: 3,
      textIndexedSeq: 3,
      vector: { bySpec: {} },
    });

    const result = await reindex(kb);

    expect(result.mode).toBe('text');
    expect(result.warning).toBeUndefined();
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

  it('persists malformed note and source files into pendingRepair during reindex rebuilds', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const { readCurateState } = await import('../curate-state.js');
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });
    mkdirSync(paths.sourcesDir(), { recursive: true });

    writeFileSync(
      join(paths.notesDir(), 'valid-note.md'),
      `---
tags: [test]
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
entrySeq: 5
---
# Valid Note
Content here.
`,
      'utf-8',
    );
    writeFileSync(
      join(paths.notesDir(), 'bad-note.md'),
      `---
tags: [test
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
entrySeq: 7
---
# Bad Note
This note has malformed frontmatter.
`,
      'utf-8',
    );
    writeFileSync(
      join(paths.sourcesDir(), 'bad-source.md'),
      `---
title: Bad Source
type: spec
tags: [reference
importedAt: 2026-03-20T00:00:00.000Z
entrySeq: nope
# Missing closing frontmatter delimiter on purpose
`,
      'utf-8',
    );

    const result = await reindex(kb);

    expect(result).toMatchObject({
      notes: 1,
      sources: 0,
      mode: 'text',
    });
    expect(readCurateState(kb).pendingRepair).toEqual(
      expect.arrayContaining([
        {
          entryId: noteEntryId('bad-note'),
          entrySeq: 7,
          detectedAt: expect.any(String),
        },
        {
          entryId: sourceEntryId('bad-source'),
          entrySeq: null,
          detectedAt: expect.any(String),
        },
      ]),
    );
  });

  it('does not retry unchanged pendingRepair files on every runtime access', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const { readCurateState } = await import('../curate-state.js');
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeFileSync(
      join(paths.notesDir(), 'valid-note.md'),
      `---
tags: [test]
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
entrySeq: 5
---
# Valid Note
Content here.
`,
      'utf-8',
    );
    writeFileSync(
      join(paths.notesDir(), 'bad-note.md'),
      `---
tags: [test
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
entrySeq: 7
---
# Bad Note
This note has malformed frontmatter.
`,
      'utf-8',
    );

    await reindex(kb);

    const reindexSuccessSpy = vi.spyOn(kb, 'recordReindexSuccess');

    await kb.ensureIndex();
    await kb.ensureIndex();

    expect(reindexSuccessSpy).not.toHaveBeenCalled();
    expect(readCurateState(kb).pendingRepair).toEqual([
      {
        entryId: noteEntryId('bad-note'),
        entrySeq: 7,
        detectedAt: expect.any(String),
      },
    ]);
  });

  it('automatically retries pendingRepair notes after the file changes past detectedAt without relying on directory mtimes', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const { readCurateState, writeCurateState } = await import('../curate-state.js');
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeFileSync(
      join(paths.notesDir(), 'valid-note.md'),
      `---
tags: [test]
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
entrySeq: 12
---
# Valid Note
Content here.
`,
      'utf-8',
    );
    writeFileSync(
      join(paths.notesDir(), 'bad-note.md'),
      `---
tags: [test
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
entrySeq: 7
---
# Bad Note
This note has malformed frontmatter.
`,
      'utf-8',
    );
    writeCurateState(kb, {
      ...readCurateState(kb),
      processedThrough: {
        entryId: noteEntryId('valid-note'),
        entrySeq: 12,
      },
      lastAttemptedThrough: {
        entryId: noteEntryId('valid-note'),
        entrySeq: 12,
      },
      discoveryHighSeq: 12,
      discoveryOffset: 3,
    });

    await reindex(kb);

    const pendingRepair = readCurateState(kb).pendingRepair;
    expect(pendingRepair).toEqual([
      {
        entryId: noteEntryId('bad-note'),
        entrySeq: 7,
        detectedAt: expect.any(String),
      },
    ]);
    expect(readCurateState(kb)).toMatchObject({
      processedThrough: null,
      lastAttemptedThrough: null,
      discoveryHighSeq: 6,
      discoveryOffset: 0,
    });

    const detectedAt = pendingRepair?.[0]?.detectedAt;
    expect(detectedAt).toBeDefined();

    writeFileSync(
      join(paths.notesDir(), 'bad-note.md'),
      `---
tags: [test, repaired]
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-21T00:00:00.000Z
entrySeq: 7
---
# Repaired Note
This note is valid now.
`,
      'utf-8',
    );
    setMtime(join(paths.notesDir(), 'bad-note.md'), new Date(Date.parse(detectedAt!) + 60_000));
    setMtime(paths.notesDir(), new Date(Date.parse(detectedAt!) - 60_000));

    const reindexSuccessSpy = vi.spyOn(kb, 'recordReindexSuccess');

    await kb.ensureIndex();

    expect(reindexSuccessSpy).toHaveBeenCalledTimes(1);
    expect(readCurateState(kb)).toMatchObject({
      pendingRepair: null,
      discoveryHighSeq: 6,
      discoveryOffset: 0,
    });
    expect(kb.readIndex()?.entries[noteEntryId('bad-note')]).toEqual({
      kind: 'note',
      slug: 'bad-note',
      title: 'Repaired Note',
      tags: ['test', 'repaired'],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-03-20T00:00:00.000Z',
      updatedAt: '2026-03-21T00:00:00.000Z',
      related: [],
      entrySeq: 7,
    });
  });

  it('explicit reindex retries pendingRepair sources even when runtime freshness checks stay quiet', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const { readCurateState } = await import('../curate-state.js');
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.sourcesDir(), { recursive: true });

    writeFileSync(
      join(paths.sourcesDir(), 'bad-source.md'),
      `---
title: Bad Source
type: spec
tags: [reference
importedAt: 2026-03-20T00:00:00.000Z
entrySeq: 8
---
# Bad Source
Malformed source frontmatter.
`,
      'utf-8',
    );

    await reindex(kb);

    const detectedAt = readCurateState(kb).pendingRepair?.[0]?.detectedAt;
    expect(readCurateState(kb).pendingRepair).toEqual([
      {
        entryId: sourceEntryId('bad-source'),
        entrySeq: 8,
        detectedAt: expect.any(String),
      },
    ]);

    writeFileSync(
      join(paths.sourcesDir(), 'bad-source.md'),
      `---
title: Repaired Source
type: spec
tags: [reference]
importedAt: 2026-03-21T00:00:00.000Z
entrySeq: 8
---
# Repaired Source
Source body.
`,
      'utf-8',
    );
    setMtime(join(paths.sourcesDir(), 'bad-source.md'), new Date(Date.parse(detectedAt!) - 60_000));
    setMtime(paths.sourcesDir(), new Date(Date.parse(detectedAt!) - 60_000));

    const reindexSuccessSpy = vi.spyOn(kb, 'recordReindexSuccess');

    await kb.ensureIndex();
    expect(reindexSuccessSpy).not.toHaveBeenCalled();
    expect(readCurateState(kb).pendingRepair).toEqual([
      {
        entryId: sourceEntryId('bad-source'),
        entrySeq: 8,
        detectedAt: expect.any(String),
      },
    ]);

    await reindex(kb);

    expect(reindexSuccessSpy).toHaveBeenCalledTimes(1);
    expect(readCurateState(kb).pendingRepair).toBeNull();
    expect(kb.readIndex()?.entries[sourceEntryId('bad-source')]).toEqual({
      kind: 'source',
      slug: 'bad-source',
      title: 'Repaired Source',
      type: 'spec',
      tags: ['reference'],
      importedAt: '2026-03-21T00:00:00.000Z',
      related: [],
      entrySeq: 8,
    });
  });
});
