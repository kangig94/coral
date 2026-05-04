import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const [{ updateWiki }, runtime, paths, frontmatter] = await Promise.all([
    import('#src/kb/ops/wiki/update.js'),
    import('#src/kb/runtime.js'),
    import('#src/kb/paths.js'),
    import('#src/kb/corpus/frontmatter.js'),
  ]);
  return { updateWiki, createKbRuntime: runtime.createKbRuntime, paths, frontmatter };
}

function createRuntime(paths: Awaited<ReturnType<typeof loadModules>>['paths']) {
  return createTestKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir('prod'),
    db: createKbTestDb(paths.kbRuntimeDir('prod')),
  });
}

const SEED_WIKI = `---
tags: [kb]
references_principles: []
createdAt: 2026-04-01T00:00:00.000Z
updatedAt: 2026-04-01T00:00:00.000Z
---
# Living Knowledge

## Understanding

Original understanding.

## Knowledge

- [[notes/alpha]]
- [[notes/beta]]
- [[notes/gamma]]

## Evidence

- 2026-04-01 notes/alpha → seed
- 2026-04-01 notes/beta → seed
- 2026-04-01 notes/gamma → seed
`;

function seedWiki(paths: Awaited<ReturnType<typeof loadModules>>['paths'], slug = 'living-knowledge'): string {
  mkdirSync(paths.wikiDir(process.env.CORAL_KB_PATH!), { recursive: true });
  const wikiPath = paths.wikiPathFromName(slug, process.env.CORAL_KB_PATH!);
  writeFileSync(wikiPath, SEED_WIKI, 'utf-8');
  return wikiPath;
}

describe('updateWiki', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-wiki-update-'));
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

  it('replaces the Understanding section with trimmed text and bumps updatedAt', async () => {
    const { updateWiki, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);
    const wikiPath = seedWiki(paths);

    await updateWiki(kb, { slug: 'living-knowledge', understanding: '  Replaced understanding.  ' });

    const raw = readFileSync(wikiPath, 'utf-8');
    expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).understanding).toBe('Replaced understanding.');
    expect(frontmatter.parseWikiFrontmatter(raw).updatedAt).toBe('2026-04-15T05:06:07.000Z');
  });

  it('appends to Evidence rather than overwriting', async () => {
    const { updateWiki, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);
    const wikiPath = seedWiki(paths);

    await updateWiki(kb, { slug: 'living-knowledge', evidenceAppend: '- 2026-04-15 notes/alpha → follow-up' });

    const raw = readFileSync(wikiPath, 'utf-8');
    const sections = frontmatter.parseWikiBody(frontmatter.extractBody(raw));
    expect(sections.evidence).toBe(
      [
        '- 2026-04-01 notes/alpha → seed',
        '- 2026-04-01 notes/beta → seed',
        '- 2026-04-01 notes/gamma → seed',
        '- 2026-04-15 notes/alpha → follow-up',
      ].join('\n'),
    );
  });

  it('adds, removes, and reorders Knowledge links and projects them into the index', async () => {
    const { updateWiki, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);
    const wikiPath = seedWiki(paths);

    await updateWiki(kb, {
      slug: 'living-knowledge',
      knowledgeAdd: ['note:delta'],
      knowledgeRemove: ['note:beta'],
      knowledgeReorder: ['note:alpha', 'note:delta', 'note:gamma'],
    });

    const raw = readFileSync(wikiPath, 'utf-8');
    const sections = frontmatter.parseWikiBody(frontmatter.extractBody(raw));
    expect(sections.knowledge).toBe('- [[notes/alpha]]\n- [[notes/delta]]\n- [[notes/gamma]]');
    // Knowledge↔Evidence 1:1 — removing note:beta auto-removes its trailing Evidence row.
    expect(sections.evidence).toBe(['- 2026-04-01 notes/alpha → seed', '- 2026-04-01 notes/gamma → seed'].join('\n'));
    expect(kb.readIndex()?.entries[wikiEntryId('living-knowledge')]).toMatchObject({
      knowledge: ['note:alpha', 'note:delta', 'note:gamma'],
    });
  });

  it('rejects knowledge-reorder that does not match the current set', async () => {
    const { updateWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    seedWiki(paths);

    await expect(
      updateWiki(kb, { slug: 'living-knowledge', knowledgeReorder: ['note:alpha', 'note:beta'] }),
    ).rejects.toThrow('knowledge-reorder must contain exactly the current Knowledge links');
  });

  it('classifies Knowledge add/remove as content lane while reorder-only stays metadata lane', async () => {
    const { updateWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    seedWiki(paths);

    const reorderState = kb.readIndexState();
    await updateWiki(kb, {
      slug: 'living-knowledge',
      knowledgeReorder: ['note:gamma', 'note:beta', 'note:alpha'],
    });
    const afterReorder = kb.readIndexState();
    expect(afterReorder.metadataSeq).toBe(reorderState.metadataSeq + 1);
    expect(afterReorder.contentSeq).toBe(reorderState.contentSeq);

    const beforeAdd = kb.readIndexState();
    await updateWiki(kb, { slug: 'living-knowledge', knowledgeAdd: ['note:delta'] });
    const afterAdd = kb.readIndexState();
    expect(afterAdd.contentSeq).toBeGreaterThan(beforeAdd.contentSeq);
    expect(afterAdd.metadataSeq).toBe(beforeAdd.metadataSeq);
  });

  it('rejects updates against a missing wiki', async () => {
    const { updateWiki, paths } = await loadModules();
    const kb = createRuntime(paths);

    await expect(updateWiki(kb, { slug: 'missing-wiki', understanding: 'x' })).rejects.toThrow('KB wiki not found');
  });

  it('reads understanding from a file path through the file selector', async () => {
    const { updateWiki, paths, frontmatter } = await loadModules();
    const kb = createRuntime(paths);
    const wikiPath = seedWiki(paths);
    const sourceFile = join(mockState.tmpHome, 'understanding.md');
    writeFileSync(sourceFile, 'External understanding source.\n', 'utf-8');

    await updateWiki(kb, { slug: 'living-knowledge', understanding: { file: sourceFile } });

    const raw = readFileSync(wikiPath, 'utf-8');
    expect(frontmatter.parseWikiBody(frontmatter.extractBody(raw)).understanding).toBe(
      'External understanding source.',
    );
  });

  it('returns the existing path without writing when nothing changes', async () => {
    const { updateWiki, paths } = await loadModules();
    const kb = createRuntime(paths);
    const wikiPath = seedWiki(paths);
    const originalRaw = readFileSync(wikiPath, 'utf-8');

    const result = await updateWiki(kb, { slug: 'living-knowledge', tags: ['kb'] });
    expect(result.path).toBe(wikiPath);
    expect(readFileSync(wikiPath, 'utf-8')).toBe(originalRaw);
  });
});
