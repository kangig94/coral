import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurateState } from '../curate-state.js';
import type { KbIndex } from '../types.js';

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

function createCurateState(overrides: Partial<CurateState> = {}): CurateState {
  return {
    processedThrough: null,
    lastRunDay: null,
    lastAttemptedThrough: null,
    retryNotBefore: null,
    activeClaim: null,
    pendingDiscoveries: [],
    lastDiscoveryCorpusSize: 0,
    lastDiscoveryDay: null,
    consecutiveFailures: 0,
    migrationVersion: 0,
    ...overrides,
  };
}

function renderNote({
  title,
  tags = ['coral'],
  principles = [],
  source = ['kangig94/coral'],
  createdAt = '2026-03-20T00:00:00.000Z',
  updatedAt = '2026-03-20T00:00:00.000Z',
  mutationSeqAtPromote,
  body = 'Body.',
}: {
  title: string;
  tags?: string[];
  principles?: string[];
  source?: string[];
  createdAt?: string;
  updatedAt?: string;
  mutationSeqAtPromote?: number;
  body?: string;
}): string {
  const lines = [
    '---',
    `tags: [${tags.join(', ')}]`,
    `principles: [${principles.join(', ')}]`,
    'source:',
    ...source.map((entry) => `  - ${entry}`),
    `createdAt: ${createdAt}`,
    `updatedAt: ${updatedAt}`,
    ...(mutationSeqAtPromote === undefined ? [] : [`mutationSeqAtPromote: ${mutationSeqAtPromote}`]),
    '---',
    `# ${title}`,
    '',
    body,
  ];
  return `${lines.join('\n')}\n`;
}

function createIndexNote(title: string, mutationSeqAtPromote?: number): KbIndex['notes'][string] {
  return {
    title,
    tags: ['coral'],
    principles: [],
    source: ['kangig94/coral'],
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    ...(mutationSeqAtPromote === undefined ? {} : { mutationSeqAtPromote }),
  };
}

async function loadKbModules() {
  vi.resetModules();
  const [curateState, detect, paths, frontmatter] = await Promise.all([
    import('../curate-state.js'),
    import('../detect.js'),
    import('../paths.js'),
    import('../frontmatter.js'),
  ]);
  return { curateState, detect, paths, frontmatter };
}

