import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeOs from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

const mockState = vi.hoisted(() => ({ tmpHome: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, homedir: () => mockState.tmpHome };
});

async function loadModules() {
  vi.resetModules();
  const [{ listWikis }, { createWiki }, { linkWikiKnowledge }, paths] = await Promise.all([
    import('#src/kb/ops/wiki/list.js'),
    import('#src/kb/ops/wiki/create.js'),
    import('#src/kb/ops/wiki/link.js'),
    import('#src/kb/paths.js'),
  ]);
  return { listWikis, createWiki, linkWikiKnowledge, paths };
}

function createRuntime(paths: Awaited<ReturnType<typeof loadModules>>['paths']) {
  return createTestKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir('prod'),
    db: createKbTestDb(paths.kbRuntimeDir('prod')),
  });
}

describe('listWikis', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-wiki-list-'));
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

  it('returns wikis sorted by updatedAt DESC and includes the projected payload', async () => {
    const { listWikis, createWiki, linkWikiKnowledge, paths } = await loadModules();
    const kb = createRuntime(paths);

    vi.setSystemTime(new Date('2026-04-15T01:00:00.000Z'));
    await createWiki(kb, { slug: 'older-wiki' });
    await linkWikiKnowledge(kb, { slug: 'older-wiki', refs: ['note:a'] });
    vi.setSystemTime(new Date('2026-04-15T02:00:00.000Z'));
    await createWiki(kb, { slug: 'newest-wiki' });
    await linkWikiKnowledge(kb, { slug: 'newest-wiki', refs: ['note:b'] });
    vi.setSystemTime(new Date('2026-04-15T01:30:00.000Z'));
    await createWiki(kb, { slug: 'middle-wiki' });
    await linkWikiKnowledge(kb, { slug: 'middle-wiki', refs: ['note:c'] });

    const list = await listWikis(kb);

    expect(list.map((entry) => entry.slug)).toEqual(['newest-wiki', 'middle-wiki', 'older-wiki']);
    expect(list[0]).toMatchObject({
      slug: 'newest-wiki',
      knowledge: ['note:b'],
    });
  });

  it('only includes wiki entries (filters out non-wiki entries from the index)', async () => {
    const { listWikis, createWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    await createWiki(kb, { slug: 'only-wiki' });

    // Inject a non-wiki entry directly into the index.
    const index = kb.readIndex()!;
    kb.writeIndex({
      ...index,
      entries: {
        ...index.entries,
        'note:foreign': {
          kind: 'note',
          slug: 'foreign',
          title: 'Foreign Note',
          tags: [],
          principles: [],
          source: [],
          createdAt: '2026-04-15T00:00:00.000Z',
          updatedAt: '2026-04-15T00:00:00.000Z',
          related: [],
        },
      },
    });

    const list = await listWikis(kb);
    expect(list.map((entry) => entry.slug)).toEqual(['only-wiki']);
  });

  it('returns an empty list when no wikis exist', async () => {
    const { listWikis, paths } = await loadModules();
    const kb = createRuntime(paths);

    expect(await listWikis(kb)).toEqual([]);
  });
});
