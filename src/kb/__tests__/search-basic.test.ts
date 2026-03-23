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
  const [{ searchBasic }, detect, paths] = await Promise.all([
    import('../search-basic.js'),
    import('../detect.js'),
    import('../paths.js'),
  ]);
  return { searchBasic, detect, paths };
}

describe('kb search basic mode', () => {
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

  it('matches filename tag principle and title, dedupes surfaces, and ranks deterministically', async () => {
    const { searchBasic, detect } = await loadKbModules();
    detect.writeKbIndex({
      notes: {
        'accel-file': {
          title: 'Accel File',
          tags: ['infra'],
          principles: ['contract-first-design'],
          source: ['kangig94/coral'],
          createdAt: '2026-03-23',
          updatedAt: '2026-03-23',
        },
        'accel-tag': {
          title: 'Plain',
          tags: ['accel'],
          principles: ['contract-first-design'],
          source: ['kangig94/coral'],
          createdAt: '2026-03-23',
          updatedAt: '2026-03-23',
        },
        mid: {
          title: 'Accel Tag',
          tags: ['accel'],
          principles: ['contract-first-design'],
          source: ['kangig94/coral'],
          createdAt: '2026-03-23',
          updatedAt: '2026-03-23',
        },
        'title-only': {
          title: 'Accel Only',
          tags: ['infra'],
          principles: ['contract-first-design'],
          source: ['kangig94/coral'],
          createdAt: '2026-03-23',
          updatedAt: '2026-03-23',
        },
        'principle-only': {
          title: 'Principle',
          tags: ['infra'],
          principles: ['accel-principle'],
          source: ['kangig94/coral'],
          createdAt: '2026-03-23',
          updatedAt: '2026-03-23',
        },
      },
      principles: {
        'accel-principle': 'Acceleration principle.',
      },
    });

    const kb = detect.getKbContext({
      projectRoot: '/project',
      pluginRoot: '/plugin',
      coralEnv: {},
    });

    const accelResults = searchBasic(kb, 'accel', 10);
    expect(accelResults.mode).toBe('basic');
    expect(accelResults.results.map((result) => result.path)).toEqual([
      'notes/accel-tag.md',
      'notes/accel-file.md',
      'notes/mid.md',
      'notes/title-only.md',
    ]);
    expect(accelResults.results[0]?.matchedBy).toEqual(['filename', 'tag']);
    expect(accelResults.results[1]?.matchedBy).toEqual(['filename', 'title']);
    expect(accelResults.results[2]?.matchedBy).toEqual(['tag', 'title']);
    expect(accelResults.results[3]?.matchedBy).toEqual(['title']);

    const principleResults = searchBasic(kb, 'accel-principle', 10);
    expect(principleResults.results).toHaveLength(1);
    expect(principleResults.results[0]?.path).toBe('notes/principle-only.md');
    expect(principleResults.results[0]?.matchedBy).toEqual(['principle']);
  });

  it('treats query text literally and uses content fallback snippets only when needed', async () => {
    const { searchBasic, detect, paths } = await loadKbModules();
    detect.writeKbIndex({
      notes: {
        'accel-literal': {
          title: 'No wildcard here',
          tags: ['infra'],
          principles: ['contract-first-design'],
          source: ['kangig94/coral'],
          createdAt: '2026-03-23',
          updatedAt: '2026-03-23',
        },
      },
      principles: {},
    });

    mkdirSync(paths.notesDir(), { recursive: true });
    writeFileSync(join(paths.notesDir(), 'literal-body.md'), `---
tags: [infra]
principles: [contract-first-design]
source:
  - kangig94/coral
createdAt: 2026-03-23
updatedAt: 2026-03-23
---
# Literal Body

This note stores accel* as literal text inside the body.
`, 'utf-8');
    writeFileSync(join(paths.notesDir(), 'accel-literal.md'), `---
tags: [infra]
principles: [contract-first-design]
source:
  - kangig94/coral
createdAt: 2026-03-23
updatedAt: 2026-03-23
---
# No wildcard here

This body mentions accel but never the starred term.
`, 'utf-8');

    const kb = detect.getKbContext({
      projectRoot: '/project',
      pluginRoot: '/plugin',
      coralEnv: {},
    });

    const response = searchBasic(kb, 'accel*', 10);
    expect(response.results).toHaveLength(1);
    expect(response.results[0]).toMatchObject({
      path: 'notes/literal-body.md',
      matchedBy: ['content'],
    });
    expect(response.results[0]?.snippet).toContain('accel*');
  });

  it('returns the reindex warning when the JSON index is missing', async () => {
    const { searchBasic, detect } = await loadKbModules();
    const kb = detect.getKbContext({
      projectRoot: '/project',
      pluginRoot: '/plugin',
      coralEnv: {},
    });

    expect(searchBasic(kb, 'accel', 10)).toEqual({
      results: [],
      mode: 'basic',
      warning: 'Run kb_reindex to build the search index.',
    });
  });
});
