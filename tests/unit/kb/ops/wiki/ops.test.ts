import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kbRuntimePaths } from '#src/infra/path/kb-runtime.js';
import { wikiEntryId } from '#src/kb/entry-types.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
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
    db: createKbTestDb(kbRuntimePaths('prod').root),
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

describe('rewriteWikiUnderstanding', () => {
  it('replaces the Understanding section, leaves Knowledge intact, and bumps updatedAt', async () => {
    const { createWiki, linkWikiKnowledge, rewriteWikiUnderstanding, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });
    await linkWikiKnowledge(kb, { slug: 'living-knowledge', refs: ['note:alpha', 'note:beta'] });
    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    const knowledgeBefore = readBody(wikiPath, frontmatter).knowledge;
    const sourceFile = join(mockState.tmpHome, 'understanding.md');
    writeFileSync(sourceFile, '  External understanding source.\n  ', 'utf-8');

    vi.setSystemTime(new Date('2026-04-20T08:00:00.000Z'));
    await rewriteWikiUnderstanding(kb, { slug: 'living-knowledge', understandingFile: sourceFile });

    const sections = readBody(wikiPath, frontmatter);
    expect(sections.understanding).toBe('External understanding source.');
    expect(sections.knowledge).toBe(knowledgeBefore);
    expect(frontmatter.parseWikiFrontmatter(readFileSync(wikiPath, 'utf-8')).updatedAt).toBe(
      '2026-04-20T08:00:00.000Z',
    );
  });

  it('rejects against a missing wiki', async () => {
    const { rewriteWikiUnderstanding, paths } = await loadModules();
    const kb = createRuntime(paths);
    const sourceFile = join(mockState.tmpHome, 'u.md');
    writeFileSync(sourceFile, 'x', 'utf-8');

    await expect(rewriteWikiUnderstanding(kb, { slug: 'missing-wiki', understandingFile: sourceFile })).rejects.toThrow(
      'KB wiki not found',
    );
  });
});

describe('linkWikiKnowledge', () => {
  it('appends new refs to Knowledge in the order given (idempotent on existing refs)', async () => {
    const { createWiki, linkWikiKnowledge, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });
    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);

    await linkWikiKnowledge(kb, { slug: 'living-knowledge', refs: ['[[notes/alpha]]', 'source:s-one'] });
    await linkWikiKnowledge(kb, { slug: 'living-knowledge', refs: ['note:alpha', '[[notes/beta]]'] });

    expect(readBody(wikiPath, frontmatter).knowledge).toBe('- [[notes/alpha]]\n- [[sources/s-one]]\n- [[notes/beta]]');
    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toMatchObject({
      knowledge: ['note:alpha', 'source:s-one', 'note:beta'],
    });
  });

  it('rejects refs that are not [[link]] / entry IDs', async () => {
    const { createWiki, linkWikiKnowledge, paths } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });

    await expect(linkWikiKnowledge(kb, { slug: 'living-knowledge', refs: ['not-a-link'] })).rejects.toThrow();
  });
});

describe('unlinkWikiKnowledge', () => {
  it('removes refs and their evidence sub-bullets in one write (idempotent on missing refs)', async () => {
    const { createWiki, linkWikiKnowledge, unlinkWikiKnowledge, citeWikiKnowledge, paths, frontmatter } =
      await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });
    await linkWikiKnowledge(kb, {
      slug: 'living-knowledge',
      refs: ['note:alpha', 'note:beta', 'note:gamma'],
    });
    const evidenceFile = join(mockState.tmpHome, 'evidence.md');
    writeFileSync(evidenceFile, '2026-04-15 finding under beta', 'utf-8');
    await citeWikiKnowledge(kb, {
      slug: 'living-knowledge',
      ref: 'note:beta',
      evidenceFile,
    });
    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);

    await unlinkWikiKnowledge(kb, {
      slug: 'living-knowledge',
      refs: ['note:beta', 'note:absent'],
    });

    expect(readBody(wikiPath, frontmatter).knowledge).toBe('- [[notes/alpha]]\n- [[notes/gamma]]');
    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toMatchObject({
      knowledge: ['note:alpha', 'note:gamma'],
    });
  });
});

describe('citeWikiKnowledge', () => {
  it('appends a sub-bullet under the targeted Knowledge link', async () => {
    const { createWiki, linkWikiKnowledge, citeWikiKnowledge, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });
    await linkWikiKnowledge(kb, { slug: 'living-knowledge', refs: ['note:alpha', 'note:beta'] });
    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    const evidenceFile = join(mockState.tmpHome, 'evidence.md');
    writeFileSync(evidenceFile, '2026-04-15 follow-up finding\n', 'utf-8');

    await citeWikiKnowledge(kb, { slug: 'living-knowledge', ref: '[[notes/alpha]]', evidenceFile });

    expect(readBody(wikiPath, frontmatter).knowledge).toBe(
      ['- [[notes/alpha]]', '  - 2026-04-15 follow-up finding', '- [[notes/beta]]'].join('\n'),
    );
  });

  it('rejects citing a ref that is not in Knowledge', async () => {
    const { createWiki, linkWikiKnowledge, citeWikiKnowledge, paths } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });
    await linkWikiKnowledge(kb, { slug: 'living-knowledge', refs: ['note:alpha'] });
    const evidenceFile = join(mockState.tmpHome, 'e.md');
    writeFileSync(evidenceFile, 'stray', 'utf-8');

    await expect(citeWikiKnowledge(kb, { slug: 'living-knowledge', ref: 'note:absent', evidenceFile })).rejects.toThrow(
      'not in the Knowledge section',
    );
  });

  it('rejects when the evidence file is empty', async () => {
    const { createWiki, linkWikiKnowledge, citeWikiKnowledge, paths } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });
    await linkWikiKnowledge(kb, { slug: 'living-knowledge', refs: ['note:alpha'] });
    const evidenceFile = join(mockState.tmpHome, 'e.md');
    writeFileSync(evidenceFile, '   \n', 'utf-8');

    await expect(citeWikiKnowledge(kb, { slug: 'living-knowledge', ref: 'note:alpha', evidenceFile })).rejects.toThrow(
      'evidence file is empty',
    );
  });
});
