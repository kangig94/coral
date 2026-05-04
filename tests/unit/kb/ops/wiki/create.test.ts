import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const [{ createWiki }, runtime, paths, frontmatter] = await Promise.all([
    import('#src/kb/ops/wiki/create.js'),
    import('#src/kb/runtime.js'),
    import('#src/kb/paths.js'),
    import('#src/kb/corpus/frontmatter.js'),
  ]);
  return { createWiki, createKbRuntime: runtime.createKbRuntime, paths, frontmatter };
}

function createRuntime(paths: Awaited<ReturnType<typeof loadModules>>['paths']) {
  return createTestKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir('prod'),
    db: createKbTestDb(paths.kbRuntimeDir('prod')),
  });
}

describe('createWiki', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-wiki-create-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    mkdirSync(process.env.CORAL_KB_PATH, { recursive: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-10T01:02:03.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('creates a wiki with normalized frontmatter and the canonical body shape', async () => {
    const { createWiki, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);

    const result = await createWiki(kb, {
      slug: 'living-knowledge',
      title: 'Living Knowledge',
      understanding: '  First insight.  ',
      knowledge: ['note:alpha', '[[notes/beta]]', 'source:s-one'],
      tags: ['kb'],
      references_principles: ['contract-first-design'],
      related: ['[[notes/alpha]]'],
    });

    expect(result.slug).toBe('living-knowledge');
    expect(result.path).toBe(paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!));
    const raw = readFileSync(result.path, 'utf-8');
    expect(frontmatter.parseWikiFrontmatter(raw)).toEqual({
      tags: ['kb'],
      references_principles: ['contract-first-design'],
      createdAt: '2026-04-10T01:02:03.000Z',
      updatedAt: '2026-04-10T01:02:03.000Z',
      entrySeq: 1,
      related: ['note:alpha'],
    });
    const sections = frontmatter.parseWikiBody(frontmatter.extractBody(raw));
    expect(sections.understanding).toBe('First insight.');
    expect(sections.knowledge).toBe('- [[notes/alpha]]\n- [[notes/beta]]\n- [[sources/s-one]]');
  });

  it('populates the wiki index entry knowledge field from the body', async () => {
    const { createWiki, paths } = await loadModules();
    const kb = createRuntime(paths);

    await createWiki(kb, {
      slug: 'living-knowledge',
      knowledge: ['note:alpha', 'note:beta'],
    });

    const entry = kb.readIndex()?.entries[wikiEntryId('living-knowledge')];
    expect(entry).toMatchObject({
      kind: 'wiki',
      slug: 'living-knowledge',
      knowledge: ['note:alpha', 'note:beta'],
    });
  });

  it('rejects an already-existing wiki slug', async () => {
    const { createWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    mkdirSync(paths.wikiDir(process.env.CORAL_KB_PATH!), { recursive: true });
    const existing = paths.wikiPathFromName('living-knowledge', process.env.CORAL_KB_PATH!);
    writeFileSync(existing, '# already here\n', 'utf-8');

    await expect(createWiki(kb, { slug: 'living-knowledge' })).rejects.toThrow(
      'KB wiki already exists',
    );
    expect(existsSync(existing)).toBe(true);
    expect(readFileSync(existing, 'utf-8')).toBe('# already here\n');
  });

  it('rejects malformed wiki slugs before touching disk', async () => {
    const { createWiki, paths } = await loadModules();
    const kb = createRuntime(paths);

    await expect(createWiki(kb, { slug: 'Invalid Slug' })).rejects.toThrow();
    expect(existsSync(paths.wikiDir(process.env.CORAL_KB_PATH!))).toBe(false);
  });
});
