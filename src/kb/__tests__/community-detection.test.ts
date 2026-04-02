import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTagCooccurrenceGraph,
  carryOverSlugs,
  computeCommunityMembershipFingerprint,
  detectCommunities,
  generateCommunityFiles,
  generateCommunitySummary,
  renderCommunityDocument,
  type ExistingGeneratedCommunity,
} from '../community-detection.js';
import { createKbRuntime, type KbRuntime } from '../runtime.js';
import { noteEntryId, sourceEntryId, type KbIndex, type NoteEntry, type SourceEntry } from '../types.js';

const DEFAULT_CREATED_AT = '2026-04-02';
const DEFAULT_UPDATED_AT = '2026-04-02';
const DEFAULT_IMPORTED_AT = '2026-04-02T00:00:00.000Z';

function createNote(
  slug: string,
  title: string,
  tags: string[],
  body = 'Note body.',
): { entry: NoteEntry; raw: string } {
  const raw = [
    '---',
    `tags: [${tags.join(', ')}]`,
    'principles: []',
    'source:',
    '  - kangig94/coral',
    `createdAt: ${DEFAULT_CREATED_AT}`,
    `updatedAt: ${DEFAULT_UPDATED_AT}`,
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');

  return {
    entry: {
      kind: 'note',
      slug,
      title,
      tags,
      principles: [],
      source: ['kangig94/coral'],
      createdAt: DEFAULT_CREATED_AT,
      updatedAt: DEFAULT_UPDATED_AT,
    },
    raw,
  };
}

function createSource(
  slug: string,
  title: string,
  tags: string[],
  body = 'Source body.',
): { entry: SourceEntry; raw: string } {
  const raw = [
    '---',
    `title: ${title}`,
    'type: spec',
    `tags: [${tags.join(', ')}]`,
    `importedAt: ${DEFAULT_IMPORTED_AT}`,
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');

  return {
    entry: {
      kind: 'source',
      slug,
      title,
      type: 'spec',
      tags,
      importedAt: DEFAULT_IMPORTED_AT,
      related: [],
    },
    raw,
  };
}

function createIndex(entries: Array<NoteEntry | SourceEntry>): KbIndex {
  return {
    entries: Object.fromEntries(
      entries.map((entry) => [
        entry.kind === 'note' ? noteEntryId(entry.slug) : sourceEntryId(entry.slug),
        entry,
      ]),
    ),
    principles: {},
  };
}

describe('community-detection', () => {
  let tempDir: string;
  let runtime: KbRuntime;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-community-detection-'));
    runtime = createKbRuntime({
      markdownRoot: tempDir,
      runtimeDir: tempDir,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('builds the tag graph with note-local domain exclusion and source tag preservation', () => {
    const note = createNote('coral-llm', 'LLM Note', ['coral', 'llm', 'agents']);
    const source = createSource('database-overview', 'Database Overview', ['coral', 'database']);
    const graph = buildTagCooccurrenceGraph(createIndex([note.entry, source.entry]));

    expect(graph.tags).toEqual(['agents', 'coral', 'database', 'llm']);
    expect(graph.edges).toEqual([
      {
        left: 'agents',
        right: 'llm',
        weight: 0.5,
      },
      {
        left: 'coral',
        right: 'database',
        weight: 0.5,
      },
    ]);
  });

  it('detects flat Louvain communities only', () => {
    const entries = [
      createNote('coral-transformers-a', 'Transformers A', ['coral', 'transformer', 'attention']).entry,
      createNote('coral-transformers-b', 'Transformers B', ['coral', 'transformer', 'attention', 'self-attention'])
        .entry,
      createNote('coral-sqlite-a', 'SQLite A', ['coral', 'sqlite', 'query-planning']).entry,
      createSource('sqlite-indexing', 'SQLite Indexing', ['sqlite', 'query-planning', 'indexing']).entry,
    ];
    const communities = detectCommunities(buildTagCooccurrenceGraph(createIndex(entries)));

    expect(communities).toHaveLength(2);
    expect(communities.map((community) => community.slug)).toEqual([
      'attention-transformer-self-attention',
      'query-planning-sqlite-indexing',
    ]);
    expect(communities.every((community) => community.level === 0)).toBe(true);
    expect(communities.some((community) => 'parent' in community)).toBe(false);
  });

  it('carries over prior slugs with one-to-one best-overlap matching', () => {
    const priorCommunities: ExistingGeneratedCommunity[] = [
      {
        slug: 'alpha-beta-gamma',
        title: 'Alpha / Beta / Gamma',
        members: ['alpha', 'beta', 'gamma'],
        summary: 'Alpha summary.',
        createdAt: DEFAULT_CREATED_AT,
        updatedAt: DEFAULT_UPDATED_AT,
      },
      {
        slug: 'delta-epsilon-zeta',
        title: 'Delta / Epsilon / Zeta',
        members: ['delta', 'epsilon', 'zeta'],
        summary: 'Delta summary.',
        createdAt: DEFAULT_CREATED_AT,
        updatedAt: DEFAULT_UPDATED_AT,
      },
    ];

    const communities = carryOverSlugs(
      [
        {
          freshSlug: 'fresh-alpha',
          title: 'Fresh Alpha',
          level: 0,
          members: ['alpha', 'beta'],
        },
        {
          freshSlug: 'fresh-collision',
          title: 'Fresh Collision',
          level: 0,
          members: ['alpha', 'beta', 'theta'],
        },
        {
          freshSlug: 'fresh-delta',
          title: 'Fresh Delta',
          level: 0,
          members: ['delta', 'epsilon'],
        },
      ],
      priorCommunities,
    );

    expect(Object.fromEntries(communities.map((community) => [community.title, community.slug]))).toEqual({
      'Fresh Alpha': 'alpha-beta-gamma',
      'Fresh Collision': 'fresh-collision',
      'Fresh Delta': 'delta-epsilon-zeta',
    });
  });

  it('regenerates community files with the authoritative markdown body contract', () => {
    mkdirSync(runtime.communitiesDir(), { recursive: true });
    writeFileSync(runtime.communityPath('old-community'), '# old\n', 'utf-8');

    const document = {
      slug: 'graph-rag',
      title: 'Graph RAG',
      members: ['graph-rag', 'retrieval'],
      createdAt: DEFAULT_CREATED_AT,
      updatedAt: DEFAULT_UPDATED_AT,
      membershipFingerprint: 'fingerprint',
      content: renderCommunityDocument({
        title: 'Graph RAG',
        members: ['graph-rag', 'retrieval'],
        createdAt: DEFAULT_CREATED_AT,
        updatedAt: DEFAULT_UPDATED_AT,
      }),
    };
    const wrote = generateCommunityFiles(
      runtime,
      [document],
      [
        {
          slug: 'old-community',
          title: 'Old Community',
          members: ['legacy'],
          createdAt: DEFAULT_CREATED_AT,
          updatedAt: DEFAULT_UPDATED_AT,
        },
      ],
    );

    expect(wrote).toBe(true);
    expect(existsSync(runtime.communityPath('old-community'))).toBe(false);

    const raw = readFileSync(runtime.communityPath('graph-rag'), 'utf-8');
    expect(raw).toContain('# Graph RAG');
    expect(raw).not.toContain('## Summary');
    expect(raw).toContain('## Members');
    expect(raw).toContain('- #graph-rag');
    expect(raw).toContain('- #retrieval');

    const withSummary = renderCommunityDocument({
      title: 'Graph RAG',
      members: ['graph-rag', 'retrieval'],
      summary: 'Shared retrieval graph patterns.',
      createdAt: DEFAULT_CREATED_AT,
      updatedAt: DEFAULT_UPDATED_AT,
    });
    expect(withSummary).toContain('summary: Shared retrieval graph patterns.');
    expect(withSummary).toContain('## Summary\n\nShared retrieval graph patterns.');
  });

  it('reuses stable summaries without calling Claude', async () => {
    const runClaude = vi.fn();
    const summary = await generateCommunitySummary({
      community: {
        slug: 'graph-rag',
        title: 'Graph RAG',
        level: 0,
        members: ['graph-rag', 'retrieval'],
      },
      kb: runtime,
      index: { entries: {}, principles: {} },
      priorCommunity: {
        slug: 'graph-rag',
        title: 'Graph RAG',
        members: ['graph-rag', 'retrieval'],
        summary: 'Stable summary.',
        createdAt: DEFAULT_CREATED_AT,
        updatedAt: DEFAULT_UPDATED_AT,
      },
      priorMembershipFingerprint: computeCommunityMembershipFingerprint(['graph-rag', 'retrieval']),
      runClaude,
    });

    expect(summary).toBe('Stable summary.');
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('generates summaries from member tags and representative excerpts when membership changes', async () => {
    const note = createNote(
      'coral-graph-rag',
      'Graph RAG Note',
      ['coral', 'graph-rag', 'retrieval'],
      'Graph retrieval notes connect entity links to downstream retrieval quality.',
    );
    const source = createSource(
      'retrieval-benchmark',
      'Retrieval Benchmark',
      ['retrieval', 'graph-rag', 'evaluation'],
      'Benchmarks compare retrieval precision, grounded answers, and graph expansion tradeoffs.',
    );
    mkdirSync(runtime.notesDir(), { recursive: true });
    mkdirSync(runtime.sourcesDir(), { recursive: true });
    writeFileSync(join(runtime.notesDir(), 'coral-graph-rag.md'), note.raw, 'utf-8');
    writeFileSync(join(runtime.sourcesDir(), 'retrieval-benchmark.md'), source.raw, 'utf-8');

    const runClaude = vi.fn(async ({ prompt }: { prompt: string }) => {
      expect(prompt).toContain('Community members:\n- graph-rag\n- retrieval');
      expect(prompt).toContain('## note:coral-graph-rag');
      expect(prompt).toContain('## source:retrieval-benchmark');
      return '  Shared graph-backed retrieval patterns and evaluation concerns.  ';
    });

    const summary = await generateCommunitySummary({
      community: {
        slug: 'graph-rag',
        title: 'Graph RAG',
        level: 0,
        members: ['graph-rag', 'retrieval'],
      },
      kb: runtime,
      index: createIndex([note.entry, source.entry]),
      priorCommunity: {
        slug: 'graph-rag',
        title: 'Graph RAG',
        members: ['graph-rag', 'indexing'],
        summary: 'Old summary.',
        createdAt: DEFAULT_CREATED_AT,
        updatedAt: DEFAULT_UPDATED_AT,
      },
      priorMembershipFingerprint: computeCommunityMembershipFingerprint(['graph-rag', 'indexing']),
      runClaude: async (prompt) => runClaude({ prompt }),
    });

    expect(summary).toBe('Shared graph-backed retrieval patterns and evaluation concerns.');
    expect(runClaude).toHaveBeenCalledOnce();
  });
});
