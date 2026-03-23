import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const [{ searchEnhanced }, detect, paths] = await Promise.all([
    import('../search-enhanced.js'),
    import('../detect.js'),
    import('../paths.js'),
  ]);
  return { searchEnhanced, detect, paths };
}

describe('kb search enhanced mode', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-search-enhanced-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
  });

  afterEach(() => {
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('falls back to basic search with a warning when persisted index state is stale', async () => {
    const { searchEnhanced, detect } = await loadKbModules();
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
      },
      principles: {},
    });
    detect.writeIndexState({
      mutationSeq: 2,
      indexedSeq: 1,
      staleReason: 'out-of-sync',
    });

    const getDb = vi.fn(async () => {
      throw new Error('enhanced query should not run while stale');
    });
    const response = await searchEnhanced({
      projectRoot: '/project',
      kbRoot: process.env.CORAL_KB_PATH!,
      adapter: {
        getDb,
        ensureTables: async () => {},
      },
    }, 'accel', 10);

    expect(getDb).not.toHaveBeenCalled();
    expect(response.mode).toBe('basic');
    expect(response.results.map((result) => result.path)).toEqual(['notes/accel-file.md']);
    expect(response.warning).toContain('kb_reindex');
  });

  it('records a stale reason and falls back to basic search when a LanceDB query fails', async () => {
    const { searchEnhanced, detect } = await loadKbModules();
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
      },
      principles: {},
    });
    detect.writeIndexState({
      mutationSeq: 4,
      indexedSeq: 4,
    });

    const brokenTable = {
      query: () => ({
        where: () => ({
          select: () => ({
            toArray: async () => {
              throw new Error('boom');
            },
          }),
        }),
      }),
    };

    const response = await searchEnhanced({
      projectRoot: '/project',
      kbRoot: process.env.CORAL_KB_PATH!,
      adapter: {
        getDb: async () => ({
          openTable: async () => brokenTable,
        }),
        ensureTables: async () => {},
      },
    }, 'accel', 10);

    expect(response.mode).toBe('basic');
    expect(response.results.map((result) => result.path)).toEqual(['notes/accel-file.md']);
    expect(response.warning).toContain('kb_reindex');
    expect(detect.readIndexState().staleReason).toContain('Enhanced KB search failed: boom');
  });
});
