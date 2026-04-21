import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backendLog } from '../../shared/backend-log.js';
import { createCurateTestHandle, type CurateTestHandle } from '../curate/__tests__/__helpers__/test-handle.js';
import { createCurateScheduler, type CurateHandle } from '../curate/scheduler.js';
import type { KbRuntime } from '../contracts.js';
import {
  assignEntrySeqs,
  applyAddPendingDiscovery,
  applyClearCurateRetryState,
  applyRecordCurateFailure,
  applyRecordDiscoveryAttempt,
  applyRemovePendingDiscovery,
  compareCursor,
  CURATE_STATE_MIGRATION_VERSION,
  detectRepairs,
  extractMalformedEntryRepair,
  isClaimStale,
  normalizeCurateStateRepairFrontier,
  persistState,
  readCurateState,
  reconcileSeqs,
  rewriteFrontmatter,
  scanCorpus,
  syncIndex,
  writeCurateState,
  type CurateState,
  type PendingRepair,
} from '../curate/state.js';
import { readCurateDiscoveryBacklog } from '../curate/discovery-backlog.js';
import { readCurateRetryQueue } from '../curate/retry.js';
import { writeCurateSchedulerState, readCurateSchedulerState } from '../curate/state-scheduler.js';
import { parseFrontmatter } from '../corpus/frontmatter.js';
import { cloneKbIndex } from '../corpus/mutation-helpers.js';
import { createKbRuntime } from '../runtime.js';
import { noteEntryId, sourceEntryId, type KbIndex, type NoteEntry } from '../entry-types.js';
import { createRealRuntime } from '../../runtime/real.js';

const RETIRED_PATH = (root: string) => join(root, '.coral', 'curate-state.retired');

