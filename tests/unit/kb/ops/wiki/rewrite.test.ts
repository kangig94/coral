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
  const [{ rewriteWiki, rewriteWikiInMutation }, { createWiki }, paths, frontmatter] = await Promise.all([
    import('#src/kb/ops/wiki/rewrite.js'),
    import('#src/kb/ops/wiki/create.js'),
    import('#src/kb/paths.js'),
    import('#src/kb/corpus/frontmatter.js'),
  ]);
  return { rewriteWiki, rewriteWikiInMutation, createWiki, paths, frontmatter };
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
    await createWiki(kb, { slug: 'living-knowledge', knowledge: ['note:alpha', 'note:beta'] });

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
    await createWiki(kb, { slug: 'living-knowledge' });
    const wikiPath = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    const before = readFileSync(wikiPath, 'utf-8');

    await rewriteWiki(kb, 'living-knowledge', () => null);

    expect(readFileSync(wikiPath, 'utf-8')).toBe(before);
  });

  it('rewriteWikiInMutation runs inside an existing mutation lock with the requested lane', async () => {
    const { rewriteWikiInMutation, createWiki, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'living-knowledge' });

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
    await createWiki(kb, { slug: 'living-knowledge', knowledge: ['note:alpha'] });

    await rewriteWiki(kb, 'living-knowledge', () => ({
      sections: { knowledge: '- [[notes/alpha]]\n- [[notes/added]]' },
    }));

    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toMatchObject({
      knowledge: ['note:alpha', 'note:added'],
    });
  });
});
