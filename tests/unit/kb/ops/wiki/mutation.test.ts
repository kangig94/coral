import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    { rewriteWiki, rewriteWikiInMutation, bubbleUpWikiKnowledge },
    { createWiki },
    { linkWikiKnowledge },
    paths,
    frontmatter,
  ] = await Promise.all([
    import('#src/kb/ops/wiki/mutation.js'),
    import('#src/kb/ops/wiki/create.js'),
    import('#src/kb/ops/wiki/link.js'),
    import('#src/kb/paths.js'),
    import('#src/kb/corpus/frontmatter.js'),
  ]);
  return {
    rewriteWiki,
    rewriteWikiInMutation,
    bubbleUpWikiKnowledge,
    createWiki,
    linkWikiKnowledge,
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

async function seedWiki(
  modules: Awaited<ReturnType<typeof loadModules>>,
  kb: ReturnType<typeof createRuntime>,
  slug: string,
  knowledgeRefs: readonly string[] = [],
): Promise<void> {
  await modules.createWiki(kb, { slug });
  if (knowledgeRefs.length > 0) {
    await modules.linkWikiKnowledge(kb, { slug, refs: knowledgeRefs });
  }
}

describe('rewriteWiki kernel', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-wiki-mutation-'));
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

  it('rewrites the Knowledge section through rewriteWiki and updates the index knowledge field', async () => {
    const modules = await loadModules();
    const { rewriteWiki, paths, frontmatter } = modules;
    const kb = createRuntime(paths);
    await seedWiki(modules, kb, 'living-knowledge', ['note:alpha', 'note:beta']);

    await rewriteWiki(kb, 'living-knowledge', () => ({
      sections: { knowledge: '- [[notes/gamma]]\n- [[notes/alpha]]' },
    }));

    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    const raw = readFileSync(wikiPath, 'utf-8');
    expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
      '- [[notes/gamma]]\n- [[notes/alpha]]',
    );
    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toMatchObject({
      knowledge: ['note:gamma', 'note:alpha'],
    });
  });

  it('rewriteWiki returns the path without writing when the mutation function returns null', async () => {
    const modules = await loadModules();
    const { rewriteWiki, paths } = modules;
    const kb = createRuntime(paths);
    await seedWiki(modules, kb, 'living-knowledge');
    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    const before = readFileSync(wikiPath, 'utf-8');

    await rewriteWiki(kb, 'living-knowledge', () => null);

    expect(readFileSync(wikiPath, 'utf-8')).toBe(before);
  });

  it('rewriteWikiInMutation runs inside an existing mutation lock with the requested lane', async () => {
    const modules = await loadModules();
    const { rewriteWikiInMutation, paths, frontmatter } = modules;
    const kb = createRuntime(paths);
    await seedWiki(modules, kb, 'living-knowledge');

    await kb.withMutationLock(async (mutation) => {
      await rewriteWikiInMutation(
        kb,
        mutation,
        'living-knowledge',
        () => ({ sections: { understanding: 'New understanding via mutation.' } }),
        { lane: 'metadata', reason: 'unit test rewrite' },
      );
    });

    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    const raw = readFileSync(wikiPath, 'utf-8');
    expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).understanding).toBe(
      'New understanding via mutation.',
    );
  });

  it('rewriteWiki rejects against a missing wiki', async () => {
    const { rewriteWiki, paths } = await loadModules();
    const kb = createRuntime(paths);

    await expect(rewriteWiki(kb, 'no-such-wiki', () => ({ sections: { understanding: 'x' } }))).rejects.toThrow(
      'KB wiki not found',
    );
  });

  it('updates the index Knowledge derived field even when only the body changes', async () => {
    const modules = await loadModules();
    const { rewriteWiki, paths } = modules;
    const kb = createRuntime(paths);
    await seedWiki(modules, kb, 'living-knowledge', ['note:alpha']);

    await rewriteWiki(kb, 'living-knowledge', () => ({
      sections: { knowledge: '- [[notes/alpha]]\n- [[notes/added]]' },
    }));

    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toMatchObject({
      knowledge: ['note:alpha', 'note:added'],
    });
  });

  describe('bubbleUpWikiKnowledge (transposition heuristic)', () => {
    it('swaps a touched link with its immediate predecessor (single touch = one position up)', async () => {
      const modules = await loadModules();
      const { bubbleUpWikiKnowledge, paths, frontmatter } = modules;
      const kb = createRuntime(paths);
      await seedWiki(modules, kb, 'living-knowledge', ['note:alpha', 'note:beta', 'note:gamma', 'note:delta']);

      await bubbleUpWikiKnowledge(kb, 'living-knowledge', ['note:gamma']);

      const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
      const raw = readFileSync(wikiPath, 'utf-8');
      expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
        '- [[notes/alpha]]\n- [[notes/gamma]]\n- [[notes/beta]]\n- [[notes/delta]]',
      );
    });

    it('counts each touch event as a separate swap (3 touches = 3 positions up)', async () => {
      const modules = await loadModules();
      const { bubbleUpWikiKnowledge, paths, frontmatter } = modules;
      const kb = createRuntime(paths);
      await seedWiki(modules, kb, 'living-knowledge', ['note:a', 'note:b', 'note:c', 'note:d', 'note:e', 'note:f']);

      await bubbleUpWikiKnowledge(kb, 'living-knowledge', ['note:f', 'note:f', 'note:f']);

      const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
      const raw = readFileSync(wikiPath, 'utf-8');
      expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
        '- [[notes/a]]\n- [[notes/b]]\n- [[notes/f]]\n- [[notes/c]]\n- [[notes/d]]\n- [[notes/e]]',
      );
    });

    it('handles interleaved touches in event order', async () => {
      const modules = await loadModules();
      const { bubbleUpWikiKnowledge, paths, frontmatter } = modules;
      const kb = createRuntime(paths);
      await seedWiki(modules, kb, 'living-knowledge', ['note:a', 'note:b', 'note:c', 'note:d', 'note:e']);

      await bubbleUpWikiKnowledge(kb, 'living-knowledge', ['note:d', 'note:b', 'note:d', 'note:e']);

      const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
      const raw = readFileSync(wikiPath, 'utf-8');
      expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
        '- [[notes/b]]\n- [[notes/d]]\n- [[notes/a]]\n- [[notes/e]]\n- [[notes/c]]',
      );
    });

    it('no-ops when the touched link is already at index 0', async () => {
      const modules = await loadModules();
      const { bubbleUpWikiKnowledge, paths, frontmatter } = modules;
      const kb = createRuntime(paths);
      await seedWiki(modules, kb, 'living-knowledge', ['note:alpha', 'note:beta']);

      await bubbleUpWikiKnowledge(kb, 'living-knowledge', ['note:alpha']);

      const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
      const raw = readFileSync(wikiPath, 'utf-8');
      expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
        '- [[notes/alpha]]\n- [[notes/beta]]',
      );
    });

    it('skips touches for links no longer in the Knowledge list', async () => {
      const modules = await loadModules();
      const { bubbleUpWikiKnowledge, paths, frontmatter } = modules;
      const kb = createRuntime(paths);
      await seedWiki(modules, kb, 'living-knowledge', ['note:alpha', 'note:beta']);

      await bubbleUpWikiKnowledge(kb, 'living-knowledge', ['note:absent', 'note:beta']);

      const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
      const raw = readFileSync(wikiPath, 'utf-8');
      expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
        '- [[notes/beta]]\n- [[notes/alpha]]',
      );
    });
  });
});
