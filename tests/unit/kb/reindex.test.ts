import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import type { KbRuntime } from '#src/kb/contract.js';
import type { ReadonlyDatabase } from '#src/store/read-types.js';
import { noteEntryId, sourceEntryId, type EntityGraph } from '#src/kb/entry-types.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { cursorTimestampFromStorageSeq, noteCursor } from '#src/kb/curate/state/index.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { curateDb } from '../../../src/kb/curate/db-access.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

const readDbByRuntime = new WeakMap<KbRuntime, ReadonlyDatabase>();

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
  };
});

async function loadKbModules() {
  vi.resetModules();
  const [{ reindex }, runtime, paths, read, community] = await Promise.all([
    import('#src/kb/ops/reindex.js'),
    import('#src/kb/runtime.js'),
    import('#src/kb/paths.js'),
    import('#src/kb/read.js'),
    import('#src/kb/curate/community/index.js'),
  ]);
  return {
    reindex,
    createKbRuntime: runtime.createKbRuntime,
    paths,
    readEntry: read.readEntry,
    runCommunitySubphase: community.runCommunitySubphase,
  };
}

function createRuntime(
  _createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  _paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  const { kb, readDb } = createKbTestRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: kbRuntimePaths('prod').root,
    db: openKbTestStoreDb(':memory:'),
  });
  readDbByRuntime.set(kb, readDb);
  return kb;
}

function setMtime(path: string, mtime: Date): void {
  utimesSync(path, mtime, mtime);
}

function expectPendingRepairEntries(
  pendingRepair: Array<{
    entryId: string;
    entrySeq: number | null;
    detectedAt: string;
    reason?: string;
    retryCount?: number;
    retryNotBefore?: string;
  }> | null,
  expected: ReadonlyArray<{ entryId: string; entrySeq: number | null }>,
): void {
  expect(pendingRepair).not.toBeNull();
  expect(pendingRepair).toHaveLength(expected.length);

  for (const expectedEntry of expected) {
    const repair = pendingRepair?.find((entry) => entry.entryId === expectedEntry.entryId);
    expect(repair).toBeDefined();
    // Phase 3+ writes typed canonical incident reasons (e.g. `frontmatter-shape/yaml-parse-error`)
    // when the typed-detector pipeline supersedes the shallow `pending-repair` row in the queue.
    // The shallow `pending-repair` reason still appears for entries the typed pipeline does not touch.
    expect(repair).toEqual(
      expect.objectContaining({
        entryId: expectedEntry.entryId,
        entrySeq: expectedEntry.entrySeq,
        retryCount: 0,
      }),
    );
    expect(repair?.reason).toMatch(/^(?:pending-repair|[a-z-]+\/[a-z-]+)$/);
    expect(repair?.retryNotBefore).toBe(repair?.detectedAt);
  }
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

  it('repairs entity-graph-driven topology on reindex after a manual entity graph edit', async () => {
    const { reindex, createKbRuntime, paths, runCommunitySubphase } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeFileSync(
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'graph-rag-note.md'),
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

    await kb.writeEntityGraph({
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

    await reindex(kb);
    await runCommunitySubphase(kb);
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

  it('persists malformed note and source files into pendingRepair during reindex rebuilds', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.sourcesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeFileSync(
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'valid-note.md'),
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
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'bad-note.md'),
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
      join(paths.sourcesDir(process.env.CORAL_KB_PATH!), 'bad-source.md'),
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
    const { readCurateRetryQueue } = await import('#src/kb/curate/retry.js');
    expectPendingRepairEntries(readCurateRetryQueue(readDbByRuntime.get(kb)!), [
      {
        entryId: noteEntryId('bad-note'),
        entrySeq: 7,
      },
      {
        entryId: sourceEntryId('bad-source'),
        entrySeq: null,
      },
    ]);
  });

  it('automatically retries pendingRepair notes after file content changes without relying on mtimes', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const { readCurateState, writeCurateState } = await import('#src/kb/curate/state/index.js');
    const { readCurateRetryQueue } = await import('#src/kb/curate/retry.js');
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeFileSync(
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'valid-note.md'),
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
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'bad-note.md'),
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
    const validNoteCursor = noteCursor('valid-note', cursorTimestampFromStorageSeq(12));
    writeCurateState(curateDb(kb), {
      ...readCurateState(curateDb(kb)),
      processedThrough: validNoteCursor,
      lastAttemptedThrough: validNoteCursor,
      discoveryHighSeq: 12,
      discoveryOffset: 3,
    });

    await reindex(kb);

    const pendingRepair = readCurateRetryQueue(readDbByRuntime.get(kb)!);
    expectPendingRepairEntries(pendingRepair, [
      {
        entryId: noteEntryId('bad-note'),
        entrySeq: 7,
      },
    ]);
    expect(readCurateState(curateDb(kb))).toMatchObject({
      processedThrough: validNoteCursor,
      lastAttemptedThrough: validNoteCursor,
      discoveryHighSeq: 6,
      discoveryOffset: 0,
    });

    const detectedAt = pendingRepair[0]?.detectedAt;
    expect(detectedAt).toBeDefined();

    writeFileSync(
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'bad-note.md'),
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
    setMtime(
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'bad-note.md'),
      new Date(Date.parse(detectedAt) - 60_000),
    );
    setMtime(paths.notesDir(process.env.CORAL_KB_PATH!), new Date(Date.parse(detectedAt) - 60_000));

    const corpusCommitSpy = vi.spyOn(kb, 'commitCorpusProjection');

    await kb.ensureCorpusFreshness({ wait: true });

    expect(corpusCommitSpy).toHaveBeenCalledTimes(1);
    expect(readCurateState(curateDb(kb))).toMatchObject({
      discoveryHighSeq: 12,
      discoveryOffset: 3,
    });
    expect(readCurateRetryQueue(readDbByRuntime.get(kb)!)).toEqual([]);
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
      bodyHash: computeBodySurfaceHash('This note is valid now.'),
      entrySeq: 7,
    });
  });
});
