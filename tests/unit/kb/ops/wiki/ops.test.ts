import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import { wikiEntryId } from '#src/kb/entry-types.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

const mockState = vi.hoisted(() => ({ tmpHome: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => mockState.tmpHome };
});

async function loadModules() {
  vi.resetModules();
  const [
    { createWiki },
    { rewriteWikiUnderstanding },
    { linkWikiKnowledge },
    { unlinkWikiKnowledge },
    { citeWikiKnowledge },
    paths,
    frontmatter,
  ] = await Promise.all([
    import('#src/kb/ops/wiki/create.js'),
    import('#src/kb/ops/wiki/rewrite.js'),
    import('#src/kb/ops/wiki/link.js'),
    import('#src/kb/ops/wiki/unlink.js'),
    import('#src/kb/ops/wiki/cite.js'),
    import('#src/kb/paths.js'),
    import('#src/kb/corpus/frontmatter.js'),
  ]);
  return {
    createWiki,
    rewriteWikiUnderstanding,
    linkWikiKnowledge,
    unlinkWikiKnowledge,
    citeWikiKnowledge,
    paths,
    frontmatter,
  };
}

function createRuntime(_paths: Awaited<ReturnType<typeof loadModules>>['paths']) {
  return createTestKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: kbRuntimePaths('prod').root,
    db: openKbTestStoreDb(':memory:'),
  });
}

function readBody(
  path: string,
  frontmatter: Awaited<ReturnType<typeof loadModules>>['frontmatter'],
): {
  understanding: string;
  knowledge: string;
} {
  const raw = readFileSync(path, 'utf-8');
  return frontmatter.parseWikiBody(frontmatter.extractBody(raw));
}

beforeEach(() => {
  mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-wiki-ops-'));
  process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
  mkdirSync(process.env.CORAL_KB_PATH, { recursive: true });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-04-15T05:06:07.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(mockState.tmpHome, { recursive: true, force: true });
  mockState.tmpHome = '';
  delete process.env.CORAL_KB_PATH;
  vi.resetModules();
});

describe('wiki Knowledge lifecycle', () => {
  it('persists linked references and citations and removes their evidence when unlinked', async () => {
    const { createWiki, linkWikiKnowledge, citeWikiKnowledge, unlinkWikiKnowledge, paths, frontmatter } =
      await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });
    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);

    await linkWikiKnowledge(kb, { slug: 'living-knowledge', refs: ['note:alpha', 'source:s-one'] });
    expect(readBody(wikiPath, frontmatter).knowledge).toBe('- [[notes/alpha]]\n- [[sources/s-one]]');

    const evidenceFile = join(mockState.tmpHome, 'evidence.md');
    writeFileSync(evidenceFile, '2026-04-15 evidence for alpha', 'utf-8');
    await citeWikiKnowledge(kb, { slug: 'living-knowledge', ref: 'note:alpha', evidenceFile });
    expect(readBody(wikiPath, frontmatter).knowledge).toBe(
      '- [[notes/alpha]]\n  - 2026-04-15 evidence for alpha\n- [[sources/s-one]]',
    );

    await unlinkWikiKnowledge(kb, { slug: 'living-knowledge', refs: ['note:alpha'] });
    expect(readBody(wikiPath, frontmatter).knowledge).toBe('- [[sources/s-one]]');
    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toMatchObject({
      knowledge: ['source:s-one'],
    });
  });
});
