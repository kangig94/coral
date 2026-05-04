import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const [{ rewriteWiki, rewriteWikiInMutation, bubbleUpWikiKnowledge }, { createWiki }, paths, frontmatter, entryTypes] =
    await Promise.all([
      import('#src/kb/ops/wiki/rewrite.js'),
      import('#src/kb/ops/wiki/create.js'),
      import('#src/kb/paths.js'),
      import('#src/kb/corpus/frontmatter.js'),
      import('#src/kb/entry-types.js'),
    ]);
  return { rewriteWiki, rewriteWikiInMutation, bubbleUpWikiKnowledge, createWiki, paths, frontmatter, entryTypes };
}

function createRuntime(paths: Awaited<ReturnType<typeof loadModules>>['paths']) {
  return createTestKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir('prod'),
    db: createKbTestDb(paths.kbRuntimeDir('prod')),
  });
}

describe('rewriteWiki', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-wiki-rewrite-'));
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
    const { rewriteWiki, createWiki, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge', project: 'kangig94/coral', knowledge: ['note:alpha', 'note:beta'] });

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
    const { rewriteWiki, createWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge', project: 'kangig94/coral' });
    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    const before = readFileSync(wikiPath, 'utf-8');

    await rewriteWiki(kb, 'living-knowledge', () => null);

    expect(readFileSync(wikiPath, 'utf-8')).toBe(before);
  });

  it('rewriteWikiInMutation runs inside an existing mutation lock with the requested lane', async () => {
    const { rewriteWikiInMutation, createWiki, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge', project: 'kangig94/coral' });

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

    await expect(
      rewriteWiki(kb, 'no-such-wiki', () => ({ sections: { understanding: 'x' } })),
    ).rejects.toThrow('KB wiki not found');
  });

  it('updates the index Knowledge derived field even when only the body changes', async () => {
    const { rewriteWiki, createWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge', project: 'kangig94/coral', knowledge: ['note:alpha'] });

    await rewriteWiki(kb, 'living-knowledge', () => ({
      sections: { knowledge: '- [[notes/alpha]]\n- [[notes/added]]' },
    }));

    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toMatchObject({
      knowledge: ['note:alpha', 'note:added'],
    });
  });

  describe('bubbleUpWikiKnowledge (transposition heuristic)', () => {
    it('swaps a touched link with its immediate predecessor (single touch = one position up)', async () => {
      const { bubbleUpWikiKnowledge, createWiki, paths, frontmatter } = await loadModules();
      const kb = createRuntime(paths);
      await createWiki(kb, {
        slug: 'living-knowledge',
        project: 'kangig94/coral',
        knowledge: ['note:alpha', 'note:beta', 'note:gamma', 'note:delta'],
      });

      await bubbleUpWikiKnowledge(kb, 'living-knowledge', ['note:gamma']);

      const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
      const raw = readFileSync(wikiPath, 'utf-8');
      expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
        '- [[notes/alpha]]\n- [[notes/gamma]]\n- [[notes/beta]]\n- [[notes/delta]]',
      );
    });

    it('counts each touch event as a separate swap (5 touches = 5 positions up)', async () => {
      const { bubbleUpWikiKnowledge, createWiki, paths, frontmatter } = await loadModules();
      const kb = createRuntime(paths);
      await createWiki(kb, {
        slug: 'living-knowledge',
        project: 'kangig94/coral',
        knowledge: ['note:a', 'note:b', 'note:c', 'note:d', 'note:e', 'note:f'],
      });

      // Touched 'note:f' three times — should bubble up by exactly 3 positions.
      await bubbleUpWikiKnowledge(kb, 'living-knowledge', ['note:f', 'note:f', 'note:f']);

      const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
      const raw = readFileSync(wikiPath, 'utf-8');
      expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
        '- [[notes/a]]\n- [[notes/b]]\n- [[notes/f]]\n- [[notes/c]]\n- [[notes/d]]\n- [[notes/e]]',
      );
    });

    it('handles interleaved touches in event order', async () => {
      const { bubbleUpWikiKnowledge, createWiki, paths, frontmatter } = await loadModules();
      const kb = createRuntime(paths);
      await createWiki(kb, {
        slug: 'living-knowledge',
        project: 'kangig94/coral',
        knowledge: ['note:a', 'note:b', 'note:c', 'note:d', 'note:e'],
      });

      // Events: d, b, d, e
      // After d: [a, b, d, c, e]
      // After b: [b, a, d, c, e]
      // After d: [b, d, a, c, e]
      // After e: [b, d, a, e, c]
      await bubbleUpWikiKnowledge(kb, 'living-knowledge', ['note:d', 'note:b', 'note:d', 'note:e']);

      const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
      const raw = readFileSync(wikiPath, 'utf-8');
      expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
        '- [[notes/b]]\n- [[notes/d]]\n- [[notes/a]]\n- [[notes/e]]\n- [[notes/c]]',
      );
    });

    it('no-ops when the touched link is already at index 0', async () => {
      const { bubbleUpWikiKnowledge, createWiki, paths, frontmatter } = await loadModules();
      const kb = createRuntime(paths);
      await createWiki(kb, { slug: 'living-knowledge', project: 'kangig94/coral', knowledge: ['note:alpha', 'note:beta'] });

      await bubbleUpWikiKnowledge(kb, 'living-knowledge', ['note:alpha']);

      const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
      const raw = readFileSync(wikiPath, 'utf-8');
      expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
        '- [[notes/alpha]]\n- [[notes/beta]]',
      );
    });

    it('skips touches for links no longer in the Knowledge list', async () => {
      const { bubbleUpWikiKnowledge, createWiki, paths, frontmatter } = await loadModules();
      const kb = createRuntime(paths);
      await createWiki(kb, { slug: 'living-knowledge', project: 'kangig94/coral', knowledge: ['note:alpha', 'note:beta'] });

      await bubbleUpWikiKnowledge(kb, 'living-knowledge', ['note:absent', 'note:beta']);

      const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
      const raw = readFileSync(wikiPath, 'utf-8');
      // 'note:absent' is a no-op; 'note:beta' bubbles up by 1.
      expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).knowledge).toBe(
        '- [[notes/beta]]\n- [[notes/alpha]]',
      );
    });
  });
});
