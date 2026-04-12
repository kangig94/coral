import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCurateScheduler, type CurateHandle } from '../curate/scheduler.js';
import type { KbRuntime } from '../contracts.js';
import {
  applyAddPendingDiscovery,
  applyClearCurateRetryState,
  applyRecordCurateFailure,
  applyRecordDiscoveryAttempt,
  applyRemovePendingDiscovery,
  compareCursor,
  CURATE_STATE_FILE,
  CURATE_STATE_MIGRATION_VERSION,
  curateStatePath,
  extractMalformedEntryRepair,
  isClaimStale,
  normalizeCurateStateRepairFrontier,
  readCurateState,
  writeCurateState,
  type CurateState,
} from '../curate/state.js';
import { parseFrontmatter } from '../frontmatter.js';
import { createKbRuntime } from '../runtime.js';
import { noteEntryId, sourceEntryId, type KbIndex, type NoteEntry } from '../types.js';

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
    pendingRepair: null,
    communityTopologyHash: undefined,
    communitySummaryTopologyHash: undefined,
    communitySummaryInputFingerprints: undefined,
    consecutiveFailures: 0,
    initialized: false,
    migrationVersion: 0,
    ...overrides,
  };
}

function cursor(note: string, entrySeq: number) {
  return {
    entryId: noteEntryId(note),
    entrySeq,
  };
}

function renderNote({
  title,
  tags = ['coral'],
  principles = [],
  source = ['kangig94/coral'],
  createdAt = '2026-03-20T00:00:00.000Z',
  updatedAt = '2026-03-20T00:00:00.000Z',
  entrySeq,
  body = 'Body.',
}: {
  title: string;
  tags?: string[];
  principles?: string[];
  source?: string[];
  createdAt?: string;
  updatedAt?: string;
  entrySeq?: number;
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
    ...(entrySeq === undefined ? [] : [`entrySeq: ${entrySeq}`]),
    '---',
    `# ${title}`,
    '',
    body,
  ];
  return `${lines.join('\n')}\n`;
}

function renderSource({
  title,
  type = 'spec',
  tags = ['reference'],
  importedAt = '2026-03-20T00:00:00.000Z',
  entrySeq,
  body = 'Body.',
}: {
  title: string;
  type?: string;
  tags?: string[];
  importedAt?: string;
  entrySeq?: number;
  body?: string;
}): string {
  const lines = [
    '---',
    `title: ${title}`,
    `type: ${type}`,
    `tags: [${tags.join(', ')}]`,
    `importedAt: ${importedAt}`,
    ...(entrySeq === undefined ? [] : [`entrySeq: ${entrySeq}`]),
    '---',
    `# ${title}`,
    '',
    body,
  ];
  return `${lines.join('\n')}\n`;
}

