import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
  };
});

async function loadKbModules() {
  vi.resetModules();
  const [{ searchKb }, { reindex }, runtime, paths] = await Promise.all([
    import('../search.js'),
    import('../reindex.js'),
    import('../runtime.js'),
    import('../paths.js'),
  ]);
  return {
    searchKb,
    reindex,
    createKbRuntime: runtime.createKbRuntime,
    paths,
  };
}

function createRuntime(
  createKbRuntime: Awaited<ReturnType<typeof loadKbModules>>['createKbRuntime'],
  paths: Awaited<ReturnType<typeof loadKbModules>>['paths'],
) {
  return createKbRuntime({
    markdownRoot: process.env.CORAL_KB_PATH!,
    runtimeDir: paths.kbRuntimeDir(),
  });
}

function writeNote(
  noteDir: string,
  slug: string,
  {
    title,
    tags = [],
    principles = [],
    body,
  }: {
    title: string;
    tags?: string[];
    principles?: string[];
    body: string;
  },
): void {
  writeFileSync(join(noteDir, `${slug}.md`), `---
tags: [${tags.join(', ')}]
principles: [${principles.join(', ')}]
source:
  - kangig94/coral
createdAt: 2026-03-23
updatedAt: 2026-03-23
---
# ${title}

${body}
`, 'utf-8');
}

function resultNotes(results: { note: string }[]): string[] {
  return results.map((result) => result.note);
}

function position(notes: string[], target: string): number {
  const index = notes.indexOf(target);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function resultFor<T extends { note: string }>(results: T[], target: string): T {
  const result = results.find((entry) => entry.note === target);
  expect(result).toBeDefined();
  return result!;
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

  it('returns relevant results for a single keyword in text mode', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'rendering-guides', {
      title: 'Rendering Guides',
      tags: ['graphics'],
      body: 'Guiding contracts keep rendering predictable.',
    });
    writeNote(paths.notesDir(), 'pipeline-checklist', {
      title: 'Pipeline Checklist',
      tags: ['ops'],
      body: 'Rendering checklists help teams ship stable frames.',
    });
    writeNote(paths.notesDir(), 'contract-log', {
      title: 'Contract Log',
      tags: ['ops'],
      body: 'Audit notes only.',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'rendering', 10);

    expect(response.mode).toBe('text');
    expect(resultNotes(response.results)).toContain('rendering-guides');
    expect(resultNotes(response.results)).toContain('pipeline-checklist');
    expect(resultNotes(response.results)).not.toContain('contract-log');
  });

  it('uses pairwise assertions for multi-keyword BM25 ordering', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'rendering-guiding-contracts', {
      title: 'Rendering Guiding Contracts',
      body: 'Rendering guiding contracts keep teams aligned.',
    });
    writeNote(paths.notesDir(), 'rendering-guiding', {
      title: 'Rendering Guiding',
      body: 'Rendering guidance keeps pipelines readable.',
    });
    writeNote(paths.notesDir(), 'contracts-only', {
      title: 'Contracts Only',
      body: 'Contracts need audits.',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'rendering guiding contracts', 10);
    const notesByRank = resultNotes(response.results);

    expect(position(notesByRank, 'rendering-guiding-contracts'))
      .toBeLessThan(position(notesByRank, 'rendering-guiding'));
    expect(position(notesByRank, 'rendering-guiding'))
      .toBeLessThan(position(notesByRank, 'contracts-only'));
  });

  it('returns subset hits at threshold 1, ranks stronger matches first, and keeps snippets for subset content hits', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'wfpg-cone-aperture', {
      title: 'WFPG Cone Aperture',
      body: 'WFPG cone aperture work keeps the calibration stable.',
    });
    writeNote(paths.notesDir(), 'wfpg-aperture-notes', {
      title: 'WFPG Aperture Notes',
      body: 'WFPG measurements focus on aperture changes during calibration.',
    });
    writeNote(paths.notesDir(), 'single-term', {
      title: 'Single Term',
      body: 'Cone checks only.',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'WFPG cone aperture', 10);
    const notesByRank = resultNotes(response.results);

    expect(notesByRank).toContain('wfpg-cone-aperture');
    expect(notesByRank).toContain('wfpg-aperture-notes');
    expect(notesByRank).toContain('single-term');
    expect(position(notesByRank, 'wfpg-cone-aperture'))
      .toBeLessThan(position(notesByRank, 'wfpg-aperture-notes'));
    expect(position(notesByRank, 'wfpg-aperture-notes'))
      .toBeLessThan(position(notesByRank, 'single-term'));

    const subsetMatch = resultFor(response.results, 'wfpg-aperture-notes');
    expect(subsetMatch.snippet).toBeDefined();
    expect(subsetMatch.snippet?.toLowerCase()).not.toContain('wfpg cone aperture');
  });

  it('derives matchedBy from token overlap across filename, principle, tag, title, and content', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'contract-first-design-surface', {
      title: 'Workflow Memo',
      tags: ['tokenized-tag'],
      principles: ['contract-first-design'],
      body: 'Alignment matters here.',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'contract first design tokenized tag workflow alignment', 10);
    const match = resultFor(response.results, 'contract-first-design-surface');

    expect(match.matchedBy).toEqual(['filename', 'principle', 'tag', 'title', 'content']);
  });

  it('finds content match and snippet for accented body text via Orama-aligned token anchor', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'cafe-memo', {
      title: 'Cafe Memo',
      body: 'café',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'cafe', 10);
    const match = resultFor(response.results, 'cafe-memo');

    expect(match.matchedBy).toEqual(expect.arrayContaining(['title', 'content']));
    expect(match.snippet).toBeDefined();
  });

  it('treats hyphenated metadata as equivalent to whitespace queries', async () => {
    const { searchKb, reindex, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'contract-first-design', {
      title: 'Reference Note',
      tags: ['contract-first-design'],
      principles: ['contract-first-design'],
      body: 'This body avoids the query tokens.',
    });

    await reindex(kb);

    const response = await searchKb(kb, 'contract first design', 10);
    const match = resultFor(response.results, 'contract-first-design');

    expect(match.matchedBy).toEqual(['filename', 'principle', 'tag']);
  });

  it('auto-rebuilds when the search index is missing', async () => {
    const { searchKb, createKbRuntime, paths } = await loadKbModules();
    const kb = createRuntime(createKbRuntime, paths);

    await expect(searchKb(kb, 'rendering', 10)).resolves.toEqual({
      results: [],
      mode: 'text',
    });
    expect(kb.readIndex()).toEqual({
      notes: {},
      principles: {},
    });
  });
});
