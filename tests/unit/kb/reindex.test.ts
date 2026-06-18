import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import type { KbRuntime } from '#src/kb/contract.js';
import type { ReadonlyDatabase } from '#src/store/read-port.js';
import { communityEntryId, noteEntryId, sourceEntryId, wikiEntryId, type EntityGraph } from '#src/kb/entry-types.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { cursorTimestampFromStorageSeq, noteCursor } from '#src/kb/curate/state/index.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
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
  const [{ reindex }, runtime, paths, read] = await Promise.all([
    import('#src/kb/ops/reindex.js'),
    import('#src/kb/runtime.js'),
    import('#src/kb/paths.js'),
    import('#src/kb/read.js'),
  ]);
  return {
    reindex,
    createKbRuntime: runtime.createKbRuntime,
    paths,
    readEntry: read.readEntry,
  };
}

function createRuntime(
  _createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  const { kb, readDb } = createKbTestRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir('prod'),
    db: createKbTestDb(paths.kbRuntimeDir('prod')),
  });
  readDbByRuntime.set(kb, readDb);
  return kb;
}

function createReadPaths(paths: Awaited<ReturnType<typeof loadKbModules>>['paths']) {
  const root = process.env.CORAL_KB_PATH!;
  return {
    notePath: (slug: string) => paths.notePathFromName(slug, root),
    wikiPath: (slug: string) => paths.wikiPathFromName(slug, root),
    sourcePath: (slug: string) => paths.sourcePathFromName(slug, root),
    communityPath: (slug: string) => paths.communityPathFromName(slug, root),
    principlePath: (slug: string) => paths.principlePathFromName(slug, root),
  };
}

function setMtime(path: string, mtime: Date): void {
  utimesSync(path, mtime, mtime);
}

