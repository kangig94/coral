import type * as FsMod from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as MemoMod from '#src/kb/ops/memo.js';
import { memoDir, notePathFromName, wikiPathFromName } from '#src/kb/paths.js';
import type * as SearchMod from '#src/kb/ops/search.js';
import { KB_BARE_READ_ORDER, expandKbReadSelector, parseKbSelector } from '#src/kb/selector.js';
import type { KbToolRuntime, KnowledgeBaseRuntime } from '#src/kb/subsystem.js';
import {
  handleKbCommunityRead,
  handleKbDelete,
  handleKbDiagnose,
  handleKbMemo,
  handleKbMemoDelete,
  handleKbMemoDeleteConsolidated,
  handleKbMemoList,
  handleKbMemoPurge,
  handleKbMemoRead,
  handleKbNoteRead,
  handleKbPrincipleRead,
  handleKbPrinciples,
  handleKbPromote,
  handleKbRead,
  handleKbSearch,
  handleKbSourceDelete,
  handleKbSourceList,
  handleKbSourceRead,
  handleKbUpdate,
  handleKbWakeUp,
  handleKbWikiAdopt,
  handleKbWikiCite,
  handleKbWikiCreate,
  handleKbWikiDelete,
  handleKbWikiLink,
  handleKbWikiList,
  handleKbWikiRead,
  handleKbWikiRewrite,
  handleKbWikiUnlink,
} from '#src/kb/tool-handlers.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';