function createIndexNote(title: string, entrySeq?: number): Omit<NoteEntry, 'kind' | 'slug'> {
  return {
    title,
    tags: ['coral'],
    principles: [],
    source: ['kangig94/coral'],
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    related: [],
    ...(entrySeq === undefined ? {} : { entrySeq }),
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
      processedThrough: cursor('coral-first', 3),
      lastRunDay: '2026-03-25',
      lastAttemptedThrough: cursor('coral-second', 4),
      retryNotBefore: '2026-03-26T00:00:00.000Z',
      activeClaim: {
        through: cursor('coral-third', 5),
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
      pendingRepair: [
        {
          entryId: noteEntryId('coral-repair'),
          entrySeq: 6,
          detectedAt: '2026-03-25T11:57:00.000Z',
        },
      ],
      communityTopologyHash: 'graph-hash',
      communitySummaryTopologyHash: 'graph-hash',
      communitySummaryInputFingerprints: {
        'graph-rag': 'members-hash',
      },
      consecutiveFailures: 2,
      initialized: true,
    });

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(curateStatePath(runtime), JSON.stringify(persisted), 'utf-8');

    expect(readCurateState(runtime)).toEqual(persisted);
  });

  it('treats missing community fingerprint fields as undefined when reading legacy state', () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      curateStatePath(runtime),
      JSON.stringify({
        processedThrough: cursor('coral-legacy', 8),
        initialized: true,
      }),
      'utf-8',
    );

    expect(readCurateState(runtime)).toEqual(
      createCurateState({
        processedThrough: cursor('coral-legacy', 8),
        initialized: true,
      }),
    );
  });

  it('writes curate state atomically without leaving a temp file and round-trips through readCurateState', () => {
    const state = createCurateState({
      processedThrough: cursor('coral-atomic', 7),
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

  it('extracts malformed repair entries leniently from raw note and source content', () => {
    const detectedAt = '2026-03-25T12:00:00.000Z';

    expect(
      extractMalformedEntryRepair(
        'note',
        'coral-broken-note',
        [
          '---',
          'tags: [coral',
          'principles: []',
          'source:',
          '  - kangig94/coral',
          'createdAt: 2026-03-20T00:00:00.000Z',
          'updatedAt: 2026-03-20T00:00:00.000Z',
          'entrySeq: 17',
          '---',
          '# Broken Note',
          '',
          'Body.',
        ].join('\n'),
        detectedAt,
      ),
    ).toEqual({
      entryId: noteEntryId('coral-broken-note'),
      entrySeq: 17,
      detectedAt,
    });

    expect(
      extractMalformedEntryRepair(
        'source',
        'coral-broken-source',
        [
          '---',
          'title: Broken Source',
          'type: spec',
          'tags: [reference',
          'importedAt: 2026-03-20T00:00:00.000Z',
          'entrySeq: nope',
          '# Missing closing frontmatter delimiter on purpose',
        ].join('\n'),
        detectedAt,
      ),
    ).toEqual({
      entryId: sourceEntryId('coral-broken-source'),
      entrySeq: null,
      detectedAt,
    });
  });

  it('normalizes repair frontiers without rewinding cursors that still sort before the malformed entry', () => {
    expect(
      normalizeCurateStateRepairFrontier(
        createCurateState({
          processedThrough: cursor('coral-alpha', 5),
          lastAttemptedThrough: cursor('coral-gamma', 5),
          discoveryHighSeq: 9,
          discoveryOffset: 4,
          pendingRepair: [
            {
              entryId: noteEntryId('coral-beta'),
              entrySeq: 5,
              detectedAt: '2026-03-25T12:00:00.000Z',
            },
          ],
        }),
      ),
    ).toEqual(
      createCurateState({
        processedThrough: cursor('coral-alpha', 5),
        lastAttemptedThrough: null,
        discoveryHighSeq: 4,
        discoveryOffset: 0,
        pendingRepair: [
          {
            entryId: noteEntryId('coral-beta'),
            entrySeq: 5,
            detectedAt: '2026-03-25T12:00:00.000Z',
          },
        ],
      }),
    );
  });

  it('sorts cursors by mutation sequence before note name ties', () => {
    const sorted = [cursor('coral-zeta', 1), cursor('coral-beta', 3), cursor('coral-gamma', 3), cursor('coral-alpha', 5)].sort(compareCursor);

    expect(sorted).toEqual([
      cursor('coral-zeta', 1),
      cursor('coral-beta', 3),
      cursor('coral-gamma', 3),
      cursor('coral-alpha', 5),
    ]);
  });

  it('treats no claim and recent claims as fresh, and claims older than fifteen minutes as stale', () => {
    const now = new Date().toISOString();

    expect(isClaimStale(createCurateState(), now)).toBe(false);
    expect(
      isClaimStale(
        createCurateState({
          activeClaim: {
            through: cursor('coral-recent', 2),
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
            through: cursor('coral-stale', 3),
            startedAt: '2026-03-25T11:45:00.000Z',
          },
        }),
        now,
      ),
    ).toBe(true);
  });

  it('applies curate failure state transitions without disk access', () => {
    const state = createCurateState({
      lastAttemptedThrough: cursor('coral-failed', 4),
      activeClaim: {
        through: cursor('coral-failed', 4),
        startedAt: '2026-03-25T11:59:00.000Z',
      },
      consecutiveFailures: 2,
    });

    expect(applyRecordCurateFailure(state, null, new Error('transient failure'))).toEqual({
      ...state,
      lastAttemptedThrough: cursor('coral-failed', 4),
      retryNotBefore: '2026-03-25T14:00:00.000Z',
      activeClaim: null,
      consecutiveFailures: 3,
    });
  });

  it('applies retry-reset and discovery attempt transitions without rereading state', () => {
    const retryState = createCurateState({
      retryNotBefore: '2026-03-25T13:00:00.000Z',
      activeClaim: {
        through: cursor('coral-active', 7),
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
        entrySeq: 11,
      }),
      'utf-8',
    );
    writeFileSync(join(runtime.notesDir(), 'coral-first.md'), renderNote({ title: 'Coral First' }), 'utf-8');

    runtime.writeIndex({
      entries: createIndexEntries({
        'coral-third': createIndexNote('Coral Third', 11),
      }),
      principles: {},
    });
    runtime.writeIndexState({
      contentSeq: 8,
      metadataSeq: 8,
      mutationSeq: 8,
      textIndexedSeq: 8,
      vector: { bySpec: {} },
    });
    writeCurateState(runtime, createCurateState());
    const existingContent = readFileSync(join(runtime.notesDir(), 'coral-third.md'), 'utf-8');

    await internals.migrateCurateStateIfNeeded();

    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-first.md'), 'utf-8')).entrySeq,
    ).toBe(12);
    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-second.md'), 'utf-8')).entrySeq,
    ).toBe(13);
    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-third.md'), 'utf-8')).entrySeq,
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
      contentSeq: 13,
      metadataSeq: 13,
      mutationSeq: 13,
      textIndexedSeq: 13,
      vector: { bySpec: {} },
    });
    expect(readCurateState(runtime).initialized).toBe(true);
  });

  it('treats recoverable malformed entry sequences as the migration assignment floor', async () => {
    mkdirSync(runtime.notesDir(), { recursive: true });

    writeFileSync(
      join(runtime.notesDir(), 'coral-malformed.md'),
      [
        '---',
        'tags: [coral',
        'principles: []',
        'source:',
        '  - kangig94/coral',
        'createdAt: 2026-03-20T00:00:00.000Z',
        'updatedAt: 2026-03-20T00:00:00.000Z',
        'entrySeq: 30',
        '---',
        '# Coral Malformed',
        '',
        'Body.',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(join(runtime.notesDir(), 'coral-needs-seq.md'), renderNote({ title: 'Needs Seq' }), 'utf-8');

    runtime.writeIndex({
      entries: {},
      principles: {},
    });
    runtime.writeIndexState({
      contentSeq: 5,
      metadataSeq: 5,
      mutationSeq: 5,
      textIndexedSeq: 5,
      vector: { bySpec: {} },
    });
    writeCurateState(runtime, createCurateState());

    await internals.migrateCurateStateIfNeeded();

    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-needs-seq.md'), 'utf-8')).entrySeq,
    ).toBe(31);
    expect(readCurateState(runtime).pendingRepair).toEqual([
      {
        entryId: noteEntryId('coral-malformed'),
        entrySeq: 30,
        detectedAt: expect.any(String),
      },
    ]);
    expect(runtime.readIndexState()).toEqual({
      contentSeq: 31,
      metadataSeq: 31,
      mutationSeq: 31,
      textIndexedSeq: 31,
      vector: { bySpec: {} },
    });
  });

  it('records malformed note and source files as pending repair during migration and clamps stale cursors', async () => {
    mkdirSync(runtime.notesDir(), { recursive: true });
    mkdirSync(runtime.sourcesDir(), { recursive: true });

    writeFileSync(
      join(runtime.notesDir(), 'coral-malformed-note.md'),
      [
        '---',
        'tags: [coral',
        'principles: []',
        'source:',
        '  - kangig94/coral',
        'createdAt: 2026-03-20T00:00:00.000Z',
        'updatedAt: 2026-03-20T00:00:00.000Z',
        'entrySeq: 7',
        '---',
        '# Coral Malformed Note',
        '',
        'Body.',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(join(runtime.notesDir(), 'coral-valid.md'), renderNote({ title: 'Coral Valid', entrySeq: 12 }), 'utf-8');
    writeFileSync(
      join(runtime.sourcesDir(), 'coral-malformed-source.md'),
      [
        '---',
        'title: Coral Malformed Source',
        'type: spec',
        'tags: [reference',
        'importedAt: 2026-03-20T00:00:00.000Z',
        'entrySeq: nope',
        '# Missing closing frontmatter delimiter on purpose',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(runtime.sourcesDir(), 'coral-valid-source.md'),
      renderSource({
        title: 'Coral Valid Source',
        entrySeq: 8,
      }),
      'utf-8',
    );

    runtime.writeIndex({
      entries: createIndexEntries({
        'coral-valid': createIndexNote('Coral Valid', 12),
      }),
      principles: {},
    });
    runtime.writeIndexState({
      contentSeq: 6,
      metadataSeq: 6,
      mutationSeq: 6,
      textIndexedSeq: 6,
      vector: { bySpec: {} },
    });
    writeCurateState(
      runtime,
      createCurateState({
        processedThrough: cursor('coral-valid', 12),
        lastAttemptedThrough: cursor('coral-valid', 12),
        discoveryHighSeq: 12,
        discoveryOffset: 3,
      }),
    );

    await internals.migrateCurateStateIfNeeded();

    const state = readCurateState(runtime);
    expect(state).toMatchObject({
      processedThrough: null,
      lastAttemptedThrough: null,
      discoveryHighSeq: 0,
      discoveryOffset: 0,
      initialized: true,
      migrationVersion: CURATE_STATE_MIGRATION_VERSION,
    });
    expect(state.pendingRepair).toHaveLength(2);
    expect(state.pendingRepair).toEqual(
      expect.arrayContaining([
        {
          entryId: noteEntryId('coral-malformed-note'),
          entrySeq: 7,
          detectedAt: expect.any(String),
        },
        {
          entryId: sourceEntryId('coral-malformed-source'),
          entrySeq: null,
          detectedAt: expect.any(String),
        },
      ]),
    );
  });

  it('uses the current mutation sequence as the assignment floor and skips notes that already have mutation sequences', async () => {
    mkdirSync(runtime.notesDir(), { recursive: true });

    writeFileSync(
      join(runtime.notesDir(), 'coral-current-floor.md'),
      renderNote({
        title: 'Current Floor',
        entrySeq: 9,
      }),
      'utf-8',
    );
    writeFileSync(
      join(runtime.notesDir(), 'coral-late-existing.md'),
      renderNote({
        title: 'Late Existing',
        entrySeq: 11,
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
      }),
      principles: {},
    });
    runtime.writeIndexState({
      contentSeq: 20,
      metadataSeq: 20,
      mutationSeq: 20,
      textIndexedSeq: 18,
      vector: { bySpec: {} },
    });
    writeCurateState(runtime, createCurateState());

    await internals.migrateCurateStateIfNeeded();

    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-current-floor.md'), 'utf-8')).entrySeq,
    ).toBe(9);
    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-late-existing.md'), 'utf-8')).entrySeq,
    ).toBe(11);
    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-needs-seq.md'), 'utf-8')).entrySeq,
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
      contentSeq: 21,
      metadataSeq: 21,
      mutationSeq: 21,
      textIndexedSeq: 21,
      vector: { bySpec: {} },
    });
  });

  it('skips migration entirely when the stored migration version is already current', async () => {
    mkdirSync(runtime.notesDir(), { recursive: true });

    writeFileSync(join(runtime.notesDir(), 'coral-skip.md'), renderNote({ title: 'Skip Migration' }), 'utf-8');
    runtime.writeIndex({
      entries: createIndexEntries({
        'coral-skip': createIndexNote('Skip Migration', 4),
      }),
      principles: {},
    });
    runtime.writeIndexState({
      contentSeq: 4,
      metadataSeq: 4,
      mutationSeq: 4,
      textIndexedSeq: 4,
      vector: { bySpec: {} },
    });
    writeCurateState(
      runtime,
      createCurateState({
        initialized: true,
        migrationVersion: CURATE_STATE_MIGRATION_VERSION,
        lastRunDay: '2026-03-25',
      }),
    );

    await internals.migrateCurateStateIfNeeded();

    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-skip.md'), 'utf-8')).entrySeq,
    ).toBeUndefined();
    expect(runtime.readIndex()).toEqual({
      entries: createIndexEntries({
        'coral-skip': createIndexNote('Skip Migration', 4),
      }),
      principles: {},
    });
    expect(runtime.readIndexState()).toEqual({
      contentSeq: 4,
      metadataSeq: 4,
      mutationSeq: 4,
      textIndexedSeq: 4,
      vector: { bySpec: {} },
    });
    expect(readCurateState(runtime)).toEqual(
      createCurateState({
        initialized: true,
        migrationVersion: CURATE_STATE_MIGRATION_VERSION,
        lastRunDay: '2026-03-25',
      }),
    );
  });

  it('ignores legacy markdown-root curate-state files when runtime state is isolated elsewhere', async () => {
    const markdownRoot = join(tempDir, 'markdown-root');
    const runtimeDir = join(tempDir, 'runtime-root');
    const splitRuntime = createKbRuntime({
      markdownRoot,
      runtimeDir,
    });
    const splitScheduler = createCurateScheduler({
      kb: splitRuntime,
      spawnCli: noopSpawnCli,
    });
    const splitInternals = splitScheduler._testInternals!;

    mkdirSync(markdownRoot, { recursive: true });
    writeFileSync(
      join(markdownRoot, CURATE_STATE_FILE),
      JSON.stringify(
        createCurateState({
          processedThrough: cursor('stale-shared-state', 99),
          lastRunDay: '2026-03-25',
          initialized: true,
        }),
      ),
      'utf-8',
    );

    await splitInternals.migrateCurateStateIfNeeded();

    expect(existsSync(join(markdownRoot, CURATE_STATE_FILE))).toBe(true);
    expect(readCurateState(splitRuntime)).toEqual(
      createCurateState({
        initialized: true,
        migrationVersion: CURATE_STATE_MIGRATION_VERSION,
      }),
    );
  });

  it('recovers malformed community fingerprint fields during migration without changing the migration version contract', async () => {
    mkdirSync(runtime.notesDir(), { recursive: true });
    writeFileSync(join(runtime.notesDir(), 'coral-malformed.md'), renderNote({ title: 'Malformed Fields' }), 'utf-8');
    runtime.writeIndex({
      entries: {},
      principles: {},
    });
    runtime.writeIndexState({
      contentSeq: 0,
      metadataSeq: 0,
      mutationSeq: 0,
      textIndexedSeq: 0,
      vector: { bySpec: {} },
    });
    writeFileSync(
      curateStatePath(runtime),
      JSON.stringify({
        initialized: true,
        communityGraphHash: 42,
        communityMembershipFingerprints: {
          'graph-rag': 17,
        },
      }),
      'utf-8',
    );

    await internals.migrateCurateStateIfNeeded();

    expect(readCurateState(runtime)).toEqual(
      createCurateState({
        processedThrough: cursor('coral-malformed', 1),
        initialized: true,
        migrationVersion: CURATE_STATE_MIGRATION_VERSION,
      }),
    );
  });
});