function renderWiki(): string {
  return [
    '---',
    'tags: [wakeful, retrieval]',
    'sources:',
    '  - note:coral-alpha',
    'createdAt: 2026-05-04T00:00:00.000Z',
    'updatedAt: 2026-05-04T01:00:00.000Z',
    '---',
    '# Living Memory',
    '',
    '## Understanding',
    '',
    'Wakeful retrieval keeps the session context ready after a cold rebuild.',
    '',
    '## Knowledge',
    '',
    '- [[notes/coral-alpha]]',
    '  - 2026-05-04 Seeded from disk.',
    '',
  ].join('\n');
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

  it('rebuilds the JSON index unconditionally in text mode without warning by default', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.principlesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeFileSync(
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'coral-kb-mode.md'),
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
      join(paths.principlesDir(process.env.CORAL_KB_PATH!), 'contract-first-design.md'),
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
          bodyHash: computeBodySurfaceHash('stale'),
          entrySeq: 1,
        },
      },
      principles: {},
      entityMeta: {},
      relationships: [],
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
          bodyHash: computeBodySurfaceHash('## Rule\nKeep the JSON index authoritative.'),
          entrySeq: 11,
        },
      },
      principles: {
        'contract-first-design': 'Make the contract explicit first.',
      },
      entityMeta: {},
      relationships: [],
    });
    expect(readFileSync(join(mockState.tmpHome, '.coral', 'data', 'kb', 'index.json'), 'utf-8')).toContain(
      '"coral-kb-mode"',
    );
  });

  it('keeps disk-created wikis through cold reindex, projection input, Orama search, and wake-up input', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const [
      { readKnowledgeBaseListIndex },
      { createKbProjectionInput },
      { parseWikiBody },
      { createOramaBaseProjection },
      { OramaSnapshotStore },
    ] = await Promise.all([
      import('#src/kb/direct-read-index.js'),
      import('#src/kb/projection-input.js'),
      import('#src/kb/corpus/frontmatter.js'),
      import('#src/engines/orama/backend.js'),
      import('#src/engines/orama/snapshot.js'),
    ]);
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.wikiDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeFileSync(
      paths.notePathFromName('coral-alpha', process.env.CORAL_KB_PATH!),
      [
        '---',
        'tags: [coral, alpha]',
        'principles: []',
        'source:',
        '  - kangig94/coral',
        'createdAt: 2026-05-04T00:00:00.000Z',
        'updatedAt: 2026-05-04T00:30:00.000Z',
        'entrySeq: 11',
        '---',
        '# Coral Alpha',
        '',
        'Authoritative note body.',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(paths.wikiPathFromName('living-memory', process.env.CORAL_KB_PATH!), renderWiki(), 'utf-8');

    const fallbackIndex = readKnowledgeBaseListIndex(kb);
    expect(fallbackIndex.entries[wikiEntryId('living-memory')]).toMatchObject({
      kind: 'wiki',
      slug: 'living-memory',
      title: 'Living Memory',
      knowledge: [noteEntryId('coral-alpha')],
    });

    const result = await reindex(kb);

    expect(result).toMatchObject({
      notes: 1,
      sources: 0,
      communities: 0,
      wikis: 1,
      principles: 0,
      tags: 4,
      mode: 'text',
    });
    expect(kb.readIndex()?.entries[wikiEntryId('living-memory')]).toMatchObject({
      kind: 'wiki',
      slug: 'living-memory',
      title: 'Living Memory',
      tags: ['wakeful', 'retrieval'],
      knowledge: [noteEntryId('coral-alpha')],
      createdAt: '2026-05-04T00:00:00.000Z',
      updatedAt: '2026-05-04T01:00:00.000Z',
    });
    expect(kb.corpusAuthorityBaseline.read().get(wikiEntryId('living-memory'))).toEqual(
      expect.objectContaining({
        entryId: wikiEntryId('living-memory'),
        contentHash: expect.any(String),
        metadataHash: expect.any(String),
      }),
    );

    const projectionInput = createKbProjectionInput(kb);
    const wikiRecord = projectionInput.records.find((record) => record.entry.slug === 'living-memory');
    expect(wikiRecord).toBeDefined();
    expect(wikiRecord?.kind).toBe('wiki');
    if (wikiRecord?.kind !== 'wiki') {
      throw new Error('Expected living-memory projection record to be a wiki.');
    }
    expect(wikiRecord?.rawContent).toContain('# Living Memory');
    expect(wikiRecord?.body).toContain('## Understanding');
    expect(parseWikiBody(wikiRecord?.body ?? '').understanding).toContain('Wakeful retrieval keeps the session');

    const projection = createOramaBaseProjection(
      kb,
      new OramaSnapshotStore({ files: kb.projectionArtifacts.files }, kb.projectionArtifacts.runtimeDir),
    );
    const preparedProjection = await projection.prepareFullSnapshot(projectionInput);
    await projection.installFullSnapshot(kb.captureCorpusSnapshot(), preparedProjection);
    const search = await projection.search('wakeful retrieval', 5, 'wiki');
    expect(search.hits[0]?.documentId).toBe(wikiEntryId('living-memory'));
  });

  it('diagnostic-skips malformed wiki section bodies during reindex without repair attempts', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const [{ backendLog }, { readCurateRetryQueue }] = await Promise.all([
      import('#src/infra/backend-log.js'),
      import('#src/kb/curate/retry.js'),
    ]);
    const kb = createRuntime(createKbRuntime, paths);
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    mkdirSync(paths.wikiDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeFileSync(
      paths.wikiPathFromName('broken-wiki', process.env.CORAL_KB_PATH!),
      [
        '---',
        'tags: [broken]',
        'createdAt: 2026-05-04T00:00:00.000Z',
        'updatedAt: 2026-05-04T00:00:00.000Z',
        '---',
        '# Broken Wiki',
        '',
        '## Understanding',
        '',
        'This wiki is missing its strict Knowledge section.',
        '',
      ].join('\n'),
      'utf-8',
    );

    try {
      const result = await reindex(kb);

      expect(result).toMatchObject({ wikis: 0 });
      expect(kb.readIndex()?.entries[wikiEntryId('broken-wiki')]).toBeUndefined();
      expect(readCurateRetryQueue(curateDb(kb)).some((entry) => entry.entryId === wikiEntryId('broken-wiki'))).toBe(
        false,
      );
      expect(
        warnSpy.mock.calls.some(
          ([message]) =>
            message.includes('Skipping malformed KB wiki broken-wiki.md') &&
            message.includes('Wiki body is missing ## Knowledge header'),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('refreshes and deletes wiki authority baseline rows from wiki manifest ids', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const { CorpusAuthorityBaselineRefresh } = await import('#src/kb/corpus/authority-baseline-refresh.js');
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.wikiDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeFileSync(paths.wikiPathFromName('living-memory', process.env.CORAL_KB_PATH!), renderWiki(), 'utf-8');
    await reindex(kb);

    const refresh = new CorpusAuthorityBaselineRefresh({
      corpusAuthorityBaseline: kb.corpusAuthorityBaseline,
      storagePort: kb.storagePort,
      getRuntime: () => kb,
      notePath: (slug) => kb.notePath(slug),
      wikiPath: (slug) => kb.wikiPath(slug),
      sourcePath: (slug) => kb.sourcePath(slug),
      communityPath: (slug) => kb.communityPath(slug),
      principlePath: (slug) => kb.principlePath(slug),
      entityGraphPath: () => kb.entityGraphPath(),
    });

    const before = kb.corpusAuthorityBaseline.read().get(wikiEntryId('living-memory'));
    expect(before).toBeDefined();

    writeFileSync(
      kb.wikiPath('living-memory'),
      renderWiki().replace('updatedAt: 2026-05-04T01:00:00.000Z', 'updatedAt: 2026-05-04T02:00:00.000Z'),
      'utf-8',
    );
    refresh.refreshAuthorityBaselineForPendingDeltas([
      { lane: 'metadata', manifestId: 'wiki-meta:living-memory', surfaceHash: 'ignored' },
    ]);
    const metadataRefreshed = kb.corpusAuthorityBaseline.read().get(wikiEntryId('living-memory'));
    expect(metadataRefreshed?.contentHash).toBe(before?.contentHash);
    expect(metadataRefreshed?.metadataHash).not.toBe(before?.metadataHash);

    writeFileSync(
      kb.wikiPath('living-memory'),
      renderWiki().replace('Wakeful retrieval keeps the session', 'Wakeful baseline refresh keeps the session'),
      'utf-8',
    );
    refresh.refreshAuthorityBaselineForPendingDeltas([
      { lane: 'content', manifestId: 'wiki:living-memory', surfaceHash: 'ignored' },
    ]);
    const contentRefreshed = kb.corpusAuthorityBaseline.read().get(wikiEntryId('living-memory'));
    expect(contentRefreshed?.contentHash).not.toBe(metadataRefreshed?.contentHash);

    rmSync(kb.wikiPath('living-memory'));
    refresh.refreshAuthorityBaselineForPendingDeltas([
      { lane: 'content', manifestId: 'wiki:living-memory', surfaceHash: null },
    ]);
    expect(kb.corpusAuthorityBaseline.read().get(wikiEntryId('living-memory'))).toBeUndefined();
  });

  it('indexes communities as first-class entries during text rebuild', async () => {
    const { reindex, createKbRuntime, paths, readEntry } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.communitiesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    const writeCommunityFile = () => {
      writeFileSync(
        join(paths.communitiesDir(process.env.CORAL_KB_PATH!), 'graph-rag.md'),
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
      entityMeta: {},
      relationships: [],
    });
    expect(
      readEntry({ note: 'communities:graph-rag' }, { storage: kb.storagePort, paths: createReadPaths(paths) }),
    ).toEqual({
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
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeFileSync(
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'graph-rag-note.md'),
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
    await kb.writeEntityGraph(graph);

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

  it('repairs entity-graph-driven topology on ensureCorpusFreshness after a manual entity graph edit', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
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

    const index = await kb.ensureCorpusFreshness({ wait: true });
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
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.principlesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    writeFileSync(
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'coral-kb-mode.md'),
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
      join(paths.principlesDir(process.env.CORAL_KB_PATH!), 'contract-first-design.md'),
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
    });

    const result = await reindex(kb);

    expect(result.mode).toBe('text');
    expect(result.warning).toBeUndefined();
  });

  it('skips notes with malformed frontmatter instead of crashing', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.principlesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    // Valid note
    writeFileSync(
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'valid-note.md'),
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
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'bad-source.md'),
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

  it('does not retry unchanged pendingRepair files on every runtime access', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
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

    await reindex(kb);
    const pendingRepair = readCurateRetryQueue(readDbByRuntime.get(kb)!);
    expectPendingRepairEntries(pendingRepair, [
      {
        entryId: noteEntryId('bad-note'),
        entrySeq: 7,
      },
    ]);
    expect(pendingRepair[0]?.observedContentHash).toMatch(/^[a-f0-9]{64}$/);
    const detectedAt = pendingRepair[0]?.detectedAt;
    expect(detectedAt).toBeDefined();
    setMtime(
      join(paths.notesDir(process.env.CORAL_KB_PATH!), 'bad-note.md'),
      new Date(Date.parse(detectedAt) + 60_000),
    );

    const reindexSuccessSpy = vi.spyOn(kb, 'recordReindexSuccess');

    await kb.ensureCorpusFreshness();
    await kb.ensureCorpusFreshness();

    expect(reindexSuccessSpy).not.toHaveBeenCalled();
    expectPendingRepairEntries(readCurateRetryQueue(readDbByRuntime.get(kb)!), [
      {
        entryId: noteEntryId('bad-note'),
        entrySeq: 7,
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

    const reindexSuccessSpy = vi.spyOn(kb, 'recordReindexSuccess');

    await kb.ensureCorpusFreshness({ wait: true });

    expect(reindexSuccessSpy).toHaveBeenCalledTimes(1);
    expect(readCurateState(curateDb(kb))).toMatchObject({
      discoveryHighSeq: 6,
      discoveryOffset: 0,
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

  it('automatically retries pendingRepair sources after file content changes even when mtimes stay quiet', async () => {
    const { reindex, createKbRuntime, paths } = await loadKbModules();
    const { readCurateRetryQueue } = await import('#src/kb/curate/retry.js');
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.sourcesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeFileSync(
      join(paths.sourcesDir(process.env.CORAL_KB_PATH!), 'bad-source.md'),
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

    const detectedAt = readCurateRetryQueue(readDbByRuntime.get(kb)!)[0]?.detectedAt;
    expectPendingRepairEntries(readCurateRetryQueue(readDbByRuntime.get(kb)!), [
      {
        entryId: sourceEntryId('bad-source'),
        entrySeq: 8,
      },
    ]);

    writeFileSync(
      join(paths.sourcesDir(process.env.CORAL_KB_PATH!), 'bad-source.md'),
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
    setMtime(
      join(paths.sourcesDir(process.env.CORAL_KB_PATH!), 'bad-source.md'),
      new Date(Date.parse(detectedAt) - 60_000),
    );
    setMtime(paths.sourcesDir(process.env.CORAL_KB_PATH!), new Date(Date.parse(detectedAt) - 60_000));

    const reindexSuccessSpy = vi.spyOn(kb, 'recordReindexSuccess');

    await kb.ensureCorpusFreshness({ wait: true });
    expect(reindexSuccessSpy).toHaveBeenCalledTimes(1);
    expect(readCurateRetryQueue(readDbByRuntime.get(kb)!)).toEqual([]);
    expect(kb.readIndex()?.entries[sourceEntryId('bad-source')]).toEqual({
      kind: 'source',
      slug: 'bad-source',
      title: 'Repaired Source',
      type: 'spec',
      tags: ['reference'],
      importedAt: '2026-03-21T00:00:00.000Z',
      related: [],
      bodyHash: computeBodySurfaceHash('Source body.'),
      entrySeq: 8,
    });
  });
});
