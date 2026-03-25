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

async function loadKbModules(options: { registerContracts?: boolean } = {}) {
  vi.resetModules();
  if (options.registerContracts) {
    await import('../contracts.js');
  }
  const [{ searchKb }, { reindex }, detect, paths] = await Promise.all([
    import('../search.js'),
    import('../reindex.js'),
    import('../detect.js'),
    import('../paths.js'),
  ]);
  return { searchKb, reindex, detect, paths };
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

function getKbContext(detect: Awaited<ReturnType<typeof loadKbModules>>['detect']) {
  return detect.getKbContext({
    projectRoot: '/project',
    pluginRoot: '/plugin',
    coralEnv: {},
  });
}

function resultPaths(results: { path: string }[]): string[] {
  return results.map((result) => result.path);
}

function position(paths: string[], target: string): number {
  const index = paths.indexOf(target);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function resultFor<T extends { path: string }>(results: T[], target: string): T {
  const result = results.find((entry) => entry.path === target);
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
    const { searchKb, reindex, detect, paths } = await loadKbModules();
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

    const kb = getKbContext(detect);
    await reindex(kb);

    const response = await searchKb(kb, 'rendering', 10);

    expect(response.mode).toBe('text');
    expect(resultPaths(response.results)).toContain('notes/rendering-guides.md');
    expect(resultPaths(response.results)).toContain('notes/pipeline-checklist.md');
    expect(resultPaths(response.results)).not.toContain('notes/contract-log.md');
  });

  it('uses pairwise assertions for multi-keyword BM25 ordering', async () => {
    const { searchKb, reindex, detect, paths } = await loadKbModules();
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

    const kb = getKbContext(detect);
    await reindex(kb);

    const response = await searchKb(kb, 'rendering guiding contracts', 10);
    const pathsByRank = resultPaths(response.results);

    expect(position(pathsByRank, 'notes/rendering-guiding-contracts.md'))
      .toBeLessThan(position(pathsByRank, 'notes/rendering-guiding.md'));
    expect(position(pathsByRank, 'notes/rendering-guiding.md'))
      .toBeLessThan(position(pathsByRank, 'notes/contracts-only.md'));
  });

  it('returns subset hits at threshold 1, ranks stronger matches first, and keeps snippets for subset content hits', async () => {
    const { searchKb, reindex, detect, paths } = await loadKbModules();
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

    const kb = getKbContext(detect);
    await reindex(kb);

    const response = await searchKb(kb, 'WFPG cone aperture', 10);
    const pathsByRank = resultPaths(response.results);

    expect(pathsByRank).toContain('notes/wfpg-cone-aperture.md');
    expect(pathsByRank).toContain('notes/wfpg-aperture-notes.md');
    expect(pathsByRank).toContain('notes/single-term.md');
    expect(position(pathsByRank, 'notes/wfpg-cone-aperture.md'))
      .toBeLessThan(position(pathsByRank, 'notes/wfpg-aperture-notes.md'));
    expect(position(pathsByRank, 'notes/wfpg-aperture-notes.md'))
      .toBeLessThan(position(pathsByRank, 'notes/single-term.md'));

    const subsetMatch = resultFor(response.results, 'notes/wfpg-aperture-notes.md');
    expect(subsetMatch.snippet).toBeDefined();
    expect(subsetMatch.snippet?.toLowerCase()).not.toContain('wfpg cone aperture');
  });

  it('derives matchedBy from token overlap across filename, principle, tag, title, and content', async () => {
    const { searchKb, reindex, detect, paths } = await loadKbModules();
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'contract-first-design-surface', {
      title: 'Workflow Memo',
      tags: ['tokenized-tag'],
      principles: ['contract-first-design'],
      body: 'Alignment matters here.',
    });

    const kb = getKbContext(detect);
    await reindex(kb);

    const response = await searchKb(kb, 'contract first design tokenized tag workflow alignment', 10);
    const match = resultFor(response.results, 'notes/contract-first-design-surface.md');

    expect(match.matchedBy).toEqual(['filename', 'principle', 'tag', 'title', 'content']);
  });

  it('treats hyphenated metadata as equivalent to whitespace queries', async () => {
    const { searchKb, reindex, detect, paths } = await loadKbModules();
    mkdirSync(paths.notesDir(), { recursive: true });

    writeNote(paths.notesDir(), 'contract-first-design', {
      title: 'Reference Note',
      tags: ['contract-first-design'],
      principles: ['contract-first-design'],
      body: 'This body avoids the query tokens.',
    });

    const kb = getKbContext(detect);
    await reindex(kb);

    const response = await searchKb(kb, 'contract first design', 10);
    const match = resultFor(response.results, 'notes/contract-first-design.md');

    expect(match.matchedBy).toEqual(['filename', 'principle', 'tag']);
  });

  it('auto-rebuilds when the search index is missing', async () => {
    const { searchKb, detect } = await loadKbModules({ registerContracts: true });
    const kb = getKbContext(detect);

    await expect(searchKb(kb, 'rendering', 10)).resolves.toEqual({
      results: [],
      mode: 'text',
    });
    expect(detect.readKbIndex()).toEqual({
      notes: {},
      principles: {},
    });
  });
});
