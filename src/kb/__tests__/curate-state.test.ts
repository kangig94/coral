import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCurateScheduler, type CurateHandle } from '../curate.js';
import {
  applyAddPendingDiscovery,
  applyClearCurateRetryState,
  applyRecordCurateFailure,
  applyRecordDiscoveryAttempt,
  applyRemovePendingDiscovery,
  compareCursor,
  curateStatePath,
  isClaimStale,
  readCurateState,
  writeCurateState,
  type CurateState,
} from '../curate-state.js';
import { parseFrontmatter } from '../frontmatter.js';
import { createKbRuntime, type KbRuntime } from '../runtime.js';
import { noteEntryId, type KbIndex, type NoteEntry } from '../types.js';

function createCurateState(overrides: Partial<CurateState> = {}): CurateState {
  return {
    processedThrough: null,
    discoveryHighSeq: 0,
    discoveryOffset: 0,
    lastRunDay: null,
    lastAttemptedThrough: null,
    retryNotBefore: null,
    activeClaim: null,
    pendingDiscoveries: [],
    consecutiveFailures: 0,
    initialized: false,
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

function createIndexNote(title: string, mutationSeqAtPromote?: number): Omit<NoteEntry, 'kind' | 'slug'> {
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

function createIndexEntries(notes: Record<string, ReturnType<typeof createIndexNote>>): KbIndex['entries'] {
  return Object.fromEntries(
    Object.entries(notes).map(([slug, note]) => [
      noteEntryId(slug),
      {
        kind: 'note',
        slug,
        ...note,
      },
    ]),
  );
}

function noopSpawnCli() {
  return Promise.resolve({
    stdout: '[]',
    stderr: '',
    code: 0,
    aborted: false,
  });
}

let tempDir: string;
let runtime: KbRuntime;
let scheduler: CurateHandle;
let internals: NonNullable<CurateHandle['_testInternals']>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-state-'));
  runtime = createKbRuntime({
    markdownRoot: tempDir,
    runtimeDir: tempDir,
  });
  scheduler = createCurateScheduler({
    kb: runtime,
    spawnCli: noopSpawnCli,
  });
  internals = scheduler._testInternals!;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('curate state', () => {
  it('returns defaults when the curate state file is missing', () => {
    expect(readCurateState(runtime)).toEqual(createCurateState());
  });

  it('reads persisted curate state with nested cursors and discoveries', () => {
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
      pendingDiscoveries: [
        {
          principle: 'deterministic-ordering',
          statement: 'Sort names before assigning sequences.',
          notes: ['coral-first', 'coral-second'],
          createdAt: '2026-03-25T11:58:00.000Z',
        },
      ],
      consecutiveFailures: 2,
      initialized: true,
    });

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(curateStatePath(runtime), JSON.stringify(persisted), 'utf-8');

    expect(readCurateState(runtime)).toEqual(persisted);
  });

  it('writes curate state atomically without leaving a temp file and round-trips through readCurateState', () => {
    const state = createCurateState({
      processedThrough: {
        note: 'coral-atomic',
        mutationSeqAtPromote: 7,
      },
      pendingDiscoveries: [
        {
          principle: 'atomic-persistence-or-nothing',
          statement: 'Rename temp files into place.',
          notes: ['coral-atomic'],
          createdAt: '2026-03-25T12:00:00.000Z',
        },
      ],
      initialized: true,
    });

    writeCurateState(runtime, state);

    expect(readCurateState(runtime)).toEqual(state);
    expect(existsSync(curateStatePath(runtime))).toBe(true);
    expect(existsSync(`${curateStatePath(runtime)}.tmp`)).toBe(false);
  });

  it('sorts cursors by mutation sequence before note name ties', () => {
    const sorted = [
      { note: 'coral-zeta', mutationSeqAtPromote: 1 },
      { note: 'coral-beta', mutationSeqAtPromote: 3 },
      { note: 'coral-gamma', mutationSeqAtPromote: 3 },
      { note: 'coral-alpha', mutationSeqAtPromote: 5 },
    ].sort(compareCursor);

    expect(sorted).toEqual([
      { note: 'coral-zeta', mutationSeqAtPromote: 1 },
      { note: 'coral-beta', mutationSeqAtPromote: 3 },
      { note: 'coral-gamma', mutationSeqAtPromote: 3 },
      { note: 'coral-alpha', mutationSeqAtPromote: 5 },
    ]);
  });

  it('treats no claim and recent claims as fresh, and claims older than fifteen minutes as stale', () => {
    const now = new Date().toISOString();

    expect(isClaimStale(createCurateState(), now)).toBe(false);
    expect(
      isClaimStale(
        createCurateState({
          activeClaim: {
            through: {
              note: 'coral-recent',
              mutationSeqAtPromote: 2,
            },
            startedAt: '2026-03-25T11:45:01.000Z',
          },
        }),
        now,
      ),
    ).toBe(false);
    expect(
      isClaimStale(
        createCurateState({
          activeClaim: {
            through: {
              note: 'coral-stale',
              mutationSeqAtPromote: 3,
            },
            startedAt: '2026-03-25T11:45:00.000Z',
          },
        }),
        now,
      ),
    ).toBe(true);
  });

  it('applies curate failure state transitions without disk access', () => {
    const state = createCurateState({
      lastAttemptedThrough: {
        note: 'coral-failed',
        mutationSeqAtPromote: 4,
      },
      activeClaim: {
        through: {
          note: 'coral-failed',
          mutationSeqAtPromote: 4,
        },
        startedAt: '2026-03-25T11:59:00.000Z',
      },
      consecutiveFailures: 2,
    });

    expect(applyRecordCurateFailure(state, null, new Error('transient failure'))).toEqual({
      ...state,
      lastAttemptedThrough: {
        note: 'coral-failed',
        mutationSeqAtPromote: 4,
      },
      retryNotBefore: '2026-03-25T14:00:00.000Z',
      activeClaim: null,
      consecutiveFailures: 3,
    });
  });

  it('applies retry-reset and discovery attempt transitions without rereading state', () => {
    const retryState = createCurateState({
      retryNotBefore: '2026-03-25T13:00:00.000Z',
      activeClaim: {
        through: {
          note: 'coral-active',
          mutationSeqAtPromote: 7,
        },
        startedAt: '2026-03-25T11:58:00.000Z',
      },
      consecutiveFailures: 4,
    });

    expect(applyClearCurateRetryState(createCurateState())).toBeNull();
    expect(applyClearCurateRetryState(retryState)).toEqual({
      ...retryState,
      retryNotBefore: null,
      activeClaim: null,
      consecutiveFailures: 0,
    });
    expect(applyRecordDiscoveryAttempt(createCurateState(), 61, 5)).toEqual(
      createCurateState({
        discoveryHighSeq: 61,
        discoveryOffset: 5,
      }),
    );
  });

  it('applies pending discovery add and remove transitions matching by principle and statement', () => {
    const first = {
      principle: 'contract-first-design',
      statement: 'Write the contract before the implementation.',
      notes: ['coral-alpha', 'coral-beta'],
      createdAt: '2026-03-25T12:00:00.000Z',
    };
    const second = {
      principle: 'deterministic-ordering',
      statement: 'Sort inputs before assigning identifiers.',
      notes: ['coral-gamma'],
      createdAt: '2026-03-25T12:05:00.000Z',
    };
    const state = createCurateState({
      pendingDiscoveries: [first, second],
    });

    expect(applyAddPendingDiscovery(state, first)).toBeNull();
    expect(applyAddPendingDiscovery(createCurateState(), first)).toEqual(
      createCurateState({
        pendingDiscoveries: [first],
      }),
    );
    expect(
      applyRemovePendingDiscovery(state, {
        ...first,
        notes: ['coral-beta', 'coral-alpha'],
        createdAt: '2026-03-25T13:00:00.000Z',
      }),
    ).toEqual(
      createCurateState({
        pendingDiscoveries: [second],
      }),
    );
    expect(applyRemovePendingDiscovery(state, first)).toEqual(
      createCurateState({
        pendingDiscoveries: [second],
      }),
    );
  });

  it('assigns missing mutation sequences in sorted note order starting after the highest existing sequence', async () => {
    mkdirSync(runtime.notesDir(), { recursive: true });

    writeFileSync(join(runtime.notesDir(), 'coral-second.md'), renderNote({ title: 'Coral Second' }), 'utf-8');
    writeFileSync(
      join(runtime.notesDir(), 'coral-third.md'),
      renderNote({
        title: 'Coral Third',
        mutationSeqAtPromote: 11,
      }),
      'utf-8',
    );
    writeFileSync(join(runtime.notesDir(), 'coral-first.md'), renderNote({ title: 'Coral First' }), 'utf-8');

    runtime.writeIndex({
      entries: createIndexEntries({
        'coral-first': createIndexNote('Coral First'),
        'coral-second': createIndexNote('Coral Second'),
        'coral-third': createIndexNote('Coral Third', 11),
      }),
      principles: {},
    });
    runtime.writeIndexState({
      mutationSeq: 8,
      indexedSeq: 8,
    });
    writeCurateState(runtime, createCurateState());
    const existingContent = readFileSync(join(runtime.notesDir(), 'coral-third.md'), 'utf-8');

    await internals.migrateCurateStateIfNeeded();

    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-first.md'), 'utf-8')).mutationSeqAtPromote,
    ).toBe(12);
    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-second.md'), 'utf-8')).mutationSeqAtPromote,
    ).toBe(13);
    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-third.md'), 'utf-8')).mutationSeqAtPromote,
    ).toBe(11);
    expect(readFileSync(join(runtime.notesDir(), 'coral-third.md'), 'utf-8')).toBe(existingContent);
    expect(runtime.readIndex()).toEqual({
      entries: createIndexEntries({
        'coral-first': createIndexNote('Coral First', 12),
        'coral-second': createIndexNote('Coral Second', 13),
        'coral-third': createIndexNote('Coral Third', 11),
      }),
      principles: {},
    });
    expect(runtime.readIndexState()).toEqual({
      mutationSeq: 13,
      indexedSeq: 8,
    });
    expect(readCurateState(runtime).initialized).toBe(true);
  });

  it('uses the current mutation sequence as the assignment floor and skips notes that already have mutation sequences', async () => {
    mkdirSync(runtime.notesDir(), { recursive: true });

    writeFileSync(
      join(runtime.notesDir(), 'coral-current-floor.md'),
      renderNote({
        title: 'Current Floor',
        mutationSeqAtPromote: 9,
      }),
      'utf-8',
    );
    writeFileSync(
      join(runtime.notesDir(), 'coral-late-existing.md'),
      renderNote({
        title: 'Late Existing',
        mutationSeqAtPromote: 11,
      }),
      'utf-8',
    );
    writeFileSync(
      join(runtime.notesDir(), 'coral-needs-seq.md'),
      renderNote({
        title: 'Needs Seq',
      }),
      'utf-8',
    );

    runtime.writeIndex({
      entries: createIndexEntries({
        'coral-current-floor': createIndexNote('Current Floor', 9),
        'coral-late-existing': createIndexNote('Late Existing', 11),
        'coral-needs-seq': createIndexNote('Needs Seq'),
      }),
      principles: {},
    });
    runtime.writeIndexState({
      mutationSeq: 20,
      indexedSeq: 18,
    });
    writeCurateState(runtime, createCurateState());

    await internals.migrateCurateStateIfNeeded();

    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-current-floor.md'), 'utf-8')).mutationSeqAtPromote,
    ).toBe(9);
    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-late-existing.md'), 'utf-8')).mutationSeqAtPromote,
    ).toBe(11);
    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-needs-seq.md'), 'utf-8')).mutationSeqAtPromote,
    ).toBe(21);
    expect(runtime.readIndex()).toEqual({
      entries: createIndexEntries({
        'coral-current-floor': createIndexNote('Current Floor', 9),
        'coral-late-existing': createIndexNote('Late Existing', 11),
        'coral-needs-seq': createIndexNote('Needs Seq', 21),
      }),
      principles: {},
    });
    expect(runtime.readIndexState()).toEqual({
      mutationSeq: 21,
      indexedSeq: 18,
    });
  });

  it('skips migration entirely when the stored migration version is already current', async () => {
    mkdirSync(runtime.notesDir(), { recursive: true });

    writeFileSync(join(runtime.notesDir(), 'coral-skip.md'), renderNote({ title: 'Skip Migration' }), 'utf-8');
    runtime.writeIndex({
      entries: createIndexEntries({
        'coral-skip': createIndexNote('Skip Migration'),
      }),
      principles: {},
    });
    runtime.writeIndexState({
      mutationSeq: 4,
      indexedSeq: 4,
    });
    writeCurateState(
      runtime,
      createCurateState({
        initialized: true,
        lastRunDay: '2026-03-25',
      }),
    );

    await internals.migrateCurateStateIfNeeded();

    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-skip.md'), 'utf-8')).mutationSeqAtPromote,
    ).toBeUndefined();
    expect(runtime.readIndex()).toEqual({
      entries: createIndexEntries({
        'coral-skip': createIndexNote('Skip Migration'),
      }),
      principles: {},
    });
    expect(runtime.readIndexState()).toEqual({
      mutationSeq: 4,
      indexedSeq: 4,
    });
    expect(readCurateState(runtime)).toEqual(
      createCurateState({
        initialized: true,
        lastRunDay: '2026-03-25',
      }),
    );
  });
});
