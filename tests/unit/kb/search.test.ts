import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { bindOramaFtsForTest } from '#tests/unit/kb/expansion-test-helpers.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { applyBoundCorpusConsumerForTest, createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

const writableDbByRuntime = new WeakMap<KbRuntime, ReturnType<typeof openKbTestStoreDb>>();

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
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

function createRuntime(
  _createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  _paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  const db = openKbTestStoreDb(':memory:');
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
    principles = [],
    body,
    entrySeq = 1,
  }: {
    title: string;
    tags?: string[];
    principles?: string[];
    body: string;
    entrySeq?: number;
  },
): void {
  writeFileSync(
    join(noteDir, `${slug}.md`),
    `---
tags: [${tags.join(', ')}]
principles: [${principles.join(', ')}]
source:
  - kangig94/coral
createdAt: 2026-03-23
updatedAt: 2026-03-23
entrySeq: ${entrySeq}
---
# ${title}

${body}
`,
    'utf-8',
  );
}

function writeCommunity(
  communityDir: string,
  slug: string,
  {
    title,
    members,
    level = 0,
    parent,
    children,
    summary,
    body,
  }: {
    title: string;
    members: string[];
    level?: number;
    parent?: string;
    children?: string[];
    summary?: string;
    body: string;
  },
): void {
  const lines = [
    '---',
    'createdAt: 2026-04-02',
    'updatedAt: 2026-04-02',
    `level: ${level}`,
    ...(parent === undefined ? [] : [`parent: ${parent}`]),
    ...(children === undefined ? [] : ['children:', ...children.map((child) => `  - ${child}`)]),
    '---',
    `# ${title}`,
    '',
    ...(summary === undefined ? [] : ['## Summary', '', summary, '']),
    '## Members',
    ...members.map((member) => `- #${member}`),
    '',
    body,
    '',
  ];
  writeFileSync(join(communityDir, `${slug}.md`), `${lines.join('\n')}\n`, 'utf-8');
}

function resultNotes(results: { note: string }[]): string[] {
  return results.map((result) => result.note);
}

describe('kb search', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-search-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('filters stale community documents at query time for all and community scopes', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(process.env.CORAL_KB_PATH!), { recursive: true });
    mkdirSync(paths.communitiesDir(process.env.CORAL_KB_PATH!), { recursive: true });

    writeNote(paths.notesDir(process.env.CORAL_KB_PATH!), 'retrieval-note', {
      title: 'Retrieval Note',
      tags: ['retrieval'],
      body: 'Shared retrieval patterns appear here.',
    });
    writeCommunity(paths.communitiesDir(process.env.CORAL_KB_PATH!), 'graph-rag', {
      title: 'Graph RAG',
      members: ['retrieval'],
      summary: 'Shared retrieval patterns.',
      body: 'Shared retrieval patterns appear here too.',
    });

    await reindex(kb);
    await applyOramaProjection(kb);

    const allScope = await searchKb(kb, 'shared retrieval patterns', 5, 'all');
    const communityScope = await searchKb(kb, 'shared retrieval patterns', 5, 'communities');

    expect(resultNotes(allScope.results)).toContain('retrieval-note');
    expect(resultNotes(allScope.results)).not.toContain('graph-rag');
    expect(communityScope.results).toEqual([]);
  });
});