describe('curate state', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-curate-state-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(mockState.tmpHome, { recursive: true, force: true });
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  it('returns defaults when the curate state file is missing', async () => {
    const { curateState } = await loadKbModules();

    expect(curateState.readCurateState()).toEqual(createCurateState());
  });

  it('reads persisted curate state with nested cursors and discoveries', async () => {
    const { curateState } = await loadKbModules();
    const persisted = createCurateState({
      processedThrough: {
        note: 'coral-first',
        mutationSeqAtPromote: 3,
      },
      lastRunDay: '2026-03-25',
      lastAttemptedThrough: {
        note: 'coral-second',
        mutationSeqAtPromote: 4,
      },
      retryNotBefore: '2026-03-26T00:00:00.000Z',
      activeClaim: {
        through: {
          note: 'coral-third',
          mutationSeqAtPromote: 5,
        },
        startedAt: '2026-03-25T11:55:00.000Z',
      },
      pendingDiscoveries: [{
        principle: 'deterministic-ordering',
        statement: 'Sort names before assigning sequences.',
        notes: ['coral-first', 'coral-second'],
        createdAt: '2026-03-25T11:58:00.000Z',
      }],
      lastDiscoveryCorpusSize: 9,
      lastDiscoveryDay: '2026-03-25',
      consecutiveFailures: 2,
      migrationVersion: 1,
    });

    mkdirSync(process.env.CORAL_KB_PATH!, { recursive: true });
    writeFileSync(curateState.curateStatePath(), JSON.stringify(persisted), 'utf-8');

    expect(curateState.readCurateState()).toEqual(persisted);
  });

  it('writes curate state atomically without leaving a temp file and round-trips through readCurateState', async () => {
    const { curateState } = await loadKbModules();
    const state = createCurateState({
      processedThrough: {
        note: 'coral-atomic',
        mutationSeqAtPromote: 7,
      },
      pendingDiscoveries: [{
        principle: 'atomic-persistence-or-nothing',
        statement: 'Rename temp files into place.',
        notes: ['coral-atomic'],
        createdAt: '2026-03-25T12:00:00.000Z',
      }],
      migrationVersion: 1,
    });

    curateState.writeCurateState(state);

    expect(curateState.readCurateState()).toEqual(state);
    expect(existsSync(curateState.curateStatePath())).toBe(true);
    expect(existsSync(`${curateState.curateStatePath()}.tmp`)).toBe(false);
  });

  it('sorts cursors by mutation sequence before note name ties', async () => {
    const { curateState } = await loadKbModules();
    const sorted = [
      { note: 'coral-zeta', mutationSeqAtPromote: 1 },
      { note: 'coral-beta', mutationSeqAtPromote: 3 },
      { note: 'coral-gamma', mutationSeqAtPromote: 3 },
      { note: 'coral-alpha', mutationSeqAtPromote: 5 },
    ].sort(curateState.compareCursor);

    expect(sorted).toEqual([
      { note: 'coral-zeta', mutationSeqAtPromote: 1 },
      { note: 'coral-beta', mutationSeqAtPromote: 3 },
      { note: 'coral-gamma', mutationSeqAtPromote: 3 },
      { note: 'coral-alpha', mutationSeqAtPromote: 5 },
    ]);
  });

  it('treats no claim and recent claims as fresh, and claims older than fifteen minutes as stale', async () => {
    const { curateState } = await loadKbModules();
    const now = new Date().toISOString();

    expect(curateState.isClaimStale(createCurateState(), now)).toBe(false);
    expect(curateState.isClaimStale(createCurateState({
      activeClaim: {
        through: {
          note: 'coral-recent',
          mutationSeqAtPromote: 2,
        },
        startedAt: '2026-03-25T11:45:01.000Z',
      },
    }), now)).toBe(false);
    expect(curateState.isClaimStale(createCurateState({
      activeClaim: {
        through: {
          note: 'coral-stale',
          mutationSeqAtPromote: 3,
        },
        startedAt: '2026-03-25T11:45:00.000Z',
      },
    }), now)).toBe(true);
  });

  it('assigns missing mutation sequences in sorted note order starting after the highest existing sequence', async () => {
    const { curateState, detect, paths, frontmatter } = await loadKbModules();
    mkdirSync(paths.notesDir(), { recursive: true });

    writeFileSync(join(paths.notesDir(), 'coral-second.md'), renderNote({ title: 'Coral Second' }), 'utf-8');
    writeFileSync(join(paths.notesDir(), 'coral-third.md'), renderNote({
      title: 'Coral Third',
      mutationSeqAtPromote: 11,
    }), 'utf-8');
    writeFileSync(join(paths.notesDir(), 'coral-first.md'), renderNote({ title: 'Coral First' }), 'utf-8');

    detect.writeKbIndex({
      notes: {
        'coral-first': createIndexNote('Coral First'),
        'coral-second': createIndexNote('Coral Second'),
        'coral-third': createIndexNote('Coral Third', 11),
      },
      principles: {},
    });
    detect.writeIndexState({
      mutationSeq: 8,
      indexedSeq: 8,
    });
    curateState.writeCurateState(createCurateState());
    const existingContent = readFileSync(join(paths.notesDir(), 'coral-third.md'), 'utf-8');

    await curateState.migrateCurateStateIfNeeded();

    expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-first.md'), 'utf-8')).mutationSeqAtPromote).toBe(12);
    expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-second.md'), 'utf-8')).mutationSeqAtPromote).toBe(13);
    expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-third.md'), 'utf-8')).mutationSeqAtPromote).toBe(11);
    expect(readFileSync(join(paths.notesDir(), 'coral-third.md'), 'utf-8')).toBe(existingContent);
    expect(detect.readKbIndex()).toEqual({
      notes: {
        'coral-first': createIndexNote('Coral First', 12),
        'coral-second': createIndexNote('Coral Second', 13),
        'coral-third': createIndexNote('Coral Third', 11),
      },
      principles: {},
    });
    expect(detect.readIndexState()).toEqual({
      mutationSeq: 13,
      indexedSeq: 8,
    });
    expect(curateState.readCurateState().migrationVersion).toBe(1);
  });

  it('uses the current mutation sequence as the assignment floor and skips notes that already have mutation sequences', async () => {
    const { curateState, detect, paths, frontmatter } = await loadKbModules();
    mkdirSync(paths.notesDir(), { recursive: true });

    writeFileSync(join(paths.notesDir(), 'coral-current-floor.md'), renderNote({
      title: 'Current Floor',
      mutationSeqAtPromote: 9,
    }), 'utf-8');
    writeFileSync(join(paths.notesDir(), 'coral-late-existing.md'), renderNote({
      title: 'Late Existing',
      mutationSeqAtPromote: 11,
    }), 'utf-8');
    writeFileSync(join(paths.notesDir(), 'coral-needs-seq.md'), renderNote({
      title: 'Needs Seq',
    }), 'utf-8');

    detect.writeKbIndex({
      notes: {
        'coral-current-floor': createIndexNote('Current Floor', 9),
        'coral-late-existing': createIndexNote('Late Existing', 11),
        'coral-needs-seq': createIndexNote('Needs Seq'),
      },
      principles: {},
    });
    detect.writeIndexState({
      mutationSeq: 20,
      indexedSeq: 18,
    });
    curateState.writeCurateState(createCurateState());

    await curateState.migrateCurateStateIfNeeded();

    expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-current-floor.md'), 'utf-8')).mutationSeqAtPromote).toBe(9);
    expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-late-existing.md'), 'utf-8')).mutationSeqAtPromote).toBe(11);
    expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-needs-seq.md'), 'utf-8')).mutationSeqAtPromote).toBe(21);
    expect(detect.readKbIndex()).toEqual({
      notes: {
        'coral-current-floor': createIndexNote('Current Floor', 9),
        'coral-late-existing': createIndexNote('Late Existing', 11),
        'coral-needs-seq': createIndexNote('Needs Seq', 21),
      },
      principles: {},
    });
    expect(detect.readIndexState()).toEqual({
      mutationSeq: 21,
      indexedSeq: 18,
    });
  });

  it('skips migration entirely when the stored migration version is already current', async () => {
    const { curateState, detect, paths, frontmatter } = await loadKbModules();
    mkdirSync(paths.notesDir(), { recursive: true });

    writeFileSync(join(paths.notesDir(), 'coral-skip.md'), renderNote({ title: 'Skip Migration' }), 'utf-8');
    detect.writeKbIndex({
      notes: {
        'coral-skip': createIndexNote('Skip Migration'),
      },
      principles: {},
    });
    detect.writeIndexState({
      mutationSeq: 4,
      indexedSeq: 4,
    });
    curateState.writeCurateState(createCurateState({
      migrationVersion: 1,
      lastRunDay: '2026-03-25',
    }));

    await curateState.migrateCurateStateIfNeeded();

    expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-skip.md'), 'utf-8')).mutationSeqAtPromote).toBeUndefined();
    expect(detect.readKbIndex()).toEqual({
      notes: {
        'coral-skip': createIndexNote('Skip Migration'),
      },
      principles: {},
    });
    expect(detect.readIndexState()).toEqual({
      mutationSeq: 4,
      indexedSeq: 4,
    });
    expect(curateState.readCurateState()).toEqual(createCurateState({
      migrationVersion: 1,
      lastRunDay: '2026-03-25',
    }));
  });
});
