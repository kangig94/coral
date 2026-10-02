import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeOs from 'node:os';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import { noteEntryId, wikiEntryId } from '#src/kb/entry-types.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

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
  const [{ promote }, { adoptIntoWiki }, { update }, { deleteNote }, { readEntry }, runtime, paths, frontmatter] =
    await Promise.all([
      import('#src/kb/ops/promote.js'),
      import('#src/kb/ops/wiki/adopt.js'),
      import('#src/kb/ops/update.js'),
      import('#src/kb/ops/delete.js'),
      import('#src/kb/read.js'),
      import('#src/kb/runtime.js'),
      import('#src/kb/paths.js'),
      import('#src/kb/corpus/frontmatter.js'),
    ]);
  return {
    promote,
    adoptIntoWiki,
    update,
    deleteNote,
    readEntry,
    createKbRuntime: runtime.createKbRuntime,
    paths,
    frontmatter,
  };
}

function createRuntime(
  _createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  _paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  return createTestKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: kbRuntimePaths('prod').root,
    db: openKbTestStoreDb(':memory:'),
  });
}

describe('kb mutations', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-mutate-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    mkdirSync(join(mockState.tmpHome, 'vault', 'principles'), { recursive: true });
    writeFileSync(
      join(mockState.tmpHome, 'vault', 'principles', 'lenient-read-strict-write.md'),
      '---\ncreatedAt: 2026-03-23\nupdatedAt: 2026-03-23\n---\nRule.\n',
      'utf-8',
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T01:02:03.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('adoptIntoWiki promotes a memo and prepends the new note to wiki Knowledge under the same mutation', async () => {
    const { adoptIntoWiki, createKbRuntime, paths, frontmatter } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(paths.memoDir(projectRoot), { recursive: true });
    mkdirSync(paths.wikiDir(process.env.CORAL_KB_PATH!), { recursive: true });

    const memoPath = join(paths.memoDir(projectRoot), '2026-03-23-kb.md');
    writeFileSync(
      memoPath,
      `---
source: kangig94/coral
---
memo body
`,
      'utf-8',
    );

    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    writeFileSync(
      wikiPath,
      `---
tags: [kb]
createdAt: 2026-03-20T00:00:00.000Z
updatedAt: 2026-03-20T00:00:00.000Z
---
# Living Knowledge

## Understanding

Existing understanding.

## Knowledge

- [[notes/existing-note]]
  - 2026-03-20 seed
`,
      'utf-8',
    );

    const result = await adoptIntoWiki(kb, projectRoot, {
      slug: 'living-knowledge',
      memo: '2026-03-23-kb.md',
      title: 'KB Promotion',
      content: '## Rule\nPromote through the tool.',
      domain: 'coral',
      topic: 'kb-promotion',
    });

    expect(result.path).toBe(paths.notePathFromName('coral-kb-promotion', process.env.CORAL_KB_PATH!));
    expect(result.wikiSlug).toBe('living-knowledge');
    expect(existsSync(memoPath)).toBe(false);

    const wiki = readFileSync(wikiPath, 'utf-8');
    expect(frontmatter.parseWikiFrontmatter(wiki)).toMatchObject({
      updatedAt: '2026-03-23T01:02:03.000Z',
    });
    expect(frontmatter.parseWikiBody(frontmatter.extractBody(wiki)).knowledge).toBe(
      '- [[notes/coral-kb-promotion]]\n- [[notes/existing-note]]\n  - 2026-03-20 seed',
    );
    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toMatchObject({
      kind: 'wiki',
      slug: 'living-knowledge',
      knowledge: [noteEntryId('coral-kb-promotion'), noteEntryId('existing-note')],
      updatedAt: '2026-03-23T01:02:03.000Z',
    });
  });

  it('rejects memo paths outside the active project memo directory before touching files', async () => {
    const { promote, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    const projectRoot = join(mockState.tmpHome, 'project');
    mkdirSync(projectRoot, { recursive: true });

    const outsideMemo = join(mockState.tmpHome, 'outside.md');
    writeFileSync(
      outsideMemo,
      `---
source: kangig94/coral
---
memo body
`,
      'utf-8',
    );

    await expect(
      promote(kb, projectRoot, {
        memo: '../outside.md',
        title: 'KB Promotion',
        content: '## Rule\nPromote through the tool.',
        domain: 'coral',
        topic: 'kb-promotion',
      }),
    ).rejects.toThrow();

    expect(existsSync(outsideMemo)).toBe(true);
  });
});
