import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noteEntryId, type KbIndex } from '../types.js';
import type * as NodeOs from 'node:os';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
}));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
  };
});

function createIndex(noteTags: Record<string, string[]>): KbIndex {
  return {
    entries: Object.fromEntries(
      Object.entries(noteTags).map(([note, tags], index) => [
        noteEntryId(note),
        {
          kind: 'note',
          slug: note,
          title: `Note ${index + 1}`,
          tags,
          principles: [],
          source: ['kangig94/coral'],
          createdAt: '2026-03-20T00:00:00.000Z',
          updatedAt: '2026-03-20T00:00:00.000Z',
        },
      ]),
    ),
    principles: {},
  };
}

async function loadKbModules() {
  vi.resetModules();
  const curateTags = await import('../curate-tags.js');
  return curateTags;
}

describe('cleanupTags', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-curate-tags-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('returns exact replacements and deletions for cohort tags, excluding domain tags and preferring plural merges over deletions', async () => {
    const { cleanupTags } = await loadKbModules();
    const index = createIndex({
      'alpha-main': ['alpha', 'widget', 'ui-pattern', 'deep-alert-pattern'],
      'alpha-secondary': ['alpha', 'widgets', 'deep-legacy-api'],
      'beta-cohort': ['beta', 'widgets', 'deep-alert-patterns'],
      'delta-support': ['delta', 'widgets', 'ui-pattern', 'deep-alert-patterns', 'alphas'],
      'epsilon-support': ['epsilon', 'alphas'],
      'zeta-support': ['zeta', 'alphas', 'isolated-pattern'],
    });

    const result = cleanupTags(index, ['alpha-main', 'alpha-secondary', 'beta-cohort']);

    expect(result).toEqual({
      globalReplacements: new Map([
        ['deep-alert-pattern', 'deep-alert-patterns'],
        ['widget', 'widgets'],
      ]),
      globalDeletions: new Set(['deep-legacy-api', 'ui-pattern']),
    });
    expect(result.globalReplacements.has('alpha')).toBe(false);
    expect(result.globalDeletions.has('alpha')).toBe(false);
    expect(result.globalDeletions.has('isolated-pattern')).toBe(false);
  });

  it('keeps the singular tag when singular and plural support counts tie', async () => {
    const { cleanupTags } = await loadKbModules();
    const index = createIndex({
      'alpha-plural-one': ['alpha', 'reports'],
      'beta-plural-two': ['beta', 'reports'],
      'gamma-singular-one': ['gamma', 'report'],
      'delta-singular-two': ['delta', 'report'],
    });

    expect(cleanupTags(index, ['alpha-plural-one', 'gamma-singular-one'])).toEqual({
      globalReplacements: new Map([['reports', 'report']]),
      globalDeletions: new Set(),
    });
  });

  it('ignores cleanup candidates that only appear on non-cohort notes', async () => {
    const { cleanupTags } = await loadKbModules();
    const index = createIndex({
      'alpha-cohort': ['alpha', 'stable'],
      'beta-hidden-pattern': ['beta', 'hidden-pattern'],
      'gamma-hidden-singular': ['gamma', 'gadget'],
      'delta-hidden-plural-one': ['delta', 'gadgets'],
      'epsilon-hidden-plural-two': ['epsilon', 'gadgets'],
    });

    expect(cleanupTags(index, ['alpha-cohort'])).toEqual({
      globalReplacements: new Map(),
      globalDeletions: new Set(),
    });
  });
});