const mockState = vi.hoisted(() => ({
  searchKb: vi.fn(),
  deleteMemos: vi.fn(),
  purgeMemos: vi.fn(),
  files: new Map<string, string>(),
  createWiki: vi.fn(),
  rewriteWikiUnderstanding: vi.fn(),
  linkWikiKnowledge: vi.fn(),
  unlinkWikiKnowledge: vi.fn(),
  citeWikiKnowledge: vi.fn(),
  adoptIntoWiki: vi.fn(),
  deleteWiki: vi.fn(),
  listWikis: vi.fn(),
  generateWakeUpPacket: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof FsMod>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((path: FsMod.PathLike) => mockState.files.has(String(path))),
    readFileSync: vi.fn((path: FsMod.PathOrFileDescriptor) => {
      const key = String(path);
      const content = mockState.files.get(key);
      if (content !== undefined) {
        return content;
      }

      const error = new Error(`ENOENT: no such file or directory, open '${key}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }),
  };
});

vi.mock('#src/kb/ops/search.js', async () => {
  const actual = await vi.importActual<typeof SearchMod>('#src/kb/ops/search.js');
  return {
    ...actual,
    searchKb: mockState.searchKb,
  };
});

vi.mock('#src/kb/ops/memo.js', async () => {
  const actual = await vi.importActual<typeof MemoMod>('#src/kb/ops/memo.js');
  return {
    ...actual,
    deleteMemos: mockState.deleteMemos,
    purgeMemos: mockState.purgeMemos,
  };
});

vi.mock('#src/kb/ops/wiki/create.js', () => ({ createWiki: mockState.createWiki }));
vi.mock('#src/kb/ops/wiki/rewrite.js', () => ({ rewriteWikiUnderstanding: mockState.rewriteWikiUnderstanding }));
vi.mock('#src/kb/ops/wiki/link.js', () => ({ linkWikiKnowledge: mockState.linkWikiKnowledge }));
vi.mock('#src/kb/ops/wiki/unlink.js', () => ({ unlinkWikiKnowledge: mockState.unlinkWikiKnowledge }));
vi.mock('#src/kb/ops/wiki/cite.js', () => ({ citeWikiKnowledge: mockState.citeWikiKnowledge }));
vi.mock('#src/kb/ops/wiki/adopt.js', () => ({ adoptIntoWiki: mockState.adoptIntoWiki }));
vi.mock('#src/kb/ops/wiki/delete.js', () => ({ deleteWiki: mockState.deleteWiki }));
vi.mock('#src/kb/ops/wiki/list.js', () => ({ listWikis: mockState.listWikis }));
vi.mock('#src/kb/ops/wake-up.js', () => ({ generateWakeUpPacket: mockState.generateWakeUpPacket }));

const KB_ROOT = '/virtual/kb';

function createKbSubsystem(): KnowledgeBaseRuntime {
  return {
    kb: {
      notePath: (slug: string) => `${KB_ROOT}/notes/${slug}.md`,
      wikiPath: (slug: string) => `${KB_ROOT}/wiki/${slug}.md`,
      sourcePath: (slug: string) => `${KB_ROOT}/sources/${slug}.md`,
      communityPath: (slug: string) => `${KB_ROOT}/communities/${slug}.md`,
      principlePath: (slug: string) => `${KB_ROOT}/principles/${slug}.md`,
    } as KnowledgeBaseRuntime['kb'],
    readDb: {} as KnowledgeBaseRuntime['readDb'],
    curateScheduler: {
      start: vi.fn(async () => {}),
      schedule: vi.fn(),
      scheduleDeferredCommit: vi.fn(),
      stop: vi.fn(async () => {}),
      isRunning: () => false,
    },
  };
}

const testContext: InvocationContext = {
  projectRoot: '/tmp/project',
  pluginRoot: '/tmp/plugin',
  coralEnv: {},
  authority: 'admin',
};

const testRuntime = {
  storage: {
    existsSync: (path: string) => mockState.files.has(path),
    readFileSync: (path: string, _encoding: 'utf-8') => {
      const content = mockState.files.get(path);
      if (content !== undefined) {
        return content;
      }

      const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    },
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({
      size: 0,
      mtimeMs: 0,
      isDirectory: () => false,
      isFile: () => true,
    })),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
  ids: {
    uuid: () => 'test-uuid',
  },
  paths: {
    // Identity resolver: the per-project data dir under test is the project root
    // itself, so `memoDir(projectData)` keeps matching the fixture memo paths.
    projectData: (projectRoot: string) => projectRoot,
    projectSource: (projectRoot: string) => projectRoot,
  },
} as unknown as KbToolRuntime;

function expectInvalidRequest(result: unknown): void {
  expect(result).toMatchObject({
    ok: false,
    code: 'invalid_request',
  });
}

function expectNotFound(result: unknown): void {
  expect(result).toMatchObject({
    ok: false,
    code: 'not_found',
  });
}

function setMockFile(path: string, content: string): void {
  mockState.files.set(path, content);
}

describe('kb-tools', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockState.files.clear();
  });

  it.each([
    ['search', () => handleKbSearch({ query: 'contracts', extra: true }, createKbSubsystem())],
    ['read', () => handleKbRead({ note: 'contracts/overview', extra: true }, testContext, testRuntime)],
    [
      'promote',
      () =>
        handleKbPromote(
          {
            memo: 'memo-1',
            title: 'Title',
            content: 'Body',
            domain: 'eng',
            topic: 'routing',
            extra: true,
          },
          createKbSubsystem(),
          testContext,
          testRuntime,
        ),
    ],
    [
      'update',
      () => handleKbUpdate({ note: 'contracts/overview', title: 'Updated', extra: true }, createKbSubsystem()),
    ],
    ['delete', () => handleKbDelete({ note: 'contracts/overview', extra: true }, createKbSubsystem())],
    ['source-list', () => handleKbSourceList({ extra: true }, createKbSubsystem())],
    ['source-delete', () => handleKbSourceDelete({ slug: 'bridge-removal-plan', extra: true }, createKbSubsystem())],
    ['diagnose', () => handleKbDiagnose({ extra: true }, createKbSubsystem())],
    ['principles', () => handleKbPrinciples({ query: 'contract', extra: true }, createKbSubsystem())],
    [
      'memo',
      () =>
        handleKbMemo({ topic: 'routing', content: 'memo', owner: 'owner-a', extra: true }, testContext, testRuntime),
    ],
    ['memo-list', () => handleKbMemoList({ owner: 'owner-a', extra: true }, testContext, testRuntime)],
    [
      'memo-delete',
      () => handleKbMemoDelete({ pattern: '*', owner: 'owner-a', extra: true }, testContext, testRuntime),
    ],
    ['memo-purge', () => handleKbMemoPurge({ owner: 'owner-a', extra: true }, testContext, testRuntime)],
  ])('rejects undeclared fields for %s', async (_name, run) => {
    expectInvalidRequest(await run());
  });

  it('uses search defaults after schema parsing', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.searchKb.mockResolvedValue({ hits: ['note:a'] });

    const result = await handleKbSearch({ query: 'contracts' }, kbSubsystem);

    expect(mockState.searchKb).toHaveBeenCalledWith(kbSubsystem.kb, 'contracts', 20, 'all', 'auto', undefined);
    expect(result).toEqual({
      ok: true,
      data: { hits: ['note:a'] },
    });
  });

  it('forwards explicit search modes after schema parsing', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.searchKb.mockResolvedValue({ hits: ['note:a'], mode: 'vector' });

    const result = await handleKbSearch({ query: 'contracts', mode: 'vector' }, kbSubsystem);

    expect(mockState.searchKb).toHaveBeenCalledWith(kbSubsystem.kb, 'contracts', 20, 'all', 'vector', undefined);
    expect(result).toEqual({
      ok: true,
      data: { hits: ['note:a'], mode: 'vector' },
    });
  });

  it('parses shared KB selectors and preserves bare read order', () => {
    expect(parseKbSelector('sources:my-slug')).toEqual({ kind: 'source', slug: 'my-slug' });
    expect(parseKbSelector('communities:my-slug')).toEqual({ kind: 'community', slug: 'my-slug' });
    expect(parseKbSelector('wiki:my-slug')).toEqual({ kind: 'wiki', slug: 'my-slug' });
    expect(parseKbSelector('my-slug')).toEqual({ kind: null, slug: 'my-slug' });
    expect(KB_BARE_READ_ORDER).toEqual(['memo', 'note', 'wiki', 'community', 'source', 'principle']);
    expect(expandKbReadSelector(parseKbSelector('my-slug')).map(({ kind }) => kind)).toEqual([
      'note',
      'wiki',
      'community',
      'source',
      'principle',
    ]);
    expect(expandKbReadSelector(parseKbSelector('20260323-010203-shared-slug')).map(({ kind }) => kind)).toEqual([
      'memo',
      'note',
      'wiki',
      'community',
      'source',
      'principle',
    ]);
  });

  it('reads a note by slug via the per-kind note handler', () => {
    const kbSubsystem = createKbSubsystem();
    setMockFile(
      notePathFromName('contract-first-design', KB_ROOT),
      `---
tags: [contracts, kb]
principles: [single-source-of-truth]
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-21T00:00:00.000Z
---
# Contract First Design

State contracts first.
`,
    );

    expect(handleKbNoteRead('contract-first-design', testContext, testRuntime, kbSubsystem)).toEqual({
      ok: true,
      data: {
        kind: 'note',
        note: 'contract-first-design',
        title: 'Contract First Design',
        content: 'State contracts first.',
        tags: ['contracts', 'kb'],
        principles: ['single-source-of-truth'],
        updatedAt: '2026-03-21T00:00:00.000Z',
      },
    });
  });

  it('returns not_found for a missing note read', () => {
    expectNotFound(handleKbNoteRead('missing-note', testContext, testRuntime, createKbSubsystem()));
  });

  it('reads a source by slug via the per-kind source handler', () => {
    const kbSubsystem = createKbSubsystem();
    setMockFile(
      kbSubsystem.kb.sourcePath('bridge-removal-plan'),
      `---
title: Bridge Removal Plan
type: markdown
tags: [plan, bridge]
importedAt: 2026-04-07T00:00:00.000Z
---
Source body.
`,
    );

    expect(handleKbSourceRead('bridge-removal-plan', kbSubsystem, testRuntime)).toEqual({
      ok: true,
      data: {
        kind: 'source',
        note: 'bridge-removal-plan',
        title: 'Bridge Removal Plan',
        content: 'Source body.',
        tags: ['plan', 'bridge'],
        principles: [],
      },
    });
  });

  it('returns not_found for a missing source read', () => {
    expectNotFound(handleKbSourceRead('missing-source', createKbSubsystem(), testRuntime));
  });

  it('reads a community by slug via the per-kind community handler', () => {
    const kbSubsystem = createKbSubsystem();
    setMockFile(
      kbSubsystem.kb.communityPath('graph-rag'),
      `---
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-24T12:00:00.000Z
level: 1
parent: community:architecture
children:
  - community:graph-rag-indexing
---
# Graph Rag

## Summary

Clusters graph-backed retrieval notes.

## Members
- source:bridge-removal-plan
- note:contract-first-design
`,
    );

    expect(handleKbCommunityRead('graph-rag', kbSubsystem, testRuntime)).toEqual({
      ok: true,
      data: {
        kind: 'community',
        note: 'graph-rag',
        title: 'Graph Rag',
        content:
          '## Summary\n\nClusters graph-backed retrieval notes.\n\n## Members\n- source:bridge-removal-plan\n- note:contract-first-design',
        tags: [],
        principles: [],
        members: ['note:contract-first-design', 'source:bridge-removal-plan'],
        level: 1,
        parent: 'community:architecture',
        children: ['community:graph-rag-indexing'],
        summary: 'Clusters graph-backed retrieval notes.',
        updatedAt: '2026-03-24T12:00:00.000Z',
      },
    });
  });

  it('returns not_found for a missing community read', () => {
    expectNotFound(handleKbCommunityRead('missing-community', createKbSubsystem(), testRuntime));
  });

  it('reads a wiki by slug via the per-kind wiki handler', () => {
    const kbSubsystem = createKbSubsystem();
    setMockFile(
      wikiPathFromName('living-knowledge', KB_ROOT),
      `---
tags: [kb, wiki]
createdAt: 2026-04-01T00:00:00.000Z
updatedAt: 2026-04-02T00:00:00.000Z
---
# Living Knowledge

## Understanding

Wiki entries keep durable understanding.

## Knowledge

- [[notes/contract-first-design]]
  - 2026-04-01 initial row
`,
    );

    expect(handleKbWikiRead('living-knowledge', kbSubsystem, testRuntime)).toEqual({
      ok: true,
      data: {
        kind: 'wiki',
        note: 'living-knowledge',
        title: 'Living Knowledge',
        content: [
          '## Understanding',
          '',
          'Wiki entries keep durable understanding.',
          '',
          '## Knowledge',
          '',
          '- [[notes/contract-first-design]]',
          '  - 2026-04-01 initial row',
        ].join('\n'),
        tags: ['kb', 'wiki'],
        principles: [],
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
    });
  });

  it('returns not_found for a missing wiki read', () => {
    expectNotFound(handleKbWikiRead('missing-wiki', createKbSubsystem(), testRuntime));
  });

  it('reads a memo by slug via the per-kind memo handler', () => {
    const slug = '20260323-010203-shared-slug';
    setMockFile(
      `${memoDir(testContext.projectRoot)}/${slug}.md`,
      `---
source: kangig94/coral
owner: owner-a
---
Memo body.
`,
    );

    expect(handleKbMemoRead(slug, testContext, testRuntime)).toEqual({
      ok: true,
      data: {
        kind: 'memo',
        note: slug,
        title: slug,
        content: 'Memo body.',
        tags: [],
        principles: [],
      },
    });
  });

  it('keeps per-kind memo reads scoped to memo files even for non-timestamp slugs', () => {
    setMockFile(
      `${memoDir(testContext.projectRoot)}/scratch.md`,
      `---
source: kangig94/coral
---
Scratch body.
`,
    );

    expect(handleKbMemoRead('scratch', testContext, testRuntime)).toEqual({
      ok: true,
      data: {
        kind: 'memo',
        note: 'scratch',
        title: 'scratch',
        content: 'Scratch body.',
        tags: [],
        principles: [],
      },
    });
  });

  it('returns not_found for a missing memo read', () => {
    expectNotFound(handleKbMemoRead('20260323-010203-missing', testContext, testRuntime));
  });

  it('reads a principle by slug via the per-kind principle handler', () => {
    const kbSubsystem = createKbSubsystem();
    const raw = '---\ncreatedAt: 2026-03-23\nupdatedAt: 2026-03-23\n---\nState contracts first.\n';
    setMockFile(kbSubsystem.kb.principlePath('contract-first-design'), raw);

    expect(handleKbPrincipleRead('contract-first-design', kbSubsystem, testRuntime)).toEqual({
      ok: true,
      data: {
        kind: 'principle',
        note: 'contract-first-design',
        title: 'contract-first-design',
        content: 'State contracts first.',
        rawContent: raw,
        tags: [],
        principles: [],
        updatedAt: '2026-03-23',
      },
    });
  });

  it('returns not_found for a missing principle read', () => {
    expectNotFound(handleKbPrincipleRead('missing-principle', createKbSubsystem(), testRuntime));
  });

  it('keeps memo precedence for timestamp-shaped bare reads', () => {
    const slug = '20260323-010203-shared-slug';
    setMockFile(
      `${memoDir(testContext.projectRoot)}/${slug}.md`,
      `---
source: kangig94/coral
---
Memo body.
`,
    );
    setMockFile(
      notePathFromName(slug, KB_ROOT),
      `---
tags: [contracts]
principles: [single-source-of-truth]
source:
  - kangig94/coral
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
---
# Note Title

Note body.
`,
    );

    expect(handleKbRead({ note: slug }, testContext, testRuntime, createKbSubsystem())).toEqual({
      ok: true,
      data: {
        kind: 'memo',
        note: slug,
        title: slug,
        content: 'Memo body.',
        tags: [],
        principles: [],
      },
    });
  });

  it('dispatches explicit community selectors through the shared read contract', () => {
    const kbSubsystem = createKbSubsystem();
    setMockFile(
      kbSubsystem.kb.communityPath('graph-rag'),
      `---
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-24T12:00:00.000Z
level: 1
---
# Graph Rag

## Members
- note:contract-first-design
`,
    );

    expect(handleKbRead({ note: 'communities:graph-rag' }, testContext, testRuntime, kbSubsystem)).toMatchObject({
      ok: true,
      data: {
        kind: 'community',
        note: 'graph-rag',
      },
    });
  });

  it('consolidates memo delete pattern mode', () => {
    mockState.deleteMemos.mockReturnValue({
      deleted: ['20260323-010203-shared-slug.md'],
      count: 1,
    });

    const result = handleKbMemoDeleteConsolidated({ pattern: '2026*', owner: 'owner-a' }, testContext, testRuntime);

    expect(mockState.deleteMemos).toHaveBeenCalledWith(testRuntime.storage, testContext.projectRoot, {
      pattern: '2026*',
      owner: 'owner-a',
    });
    expect(result).toEqual({
      ok: true,
      data: {
        deleted: ['20260323-010203-shared-slug.md'],
        count: 1,
      },
    });
  });

  it('consolidates memo delete purge mode', () => {
    mockState.purgeMemos.mockReturnValue({ deleted: 2 });

    const result = handleKbMemoDeleteConsolidated({ all: true, owner: 'owner-a' }, testContext, testRuntime);

    expect(mockState.purgeMemos).toHaveBeenCalledWith(testRuntime.storage, testContext.projectRoot, 'owner-a');
    expect(result).toEqual({
      ok: true,
      data: { deleted: 2 },
    });
  });

  it.each([
    [{ pattern: '2026*', all: true }, 'both modes'],
    [{ owner: 'owner-a' }, 'neither mode'],
  ])('rejects consolidated memo delete when %s is provided', (args, _mode) => {
    expectInvalidRequest(handleKbMemoDeleteConsolidated(args, testContext, testRuntime));
  });

  it.each([
    ['wiki-create', () => handleKbWikiCreate({ slug: 'living-knowledge', extra: true }, createKbSubsystem())],
    [
      'wiki-rewrite',
      () =>
        handleKbWikiRewrite(
          { slug: 'living-knowledge', understandingFile: '/tmp/u.md', extra: true },
          createKbSubsystem(),
        ),
    ],
    [
      'wiki-link',
      () => handleKbWikiLink({ slug: 'living-knowledge', refs: ['note:a'], extra: true }, createKbSubsystem()),
    ],
    [
      'wiki-unlink',
      () => handleKbWikiUnlink({ slug: 'living-knowledge', refs: ['note:a'], extra: true }, createKbSubsystem()),
    ],
    [
      'wiki-cite',
      () =>
        handleKbWikiCite(
          {
            slug: 'living-knowledge',
            ref: 'note:a',
            evidenceFile: '/tmp/e.md',
            extra: true,
          },
          createKbSubsystem(),
        ),
    ],
    ['wiki-delete', () => handleKbWikiDelete({ slug: 'living-knowledge', extra: true }, createKbSubsystem())],
    ['wiki-list', () => handleKbWikiList({ extra: true }, createKbSubsystem())],
    ['wake-up', () => handleKbWakeUp({ extra: true }, createKbSubsystem())],
  ])('rejects undeclared fields for %s', async (_name, run) => {
    expectInvalidRequest(await run());
  });

  it('handleKbWikiCreate calls createWiki and schedules a deferred commit', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.createWiki.mockResolvedValue({ slug: 'living-knowledge', path: '/virtual/kb/wiki/living-knowledge.md' });

    const result = await handleKbWikiCreate({ slug: 'living-knowledge' }, kbSubsystem);

    expect(mockState.createWiki).toHaveBeenCalledWith(kbSubsystem.kb, {
      slug: 'living-knowledge',
    });
    expect(kbSubsystem.curateScheduler.scheduleDeferredCommit).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: true,
      data: { slug: 'living-knowledge', path: '/virtual/kb/wiki/living-knowledge.md' },
    });
  });

  it('handleKbWikiRewrite calls rewriteWikiUnderstanding and schedules a deferred commit', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.rewriteWikiUnderstanding.mockResolvedValue({ path: '/virtual/kb/wiki/living-knowledge.md' });

    const result = await handleKbWikiRewrite({ slug: 'living-knowledge', understandingFile: '/tmp/u.md' }, kbSubsystem);

    expect(mockState.rewriteWikiUnderstanding).toHaveBeenCalledWith(kbSubsystem.kb, {
      slug: 'living-knowledge',
      understandingFile: '/tmp/u.md',
    });
    expect(kbSubsystem.curateScheduler.scheduleDeferredCommit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
  });

  it('handleKbWikiLink calls linkWikiKnowledge and schedules a deferred commit', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.linkWikiKnowledge.mockResolvedValue({ path: '/virtual/kb/wiki/living-knowledge.md' });

    const result = await handleKbWikiLink({ slug: 'living-knowledge', refs: ['note:alpha'] }, kbSubsystem);

    expect(mockState.linkWikiKnowledge).toHaveBeenCalledWith(kbSubsystem.kb, {
      slug: 'living-knowledge',
      refs: ['note:alpha'],
    });
    expect(kbSubsystem.curateScheduler.scheduleDeferredCommit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
  });

  it('handleKbWikiUnlink calls unlinkWikiKnowledge and schedules a deferred commit', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.unlinkWikiKnowledge.mockResolvedValue({ path: '/virtual/kb/wiki/living-knowledge.md' });

    const result = await handleKbWikiUnlink({ slug: 'living-knowledge', refs: ['note:alpha'] }, kbSubsystem);

    expect(mockState.unlinkWikiKnowledge).toHaveBeenCalledWith(kbSubsystem.kb, {
      slug: 'living-knowledge',
      refs: ['note:alpha'],
    });
    expect(kbSubsystem.curateScheduler.scheduleDeferredCommit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
  });

  it('handleKbWikiCite calls citeWikiKnowledge and schedules a deferred commit', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.citeWikiKnowledge.mockResolvedValue({ path: '/virtual/kb/wiki/living-knowledge.md' });

    const result = await handleKbWikiCite(
      {
        slug: 'living-knowledge',
        ref: '[[notes/alpha]]',
        evidenceFile: '/tmp/e.md',
      },
      kbSubsystem,
    );

    expect(mockState.citeWikiKnowledge).toHaveBeenCalledWith(kbSubsystem.kb, {
      slug: 'living-knowledge',
      ref: '[[notes/alpha]]',
      evidenceFile: '/tmp/e.md',
    });
    expect(kbSubsystem.curateScheduler.scheduleDeferredCommit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
  });

  it('handleKbWikiAdopt calls adoptIntoWiki with the project root and wires onSchedule to curate scheduler', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.adoptIntoWiki.mockImplementation(async (_kb, _projectRoot, _input, onSchedule: () => void) => {
      onSchedule();
      return { path: '/virtual/kb/notes/coral-kb-promotion.md', wikiSlug: 'living-knowledge' };
    });

    const result = await handleKbWikiAdopt(
      {
        slug: 'living-knowledge',
        memo: '2026-04-15-topic.md',
        title: 'KB Promotion',
        content: '## Rule\nbody',
        domain: 'coral',
        topic: 'kb-promotion',
      },
      kbSubsystem,
      testContext,
      testRuntime,
    );

    expect(mockState.adoptIntoWiki).toHaveBeenCalledWith(
      kbSubsystem.kb,
      testContext.projectRoot,
      {
        slug: 'living-knowledge',
        memo: '2026-04-15-topic.md',
        title: 'KB Promotion',
        content: '## Rule\nbody',
        domain: 'coral',
        topic: 'kb-promotion',
      },
      expect.any(Function),
    );
    expect(kbSubsystem.curateScheduler.schedule).toHaveBeenCalledOnce();
    expect(kbSubsystem.curateScheduler.scheduleDeferredCommit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
  });

  it('handleKbWikiDelete calls deleteWiki and schedules a deferred commit', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.deleteWiki.mockResolvedValue({ deleted: '/virtual/kb/wiki/living-knowledge.md' });

    const result = await handleKbWikiDelete({ slug: 'living-knowledge' }, kbSubsystem);

    expect(mockState.deleteWiki).toHaveBeenCalledWith(kbSubsystem.kb, { slug: 'living-knowledge' });
    expect(kbSubsystem.curateScheduler.scheduleDeferredCommit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true });
  });

  it('handleKbWikiList wraps listWikis in the wikis envelope', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.listWikis.mockResolvedValue([
      { slug: 'living-knowledge', title: 'LK', knowledge: [], tags: [], createdAt: '', updatedAt: '' },
    ]);

    const result = await handleKbWikiList({}, kbSubsystem);

    expect(mockState.listWikis).toHaveBeenCalledWith(kbSubsystem.kb);
    expect(result).toMatchObject({ ok: true, data: { wikis: expect.any(Array) } });
  });

  it('handleKbWakeUp forwards the project arg after schema parsing', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.generateWakeUpPacket.mockReturnValue('## wake-up packet body');

    const result = await handleKbWakeUp({ project: 'kangig94-coral' }, kbSubsystem);

    expect(mockState.generateWakeUpPacket).toHaveBeenCalledWith(kbSubsystem.kb, 'kangig94-coral');
    expect(result).toEqual({ ok: true, data: { content: '## wake-up packet body' } });
  });

  it('handleKbWakeUp returns an empty packet when project is omitted', async () => {
    const kbSubsystem = createKbSubsystem();
    mockState.generateWakeUpPacket.mockReturnValue('');

    const result = await handleKbWakeUp({}, kbSubsystem);

    expect(mockState.generateWakeUpPacket).toHaveBeenCalledWith(kbSubsystem.kb, undefined);
    expect(result).toEqual({ ok: true, data: { content: '' } });
  });

  it('still validates memo owners after Zod parsing', () => {
    const result = handleKbMemo(
      {
        topic: 'routing',
        content: 'memo',
        owner: 'invalid owner',
      },
      testContext,
      testRuntime,
    );

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_request',
    });
  });
});