function expectPendingRepairEntries(
  pendingRepair: PendingRepair[] | null,
  expected: ReadonlyArray<{ entryId: string; entrySeq: number | null; detectedAt?: string }>,
): void {
  expect(pendingRepair).not.toBeNull();
  expect(pendingRepair).toHaveLength(expected.length);

  for (const expectedEntry of expected) {
    const repair = pendingRepair?.find((entry) => entry.entryId === expectedEntry.entryId);
    expect(repair).toBeDefined();
    expect(repair).toEqual(
      expect.objectContaining({
        entryId: expectedEntry.entryId,
        entrySeq: expectedEntry.entrySeq,
        ...(expectedEntry.detectedAt === undefined ? {} : { detectedAt: expectedEntry.detectedAt }),
        reason: 'pending-repair',
        retryCount: 0,
      }),
    );
    expect(repair?.retryNotBefore).toBe(repair?.detectedAt);
    expect(repair?.canonicalIncident).toBeUndefined();
    expect(repair?.locus).toBeUndefined();
    expect(repair?.repairHint).toBeUndefined();
    expect(repair?.signalsJson).toBeUndefined();
  }
}

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
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
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
let internals: CurateTestHandle;
let gitSyncRuntime: ReturnType<typeof createRealRuntime>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-state-'));
  runtime = createKbRuntime({
    markdownRoot: tempDir,
    runtimeDir: tempDir,
  });
  gitSyncRuntime = createRealRuntime();
  scheduler = createCurateScheduler({
    kb: runtime,
    spawnCli: noopSpawnCli,
    processPort: gitSyncRuntime.process,
    storagePort: gitSyncRuntime.storage,
    envPort: gitSyncRuntime.env,
  });
  internals = createCurateTestHandle({
    kb: runtime,
    spawnCli: noopSpawnCli,
    schedule: () => scheduler.schedule(),
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
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
      consecutiveClaimFailures: 2,
      consecutiveCommunityBatchFailures: 3,
      initialized: true,
    });

    writeCurateState(runtime, persisted);

    expect(readCurateSchedulerState(runtime)).toEqual({
      processedThrough: cursor('coral-first', 3),
      discoveryHighSeq: 0,
      discoveryOffset: 0,
      lastRunDay: '2026-03-25',
      lastAttemptedThrough: cursor('coral-second', 4),
      retryNotBefore: '2026-03-26T00:00:00.000Z',
      consecutiveClaimFailures: 2,
      consecutiveCommunityBatchFailures: 3,
      communityTopologyHash: 'graph-hash',
      communitySummaryTopologyHash: 'graph-hash',
      initialized: true,
      migrationVersion: 0,
    });
    expect(readCurateDiscoveryBacklog(runtime)).toEqual(persisted.pendingDiscoveries);
    expectPendingRepairEntries(readCurateRetryQueue(runtime), [
      {
        entryId: noteEntryId('coral-repair'),
        entrySeq: 6,
        detectedAt: '2026-03-25T11:57:00.000Z',
      },
    ]);

    const state = readCurateState(runtime);
    const { pendingRepair, ...actualRest } = state;
    const { pendingRepair: _expectedPendingRepair, ...expectedRest } = persisted;
    expect(actualRest).toEqual(expectedRest);
    expectPendingRepairEntries(pendingRepair, [
      {
        entryId: noteEntryId('coral-repair'),
        entrySeq: 6,
        detectedAt: '2026-03-25T11:57:00.000Z',
      },
    ]);
  });

  it('treats missing community fingerprint rows as undefined when reading scheduler state', () => {
    writeCurateSchedulerState(runtime, {
      processedThrough: cursor('coral-legacy', 8),
      discoveryHighSeq: 0,
      discoveryOffset: 0,
      lastRunDay: null,
      lastAttemptedThrough: null,
      retryNotBefore: null,
      consecutiveClaimFailures: 0,
      consecutiveCommunityBatchFailures: 0,
      communityTopologyHash: undefined,
      communitySummaryTopologyHash: undefined,
      initialized: true,
      migrationVersion: 0,
    });

    expect(readCurateState(runtime)).toEqual(
      createCurateState({
        processedThrough: cursor('coral-legacy', 8),
        initialized: true,
      }),
    );
  });

  it('writes curate state atomically without leaving a temp file and round-trips through readCurateState', () => {
    const retiredCurateStatePath = join(runtime.runtimeDir, 'curate-state.retired');
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
    expect(readCurateSchedulerState(runtime)).toEqual({
      processedThrough: cursor('coral-atomic', 7),
      discoveryHighSeq: 0,
      discoveryOffset: 0,
      lastRunDay: null,
      lastAttemptedThrough: null,
      retryNotBefore: null,
      consecutiveClaimFailures: 0,
      consecutiveCommunityBatchFailures: 0,
      communityTopologyHash: undefined,
      communitySummaryTopologyHash: undefined,
      initialized: true,
      migrationVersion: 0,
    });
    expect(readCurateDiscoveryBacklog(runtime)).toEqual(state.pendingDiscoveries);
    expect(readCurateRetryQueue(runtime)).toEqual([]);
    expect(existsSync(retiredCurateStatePath)).toBe(false);
    expect(existsSync(`${retiredCurateStatePath}.tmp`)).toBe(false);
  });

  it('touches at most one row when only discovery progress advances', () => {
    const baseline = createCurateState({
      discoveryHighSeq: 61,
      discoveryOffset: 2,
      activeClaim: {
        through: cursor('coral-active', 9),
        startedAt: '2026-03-25T11:58:00.000Z',
      },
      pendingDiscoveries: [
        {
          principle: 'contract-first-design',
          statement: 'Write the contract before the implementation.',
          notes: ['coral-alpha', 'coral-beta'],
          createdAt: '2026-03-25T12:00:00.000Z',
        },
      ],
      pendingRepair: [
        {
          entryId: noteEntryId('coral-repair'),
          entrySeq: 200,
          detectedAt: '2026-03-25T11:57:00.000Z',
        },
      ],
      communitySummaryInputFingerprints: {
        'contract-first-design': 'summary-input-hash',
        'graph-rag': 'members-hash',
      },
      initialized: true,
    });

    writeCurateState(runtime, baseline);

    const beforeChanges = (runtime.db.prepare(`SELECT total_changes() AS count`).get() as { count: number }).count;
    writeCurateState(runtime, {
      ...baseline,
      discoveryHighSeq: 62,
      discoveryOffset: 3,
    });
    const afterChanges = (runtime.db.prepare(`SELECT total_changes() AS count`).get() as { count: number }).count;
    const rowTouches = afterChanges - beforeChanges;

    expect(rowTouches).toBeLessThanOrEqual(1);
    expect(readCurateState(runtime)).toMatchObject({
      discoveryHighSeq: 62,
      discoveryOffset: 3,
      activeClaim: baseline.activeClaim,
      pendingDiscoveries: baseline.pendingDiscoveries,
      communitySummaryInputFingerprints: baseline.communitySummaryInputFingerprints,
      initialized: true,
    });
    expectPendingRepairEntries(readCurateState(runtime).pendingRepair, [
      {
        entryId: noteEntryId('coral-repair'),
        entrySeq: 200,
        detectedAt: '2026-03-25T11:57:00.000Z',
      },
    ]);
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
      consecutiveClaimFailures: 2,
      consecutiveCommunityBatchFailures: 5,
    });

    expect(applyRecordCurateFailure(state, null, new Error('transient failure'))).toEqual({
      ...state,
      lastAttemptedThrough: cursor('coral-failed', 4),
      retryNotBefore: '2026-03-25T14:00:00.000Z',
      activeClaim: null,
      consecutiveClaimFailures: 3,
    });
  });

  it('applies retry-reset and discovery attempt transitions without rereading state', () => {
    const retryState = createCurateState({
      retryNotBefore: '2026-03-25T13:00:00.000Z',
      activeClaim: {
        through: cursor('coral-active', 7),
        startedAt: '2026-03-25T11:58:00.000Z',
      },
      consecutiveClaimFailures: 4,
      consecutiveCommunityBatchFailures: 6,
    });

    expect(applyClearCurateRetryState(createCurateState())).toBeNull();
    expect(applyClearCurateRetryState(retryState)).toEqual({
      ...retryState,
      retryNotBefore: null,
      activeClaim: null,
      consecutiveClaimFailures: 0,
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

  describe('migration phases', () => {
    it('scanCorpus returns sorted successes and scan failures', () => {
      mkdirSync(runtime.notesDir(), { recursive: true });
      mkdirSync(runtime.sourcesDir(), { recursive: true });

      writeFileSync(join(runtime.notesDir(), 'coral-zeta.md'), renderNote({ title: 'Coral Zeta', entrySeq: 4 }), 'utf-8');
      writeFileSync(
        join(runtime.notesDir(), 'coral-broken.md'),
        [
          '---',
          'tags: [coral',
          'principles: []',
          'source:',
          '  - kangig94/coral',
          'createdAt: 2026-03-20T00:00:00.000Z',
          'updatedAt: 2026-03-20T00:00:00.000Z',
          'entrySeq: 12',
          '---',
          '# Coral Broken',
          '',
          'Body.',
        ].join('\n'),
        'utf-8',
      );
      writeFileSync(join(runtime.notesDir(), 'coral-alpha.md'), renderNote({ title: 'Coral Alpha', entrySeq: 2 }), 'utf-8');
      writeFileSync(
        join(runtime.sourcesDir(), 'bravo-source.md'),
        renderSource({ title: 'Bravo Source', entrySeq: 6 }),
        'utf-8',
      );
      writeFileSync(
        join(runtime.sourcesDir(), 'alpha-source.md'),
        [
          '---',
          'title: Alpha Source',
          'type: spec',
          'tags: [reference',
          'importedAt: 2026-03-20T00:00:00.000Z',
          'entrySeq: nope',
          '# Missing closing frontmatter delimiter on purpose',
        ].join('\n'),
        'utf-8',
      );

      const scan = scanCorpus(runtime, '2026-03-25T12:00:00.000Z');

      expect(scan.detectedAt).toBe('2026-03-25T12:00:00.000Z');
      expect(scan.scannedNotes.map((entry) => entry.note)).toEqual(['coral-alpha', 'coral-zeta']);
      expect(scan.scannedSources.map((entry) => entry.slug)).toEqual(['bravo-source']);
      expect(
        scan.scanFailures.map(({ kind, name, path }) => ({
          kind,
          name,
          path,
        })),
      ).toEqual([
        {
          kind: 'note',
          name: 'coral-broken',
          path: join(runtime.notesDir(), 'coral-broken.md'),
        },
        {
          kind: 'source',
          name: 'alpha-source',
          path: join(runtime.sourcesDir(), 'alpha-source.md'),
        },
      ]);
    });

    it('detectRepairs converts scan failures into pending repairs and warnings', () => {
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

      const detectedAt = '2026-03-25T12:00:00.000Z';
      const scan = scanCorpus(runtime, detectedAt);
      const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
      const pendingRepair = detectRepairs(scan.scanFailures, detectedAt);

      expect(pendingRepair).toEqual([
        {
          entryId: noteEntryId('coral-malformed-note'),
          entrySeq: 7,
          detectedAt,
        },
        {
          entryId: sourceEntryId('coral-malformed-source'),
          entrySeq: null,
          detectedAt,
        },
      ]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        'Skipping malformed KB note coral-malformed-note during state migration',
      );
      expect(String(warn.mock.calls[1]?.[0])).toContain(
        'Skipping malformed KB source coral-malformed-source during state migration',
      );
    });

    it('assignEntrySeqs uses the highest existing sequence from state, entries, and repairs', () => {
      mkdirSync(runtime.notesDir(), { recursive: true });
      mkdirSync(runtime.sourcesDir(), { recursive: true });

      writeFileSync(join(runtime.notesDir(), 'coral-existing.md'), renderNote({ title: 'Existing', entrySeq: 8 }), 'utf-8');
      writeFileSync(join(runtime.notesDir(), 'coral-needs-seq.md'), renderNote({ title: 'Needs Seq' }), 'utf-8');
      writeFileSync(join(runtime.sourcesDir(), 'source-needs-seq.md'), renderSource({ title: 'Source Needs Seq' }), 'utf-8');
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

      runtime.writeIndexState({
        contentSeq: 5,
        metadataSeq: 5,
        mutationSeq: 5,
        textIndexedSeq: 5,
      });

      const scan = scanCorpus(runtime, '2026-03-25T12:00:00.000Z');
      vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
      const pendingRepair = detectRepairs(scan.scanFailures, scan.detectedAt);
      const assignment = assignEntrySeqs(runtime.readIndexState(), scan.scannedNotes, scan.scannedSources, pendingRepair);

      expect(scan.scannedNotes.find((entry) => entry.note === 'coral-existing')?.frontmatter.entrySeq).toBe(8);
      expect(scan.scannedNotes.find((entry) => entry.note === 'coral-needs-seq')?.frontmatter.entrySeq).toBe(31);
      expect(scan.scannedSources.find((entry) => entry.slug === 'source-needs-seq')?.frontmatter.entrySeq).toBe(32);
      expect(assignment.rewrittenNotes.map((entry) => entry.note)).toEqual(['coral-needs-seq']);
      expect(assignment.rewrittenSources.map((entry) => entry.slug)).toEqual(['source-needs-seq']);
      expect(assignment.highestAssignedEntrySeq).toBe(32);
    });

    it('rewriteFrontmatter persists only entries that received new sequences', () => {
      mkdirSync(runtime.notesDir(), { recursive: true });
      mkdirSync(runtime.sourcesDir(), { recursive: true });

      const keepPath = join(runtime.notesDir(), 'coral-keep.md');
      const needsSeqPath = join(runtime.notesDir(), 'coral-needs-seq.md');
      const sourcePath = join(runtime.sourcesDir(), 'source-needs-seq.md');

      writeFileSync(keepPath, renderNote({ title: 'Keep', entrySeq: 9 }), 'utf-8');
      writeFileSync(needsSeqPath, renderNote({ title: 'Needs Seq' }), 'utf-8');
      writeFileSync(sourcePath, renderSource({ title: 'Source Needs Seq' }), 'utf-8');

      runtime.writeIndexState({
        contentSeq: 9,
        metadataSeq: 9,
        mutationSeq: 9,
        textIndexedSeq: 9,
      });

      const scan = scanCorpus(runtime, '2026-03-25T12:00:00.000Z');
      const assignment = assignEntrySeqs(runtime.readIndexState(), scan.scannedNotes, scan.scannedSources, []);
      const keepContent = readFileSync(keepPath, 'utf-8');

      expect(parseFrontmatter(readFileSync(needsSeqPath, 'utf-8')).entrySeq).toBeUndefined();
      expect(readFileSync(sourcePath, 'utf-8')).not.toContain('entrySeq:');

      rewriteFrontmatter(assignment.rewrittenNotes, assignment.rewrittenSources);

      expect(parseFrontmatter(readFileSync(needsSeqPath, 'utf-8')).entrySeq).toBe(10);
      expect(readFileSync(sourcePath, 'utf-8')).toContain('entrySeq: 11');
      expect(readFileSync(keepPath, 'utf-8')).toBe(keepContent);
    });

    it('syncIndex writes changed entries and skips no-op writes', () => {
      mkdirSync(runtime.notesDir(), { recursive: true });
      mkdirSync(runtime.sourcesDir(), { recursive: true });

      writeFileSync(join(runtime.notesDir(), 'coral-note.md'), renderNote({ title: 'Coral Note', entrySeq: 7 }), 'utf-8');
      writeFileSync(
        join(runtime.sourcesDir(), 'sqlite-source.md'),
        renderSource({
          title: 'SQLite Source',
          entrySeq: 8,
        }),
        'utf-8',
      );

      runtime.writeIndex({
        entries: {},
        principles: {},
      });

      const scan = scanCorpus(runtime, '2026-03-25T12:00:00.000Z');
      const writeIndexSpy = vi.spyOn(runtime, 'writeIndex');

      syncIndex(runtime, cloneKbIndex(runtime.readIndex()), scan.scannedNotes, scan.scannedSources);

      expect(writeIndexSpy).toHaveBeenCalledTimes(1);
      expect(runtime.readIndex()?.entries[noteEntryId('coral-note')]).toMatchObject({
        kind: 'note',
        slug: 'coral-note',
        title: 'Coral Note',
        entrySeq: 7,
      });
      expect(runtime.readIndex()?.entries[sourceEntryId('sqlite-source')]).toMatchObject({
        kind: 'source',
        slug: 'sqlite-source',
        title: 'SQLite Source',
        entrySeq: 8,
        type: 'spec',
      });

      writeIndexSpy.mockClear();
      syncIndex(runtime, cloneKbIndex(runtime.readIndex()), scan.scannedNotes, scan.scannedSources);
      expect(writeIndexSpy).not.toHaveBeenCalled();
    });

    it('reconcileSeqs advances the index state only when assignments exceed the mutation sequence', () => {
      runtime.writeIndexState({
        contentSeq: 10,
        metadataSeq: 10,
        mutationSeq: 10,
        textIndexedSeq: 8,
      });

      const writeIndexStateSpy = vi.spyOn(runtime, 'writeIndexState');

      reconcileSeqs(runtime, runtime.readIndexState(), 12);

      expect(writeIndexStateSpy).toHaveBeenCalledTimes(1);
      expect(runtime.readIndexState()).toEqual({
        contentSeq: 12,
        metadataSeq: 12,
        mutationSeq: 12,
        textIndexedSeq: 12,
      });

      writeIndexStateSpy.mockClear();
      reconcileSeqs(runtime, runtime.readIndexState(), 12);
      expect(writeIndexStateSpy).not.toHaveBeenCalled();
    });

    it('persistState stores inferred progress and pending repairs', () => {
      mkdirSync(runtime.notesDir(), { recursive: true });

      writeFileSync(
        join(runtime.notesDir(), 'coral-processed.md'),
        renderNote({ title: 'Processed', entrySeq: 4 }),
        'utf-8',
      );
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
          'entrySeq: 7',
          '---',
          '# Coral Malformed',
          '',
          'Body.',
        ].join('\n'),
        'utf-8',
      );

      const detectedAt = '2026-03-25T12:00:00.000Z';
      const scan = scanCorpus(runtime, detectedAt);
      vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
      const pendingRepair = detectRepairs(scan.scanFailures, detectedAt);

      persistState(
        runtime,
        createCurateState({
          discoveryOffset: 3,
        }),
        scan.scannedNotes,
        scan.scannedSources,
        pendingRepair,
      );

      const state = readCurateState(runtime);
      expect(state).toMatchObject({
        processedThrough: cursor('coral-processed', 4),
        discoveryOffset: 3,
        initialized: true,
        migrationVersion: CURATE_STATE_MIGRATION_VERSION,
      });
      expectPendingRepairEntries(state.pendingRepair, [
        {
          entryId: noteEntryId('coral-malformed'),
          entrySeq: 7,
          detectedAt,
        },
      ]);
    });
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
    });
    writeCurateState(runtime, createCurateState());

    await internals.migrateCurateStateIfNeeded();

    expect(
      parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-needs-seq.md'), 'utf-8')).entrySeq,
    ).toBe(31);
    expectPendingRepairEntries(readCurateState(runtime).pendingRepair, [
      {
        entryId: noteEntryId('coral-malformed'),
        entrySeq: 30,
      },
    ]);
    expect(runtime.readIndexState()).toEqual({
      contentSeq: 31,
      metadataSeq: 31,
      mutationSeq: 31,
      textIndexedSeq: 31,
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
    expectPendingRepairEntries(state.pendingRepair, [
      {
        entryId: noteEntryId('coral-malformed-note'),
        entrySeq: 7,
      },
      {
        entryId: sourceEntryId('coral-malformed-source'),
        entrySeq: null,
      },
    ]);
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
    });
    expect(readCurateState(runtime)).toEqual(
      createCurateState({
        initialized: true,
        migrationVersion: CURATE_STATE_MIGRATION_VERSION,
        lastRunDay: '2026-03-25',
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
    });
    mkdirSync(join(tempDir, '.coral'), { recursive: true });
    writeFileSync(
      RETIRED_PATH(tempDir),
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
