import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCurateTestHandle, type CurateTestHandle } from '#tests/unit/kb/curate/__helpers__/test-handle.js';
import type { KbRuntime } from '#src/kb/contract.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import {
  cursorTimestampFromStorageSeq,
  noteCursor,
  readCurateState,
  writeCurateState,
  type CurateState,
} from '#src/kb/curate/state/index.js';
import { readCurateRetryQueue } from '#src/kb/curate/retry.js';
import { parseFrontmatter } from '#src/kb/corpus/frontmatter.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { noteEntryId, sourceEntryId, type KbIndex, type NoteEntry } from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { curateDb } from '../../../src/kb/curate/db-access.js';

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
    communitySummaryTopologyHash: undefined,
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
    claimLaneDisabledAt: null,
    communityBatchLaneDisabledAt: null,
    initialized: false,
    ...overrides,
  };
}

function cursor(note: string, entrySeq: number) {
  return noteCursor(note, cursorTimestampFromStorageSeq(entrySeq));
}

function renderNote({
  title,
  tags = ['coral'],
  principles = [],
  source = ['kangig94/coral'],
  createdAt = '2026-03-20T00:00:00.000Z',
  updatedAt = '2026-03-20T00:00:00.000Z',
  inputFingerprint,
  entrySeq,
  body = 'Body.',
}: {
  title: string;
  tags?: string[];
  principles?: string[];
  source?: string[];
  createdAt?: string;
  updatedAt?: string;
  inputFingerprint?: string;
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
    ...(inputFingerprint === undefined ? [] : [`inputFingerprint: ${inputFingerprint}`]),
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
  inputFingerprint,
  entrySeq,
  body = 'Body.',
}: {
  title: string;
  type?: string;
  tags?: string[];
  importedAt?: string;
  inputFingerprint?: string;
  entrySeq?: number;
  body?: string;
}): string {
  const lines = [
    '---',
    `title: ${title}`,
    `type: ${type}`,
    `tags: [${tags.join(', ')}]`,
    `importedAt: ${importedAt}`,
    ...(inputFingerprint === undefined ? [] : [`inputFingerprint: ${inputFingerprint}`]),
    ...(entrySeq === undefined ? [] : [`entrySeq: ${entrySeq}`]),
    '---',
    `# ${title}`,
    '',
    body,
  ];
  return `${lines.join('\n')}\n`;
}

function createIndexNote(title: string, entrySeq?: number, body = 'Body.'): Omit<NoteEntry, 'kind' | 'slug'> {
  return {
    title,
    tags: ['coral'],
    principles: [],
    source: ['kangig94/coral'],
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    related: [],
    bodyHash: computeBodySurfaceHash(body),
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

const noopCurateAssistant: CurateAssistantPort = {
  complete: async () => '[]',
};

let tempDir: string;
let runtime: KbRuntime;
let internals: CurateTestHandle;
let gitSyncRuntime: ReturnType<typeof createRealRuntime>;
let originalClaudeConfigDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-state-'));
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude-config');
  gitSyncRuntime = createRealRuntime('prod');
  ({ kb: runtime } = createKbTestRuntime({
    markdownRoot: tempDir,
    runtimeDir: tempDir,
    db: openKbTestStoreDb(':memory:'),
    runtime: gitSyncRuntime,
    curateAssistant: noopCurateAssistant,
  }));
  internals = createCurateTestHandle({
    kb: runtime,
    curateAssistant: noopCurateAssistant,
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('curate state', () => {
  it('treats recoverable malformed entry sequences as the bootstrap assignment floor', async () => {
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
      entityMeta: {},
      relationships: [],
    });
    runtime.writeIndexState({
      contentSeq: 5,
      metadataSeq: 5,
    });
    writeCurateState(curateDb(runtime), createCurateState());

    await internals.initializeCurateStateIfNeeded();

    expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-needs-seq.md'), 'utf-8')).entrySeq).toBe(31);
    // Typed pipeline detects malformed YAML as frontmatter-shape and enqueues with the lenient
    // entrySeq (30) so assignEntrySeqs uses it as the floor when allocating new sequences.
    const queued = readCurateRetryQueue(curateDb(runtime));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      entryId: noteEntryId('coral-malformed'),
      entrySeq: 30,
      locus: 'frontmatter-shape',
    });
    expect(runtime.readIndexState()).toEqual({
      contentSeq: 31,
      metadataSeq: 31,
    });
  });

  it('records malformed note and source files as pending repair during bootstrap and clamps stale cursors', async () => {
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
      join(runtime.notesDir(), 'coral-valid.md'),
      renderNote({ title: 'Coral Valid', entrySeq: 12 }),
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
      entityMeta: {},
      relationships: [],
    });
    runtime.writeIndexState({
      contentSeq: 6,
      metadataSeq: 6,
    });
    writeCurateState(
      curateDb(runtime),
      createCurateState({
        processedThrough: cursor('coral-valid', 12),
        lastAttemptedThrough: cursor('coral-valid', 12),
        discoveryHighSeq: 12,
        discoveryOffset: 3,
      }),
    );

    await internals.initializeCurateStateIfNeeded();

    const state = readCurateState(curateDb(runtime));
    expect(state).toMatchObject({
      processedThrough: null,
      lastAttemptedThrough: null,
      discoveryHighSeq: 0,
      discoveryOffset: 0,
      initialized: true,
    });
    // Typed pipeline detects malformed YAML as frontmatter-shape/yaml-parse-error and enqueues
    // typed rows on kb_curate_retry_queue.
    const queued = readCurateRetryQueue(curateDb(runtime));
    expect(queued.map((entry) => entry.entryId).sort()).toEqual(
      [noteEntryId('coral-malformed-note'), sourceEntryId('coral-malformed-source')].sort(),
    );
    const noteRepair = queued.find((entry) => entry.entryId === noteEntryId('coral-malformed-note'));
    const sourceRepair = queued.find((entry) => entry.entryId === sourceEntryId('coral-malformed-source'));
    expect(noteRepair).toMatchObject({
      entrySeq: 7,
      locus: 'frontmatter-shape',
    });
    expect(sourceRepair).toMatchObject({
      entrySeq: null,
      locus: 'frontmatter-shape',
    });
  });
});
