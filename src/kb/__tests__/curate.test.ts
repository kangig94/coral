import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as curateState from '../curate-state.js';
import {
  buildClassificationPrompt,
  buildDiscoveryPrompt,
  buildMetadataTargets,
  chunkEntriesByPromptBudget,
  createCurateScheduler,
  parseClassificationResponse,
  parseDiscoveryResponse,
  validateAssignments,
  validateDiscoveryProposals,
  type ClassificationAssignment,
  type CurateClaimedEntry,
  type CurateHandle,
  type DiscoveryProposal,
  type SpawnCliFn,
} from '../curate.js';
import { readCurateState, writeCurateState, type CurateState } from '../curate-state.js';
import { parseFrontmatter } from '../frontmatter.js';
import { createKbRuntime, type KbRuntime } from '../runtime.js';
import { noteEntryId, type KbIndex, type NoteEntry } from '../types.js';

const DEFAULT_CREATED_AT = '2026-03-20T00:00:00.000Z';
const DEFAULT_UPDATED_AT = '2026-03-20T00:00:00.000Z';

type NoteCurateClaimedEntry = Extract<CurateClaimedEntry, { kind: 'note' }>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
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
  createdAt = DEFAULT_CREATED_AT,
  updatedAt = DEFAULT_UPDATED_AT,
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

function createIndexNote({
  title,
  tags = ['coral'],
  principles = [],
  source = ['kangig94/coral'],
  createdAt = DEFAULT_CREATED_AT,
  updatedAt = DEFAULT_UPDATED_AT,
  entrySeq,
}: {
  title: string;
  tags?: string[];
  principles?: string[];
  source?: string[];
  createdAt?: string;
  updatedAt?: string;
  entrySeq?: number;
}): Omit<NoteEntry, 'kind' | 'slug'> {
  return {
    title,
    tags,
    principles,
    source,
    createdAt,
    updatedAt,
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

function buildClaimedNote({
  slug,
  title,
  body = 'Body.',
  updatedAt = DEFAULT_UPDATED_AT,
  entrySeq,
}: {
  slug: string;
  title: string;
  body?: string;
  updatedAt?: string;
  entrySeq: number;
}): NoteCurateClaimedEntry {
  return {
    kind: 'note',
    entryId: noteEntryId(slug),
    slug,
    title,
    body,
    updatedAt,
    entrySeq,
  };
}

const noopSpawnCli: SpawnCliFn = async () => ({
  stdout: '[]',
  stderr: '',
  code: 0,
  aborted: false,
});

let tempDir: string;
let runtime: KbRuntime;
let scheduler: CurateHandle;
let internals: NonNullable<CurateHandle['_testInternals']>;

function useScheduler(spawnCli: SpawnCliFn = noopSpawnCli): void {
  scheduler = createCurateScheduler({
    kb: runtime,
    spawnCli,
    scheduleDebounceMs: 0,
  });
  internals = scheduler._testInternals!;
}

function writeNote(
  slug: string,
  options: {
    title: string;
    tags?: string[];
    principles?: string[];
    source?: string[];
    createdAt?: string;
    updatedAt?: string;
    entrySeq?: number;
    body?: string;
  },
): string {
  mkdirSync(runtime.notesDir(), { recursive: true });
  const notePath = join(runtime.notesDir(), `${slug}.md`);
  writeFileSync(notePath, renderNote(options), 'utf-8');
  return notePath;
}

async function settleCurateRuntime(handle: CurateHandle): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();
    if (!handle.isRunning()) {
      return;
    }
  }

  throw new Error('Curate runtime did not settle.');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-'));
  runtime = createKbRuntime({
    markdownRoot: tempDir,
    runtimeDir: tempDir,
  });
  useScheduler();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('curate', () => {
  describe('prompt building and response parsing', () => {
    it('builds a classification prompt with every note, tag, and principle', () => {
      const prompt = buildClassificationPrompt(
        [
          buildClaimedNote({
            slug: 'coral-alpha',
            title: 'Alpha',
            body: 'Alpha body.',
            entrySeq: 1,
          }),
          buildClaimedNote({
            slug: 'coral-beta',
            title: 'Beta',
            body: 'Beta body.',
            entrySeq: 2,
          }),
        ],
        ['coral', 'kb', 'ui-pattern'],
        ['contract-first-design', 'deterministic-ordering'],
      );

      expect(prompt).toContain('Tag vocabulary:\n\n- coral\n- kb\n- ui-pattern');
      expect(prompt).toContain('Principle names:\n\n- contract-first-design\n- deterministic-ordering');
      expect(prompt).toContain('## note:coral-alpha\nAlpha\nAlpha body.');
      expect(prompt).toContain('## note:coral-beta\nBeta\nBeta body.');
      expect(prompt).toContain('Return a JSON array: [{ "entry": "note:<slug>"');
    });

    it('parses classification responses from raw and code-fenced JSON arrays', () => {
      const entryMap = new Map<string, true>([
        [noteEntryId('coral-alpha'), true],
        [noteEntryId('coral-beta'), true],
      ]);
      const raw = JSON.stringify([
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['coral', 'kb'],
          principles: ['deterministic-ordering'],
        },
        {
          entry: noteEntryId('coral-beta'),
          tags: ['coral'],
          principles: [],
        },
      ]);

      expect(parseClassificationResponse(raw, entryMap)).toEqual([
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['coral', 'kb'],
          principles: ['deterministic-ordering'],
        },
        {
          entry: noteEntryId('coral-beta'),
          tags: ['coral'],
          principles: [],
        },
      ]);
      expect(parseClassificationResponse(`\`\`\`json\n${raw}\n\`\`\``, entryMap)).toEqual([
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['coral', 'kb'],
          principles: ['deterministic-ordering'],
        },
        {
          entry: noteEntryId('coral-beta'),
          tags: ['coral'],
          principles: [],
        },
      ]);
    });

    it('returns an empty classification list for non-array JSON, malformed JSON, and malformed entries', () => {
      const entryMap = new Map<string, true>([[noteEntryId('coral-alpha'), true]]);

      expect(parseClassificationResponse('{"entry":"note:coral-alpha"}', entryMap)).toEqual([]);
      expect(parseClassificationResponse('[', entryMap)).toEqual([]);
      expect(
        parseClassificationResponse(
          JSON.stringify([
            { entry: noteEntryId('coral-alpha'), tags: ['coral'] },
            { entry: noteEntryId('coral-missing'), tags: ['coral'], principles: [] },
            { entry: noteEntryId('coral-alpha'), tags: ['coral'], principles: [] },
          ]),
          entryMap,
        ),
      ).toEqual([
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['coral'],
          principles: [],
        },
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['coral'],
          principles: [],
        },
      ]);
    });

    it('validates assignments by dropping unknown notes and principles while requiring new-tag support', () => {
      const index: KbIndex = {
        entries: createIndexEntries({
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            tags: ['coral', 'existing-tag'],
            entrySeq: 1,
          }),
          'coral-beta': createIndexNote({
            title: 'Beta',
            entrySeq: 2,
          }),
          'coral-gamma': createIndexNote({
            title: 'Gamma',
            entrySeq: 3,
          }),
        }),
        principles: {
          'deterministic-ordering': 'Sort once before assigning metadata.',
        },
      };
      const claimedNotes = [
        buildClaimedNote({ slug: 'coral-alpha', title: 'Alpha', entrySeq: 1 }),
        buildClaimedNote({ slug: 'coral-beta', title: 'Beta', entrySeq: 2 }),
        buildClaimedNote({ slug: 'coral-gamma', title: 'Gamma', entrySeq: 3 }),
      ];
      const proposals: ClassificationAssignment[] = [
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['existing-tag', 'new-supported', 'new-single'],
          principles: ['deterministic-ordering', 'unknown-principle'],
        },
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['new-supported', 'existing-tag'],
          principles: ['deterministic-ordering'],
        },
        {
          entry: noteEntryId('coral-beta'),
          tags: ['new-supported', 'new-unsupported'],
          principles: [],
        },
        {
          entry: noteEntryId('coral-gamma'),
          tags: ['new-supported'],
          principles: ['unknown-principle'],
        },
        {
          entry: noteEntryId('coral-outside'),
          tags: ['new-supported'],
          principles: ['deterministic-ordering'],
        },
      ];

      expect(validateAssignments(proposals, index, claimedNotes)).toEqual([
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['coral', 'existing-tag', 'new-supported'],
          principles: ['deterministic-ordering'],
        },
        {
          entry: noteEntryId('coral-beta'),
          tags: ['coral', 'new-supported'],
          principles: [],
        },
        {
          entry: noteEntryId('coral-gamma'),
          tags: ['coral', 'new-supported'],
          principles: [],
        },
      ]);
    });

    it('builds a discovery prompt with corpus file, truncated note bodies, and merge/refine instructions', () => {
      const longBody = 'x'.repeat(5000);
      const { prompt, corpusPath } = buildDiscoveryPrompt(
        [
          buildClaimedNote({
            slug: 'coral-alpha',
            title: 'Alpha',
            body: longBody,
            entrySeq: 1,
          }),
        ],
        {
          'deterministic-ordering':
            'Operations with dependency order must use explicit declaration order or sequencing.',
        },
      );

      expect(prompt).toContain('- deterministic-ordering: Operations with dependency order');
      expect(prompt).toContain(corpusPath);
      expect(prompt).toContain('"absorbs": ["<existing-slug>", ...]');
      expect(prompt).toContain(
        "To improve an existing principle's wording, return it with its existing slug and the better statement.",
      );
      expect(prompt).toContain(
        'To merge similar principles, return the surviving slug with absorbs listing the slugs to fold in. Omit absorbs when creating new principles.',
      );
      const corpus = readFileSync(corpusPath, 'utf-8');
      expect(corpus).toContain('## coral-alpha\nAlpha\n');
      expect(corpus).toContain('x'.repeat(4000));
      expect(corpus).not.toContain('x'.repeat(4001));
      unlinkSync(corpusPath);
    });

    it('parses discovery responses from raw and code-fenced JSON arrays and drops malformed entries', () => {
      const raw = JSON.stringify([
        {
          slug: 'stable-ownership',
          statement: 'Attach payloads to one owner.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['single-owner'],
        },
        {
          slug: 'missing-notes',
          statement: 'This one is malformed.',
        },
        {
          slug: 'malformed-absorbs',
          statement: 'This one is malformed too.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: 'single-owner',
        },
      ]);

      expect(parseDiscoveryResponse(raw)).toEqual([
        {
          slug: 'stable-ownership',
          statement: 'Attach payloads to one owner.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['single-owner'],
        },
      ]);
      expect(parseDiscoveryResponse(`\`\`\`json\n${raw}\n\`\`\``)).toEqual([
        {
          slug: 'stable-ownership',
          statement: 'Attach payloads to one owner.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['single-owner'],
        },
      ]);
      expect(parseDiscoveryResponse('{"slug":"not-an-array"}')).toEqual([]);
      expect(parseDiscoveryResponse('[')).toEqual([]);
    });

    it('validates discovery proposals for slug uniqueness, eligibility, minimum note support, and true duplicates', () => {
      const eligibleNotes = [
        buildClaimedNote({ slug: 'coral-alpha', title: 'Alpha', entrySeq: 1 }),
        buildClaimedNote({ slug: 'coral-beta', title: 'Beta', entrySeq: 2 }),
        buildClaimedNote({ slug: 'coral-gamma', title: 'Gamma', entrySeq: 3 }),
        buildClaimedNote({ slug: 'coral-delta', title: 'Delta', entrySeq: 4 }),
      ];
      const proposals: DiscoveryProposal[] = [
        {
          slug: 'shared-context',
          statement: '  Preserve one context owner.  ',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma', 'coral-alpha', 'outside-note'],
        },
        {
          slug: 'shared-context',
          statement: 'Duplicate slugs are not allowed.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'existing-principle',
          statement: 'Already exists.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'refine-principle',
          statement: 'Refined wording.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'not valid',
          statement: 'Invalid slug.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'too-small',
          statement: 'Too few eligible notes survive filtering.',
          notes: ['coral-alpha', 'outside-note', 'coral-beta'],
        },
        {
          slug: 'empty-statement',
          statement: '   ',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
      ];

      expect(
        validateDiscoveryProposals(proposals, eligibleNotes, {
          'existing-principle': 'Already exists.',
          'refine-principle': 'Original wording.',
        }),
      ).toEqual([
        {
          slug: 'shared-context',
          statement: 'Preserve one context owner.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'refine-principle',
          statement: 'Refined wording.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
      ]);
    });

    it('validates absorbs, merge caps, refine caps, and slug collisions across discovery proposals', () => {
      const eligibleNotes = [
        buildClaimedNote({ slug: 'coral-alpha', title: 'Alpha', entrySeq: 1 }),
        buildClaimedNote({ slug: 'coral-beta', title: 'Beta', entrySeq: 2 }),
        buildClaimedNote({ slug: 'coral-gamma', title: 'Gamma', entrySeq: 3 }),
        buildClaimedNote({ slug: 'coral-delta', title: 'Delta', entrySeq: 4 }),
      ];
      const proposals: DiscoveryProposal[] = [
        {
          slug: 'merge-survivor',
          statement: 'Consolidate one rule for the same pattern.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['absorbed-a', 'absorbed-b'],
        },
        {
          slug: 'absorbed-a',
          statement: 'Do not recreate absorbed principles.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'duplicate-absorb',
          statement: 'Do not absorb the same principle twice.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['absorbed-b'],
        },
        {
          slug: 'unknown-merge',
          statement: 'Unknown absorbs are invalid.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['missing-principle'],
        },
        {
          slug: 'self-merge',
          statement: 'A principle cannot absorb itself.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['self-merge'],
        },
        {
          slug: 'second-merge',
          statement: 'A second merge is still allowed.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['absorbed-c'],
        },
        {
          slug: 'third-merge',
          statement: 'A third merge should be rejected.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['absorbed-d'],
        },
        {
          slug: 'refine-one',
          statement: 'Refine one.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'refine-two',
          statement: 'Refine two.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'refine-three',
          statement: 'Refine three.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'refine-four',
          statement: 'Refine four.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
      ];

      expect(
        validateDiscoveryProposals(proposals, eligibleNotes, {
          'absorbed-a': 'Absorbed A.',
          'absorbed-b': 'Absorbed B.',
          'absorbed-c': 'Absorbed C.',
          'absorbed-d': 'Absorbed D.',
          'refine-one': 'Original refine one.',
          'refine-two': 'Original refine two.',
          'refine-three': 'Original refine three.',
          'refine-four': 'Original refine four.',
        }),
      ).toEqual([
        {
          slug: 'merge-survivor',
          statement: 'Consolidate one rule for the same pattern.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['absorbed-a', 'absorbed-b'],
        },
        {
          slug: 'second-merge',
          statement: 'A second merge is still allowed.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
          absorbs: ['absorbed-c'],
        },
        {
          slug: 'refine-one',
          statement: 'Refine one.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'refine-two',
          statement: 'Refine two.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'refine-three',
          statement: 'Refine three.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
      ]);
    });
  });

  describe('claim logic and batching', () => {
    it('returns null when there are no pending notes beyond processedThrough', async () => {
      writeNote('coral-alpha', {
        title: 'Alpha',
        entrySeq: 1,
      });
      writeNote('coral-beta', {
        title: 'Beta',
        entrySeq: 2,
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            entrySeq: 1,
          }),
          'coral-beta': createIndexNote({
            title: 'Beta',
            entrySeq: 2,
          }),
        }),
        principles: {},
      });
      writeCurateState(
        runtime,
        createCurateState({
          processedThrough: cursor('coral-beta', 2),
        }),
      );

      await expect(internals.claimCurateRun('2026-03-25')).resolves.toBeNull();
    });

    it('returns null when pending notes stay below the first-pass threshold', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};

      for (let index = 1; index <= 9; index += 1) {
        const slug = `coral-note-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Note ${index}`,
          entrySeq: index,
          body: `Body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Note ${index}`,
          entrySeq: index,
        });
      }

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {} });

      await expect(internals.claimCurateRun('2026-03-25')).resolves.toBeNull();
    });

    it('claims a new-day cohort in mutation-sequence order', async () => {
      const specs: Array<[string, number]> = [
        ['coral-ten', 10],
        ['coral-two', 2],
        ['coral-seven', 7],
        ['coral-one', 1],
        ['coral-six', 6],
        ['coral-four', 4],
        ['coral-nine', 9],
        ['coral-three', 3],
        ['coral-eight', 8],
        ['coral-five', 5],
      ];
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};

      for (const [slug, seq] of specs) {
        writeNote(slug, {
          title: `Note ${seq}`,
          entrySeq: seq,
          updatedAt: `2026-03-20T00:00:${String(seq).padStart(2, '0')}.000Z`,
          body: `Body ${seq}.`,
        });
        notes[slug] = createIndexNote({
          title: `Note ${seq}`,
          updatedAt: `2026-03-20T00:00:${String(seq).padStart(2, '0')}.000Z`,
          entrySeq: seq,
        });
      }

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {} });
      writeCurateState(
        runtime,
        createCurateState({
          lastRunDay: '2026-03-24',
        }),
      );

      const claim = await internals.claimCurateRun('2026-03-25');

      expect(claim).not.toBeNull();
      expect(claim?.entries.map((note) => note.entrySeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(claim?.entries.map((note) => note.slug)).toEqual([
        'coral-one',
        'coral-two',
        'coral-three',
        'coral-four',
        'coral-five',
        'coral-six',
        'coral-seven',
        'coral-eight',
        'coral-nine',
        'coral-ten',
      ]);
      expect(claim?.through).toEqual(cursor('coral-ten', 10));
      expect(readCurateState(runtime)).toMatchObject({
        lastRunDay: '2026-03-25',
        lastAttemptedThrough: cursor('coral-ten', 10),
        activeClaim: {
          through: cursor('coral-ten', 10),
        },
      });
    });

    it('claims at most one hundred notes when the max-size threshold is reached', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};

      for (let index = 101; index >= 1; index -= 1) {
        const slug = `coral-note-${String(index).padStart(3, '0')}`;
        writeNote(slug, {
          title: `Note ${index}`,
          entrySeq: index,
        });
        notes[slug] = createIndexNote({
          title: `Note ${index}`,
          entrySeq: index,
        });
      }

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {} });
      writeCurateState(
        runtime,
        createCurateState({
          lastRunDay: '2026-03-25',
        }),
      );

      const claim = await internals.claimCurateRun('2026-03-25');

      expect(claim?.entries).toHaveLength(100);
      expect(claim?.entries[0]?.entrySeq).toBe(1);
      expect(claim?.entries[99]?.entrySeq).toBe(100);
      expect(claim?.through).toEqual(cursor('coral-note-100', 100));
    });

    it('chunks entries at the requested batch size including edge cases', () => {
      expect(chunkEntriesByPromptBudget([], ['coral'], [], 10)).toEqual([]);
      expect(
        chunkEntriesByPromptBudget(
          Array.from({ length: 10 }, (_, index) =>
            buildClaimedNote({
              slug: `coral-note-${index + 1}`,
              title: `Note ${index + 1}`,
              entrySeq: index + 1,
            }),
          ),
          ['coral'],
          [],
          10,
        ).map((batch) => batch.map((entry) => entry.entrySeq)),
      ).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
      expect(
        chunkEntriesByPromptBudget(
          Array.from({ length: 11 }, (_, index) =>
            buildClaimedNote({
              slug: `coral-note-${index + 1}`,
              title: `Note ${index + 1}`,
              entrySeq: index + 1,
            }),
          ),
          ['coral'],
          [],
          10,
        ).map((batch) => batch.map((entry) => entry.entrySeq)),
      ).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [11]]);
    });
  });

  describe('metadata targets and commit', () => {
    it('builds metadata targets for every claimed note including no-op targets', () => {
      const index: KbIndex = {
        entries: createIndexEntries({
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            tags: ['coral'],
            principles: [],
            updatedAt: '2026-03-20T00:00:01.000Z',
            entrySeq: 2,
          }),
          'coral-beta': createIndexNote({
            title: 'Beta',
            tags: ['coral', 'kb'],
            principles: [],
            updatedAt: '2026-03-20T00:00:02.000Z',
            entrySeq: 1,
          }),
        }),
        principles: {},
      };
      const assignments: ClassificationAssignment[] = [
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['coral', 'kb'],
          principles: ['deterministic-ordering'],
        },
      ];
      const claimedNotes = [
        buildClaimedNote({
          slug: 'coral-alpha',
          title: 'Alpha',
          updatedAt: '2026-03-22T00:00:00.000Z',
          entrySeq: 2,
        }),
        buildClaimedNote({
          slug: 'coral-beta',
          title: 'Beta',
          updatedAt: '2026-03-23T00:00:00.000Z',
          entrySeq: 1,
        }),
      ];

      expect(buildMetadataTargets(assignments, index, claimedNotes)).toEqual([
        {
          kind: 'note',
          entryId: noteEntryId('coral-beta'),
          slug: 'coral-beta',
          entrySeq: 1,
          claimTimeUpdatedAt: '2026-03-23T00:00:00.000Z',
        },
        {
          kind: 'note',
          entryId: noteEntryId('coral-alpha'),
          slug: 'coral-alpha',
          entrySeq: 2,
          claimTimeUpdatedAt: '2026-03-22T00:00:00.000Z',
          addTags: ['kb'],
          addPrinciples: ['deterministic-ordering'],
        },
      ]);
    });

    it('merges tags and principles without changing updatedAt and records a committed mutation', async () => {
      const updatedAt = '2026-03-21T00:00:00.000Z';

      writeNote('coral-alpha', {
        title: 'Alpha',
        tags: ['coral', 'existing-tag'],
        principles: ['existing-principle'],
        updatedAt,
        entrySeq: 4,
        body: 'Alpha body.',
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            tags: ['coral', 'existing-tag'],
            principles: ['existing-principle'],
            updatedAt,
            entrySeq: 4,
          }),
        }),
        principles: {},
      });

      await internals.commitMetadataTargets([
        {
          kind: 'note',
          entryId: noteEntryId('coral-alpha'),
          slug: 'coral-alpha',
          entrySeq: 4,
          claimTimeUpdatedAt: updatedAt,
          addTags: ['kb'],
          addPrinciples: ['deterministic-ordering'],
        },
      ]);

      const raw = readFileSync(join(runtime.notesDir(), 'coral-alpha.md'), 'utf-8');
      expect(parseFrontmatter(raw)).toEqual({
        tags: ['coral', 'existing-tag', 'kb'],
        principles: ['existing-principle', 'deterministic-ordering'],
        source: ['kangig94/coral'],
        createdAt: DEFAULT_CREATED_AT,
        updatedAt,
        related: [],
        entrySeq: 4,
      });
      expect(runtime.readIndex()?.entries[noteEntryId('coral-alpha')]).toEqual({
        kind: 'note',
        slug: 'coral-alpha',
        title: 'Alpha',
        tags: ['coral', 'existing-tag', 'kb'],
        principles: ['existing-principle', 'deterministic-ordering'],
        source: ['kangig94/coral'],
        createdAt: DEFAULT_CREATED_AT,
        updatedAt,
        related: [],
        entrySeq: 4,
      });
      expect(runtime.readIndexState()).toMatchObject({
        mutationSeq: 1,
      });
      expect(readCurateState(runtime).processedThrough).toEqual(cursor('coral-alpha', 4));
    });

    it('skips stale notes, advances past missing notes, and only commits safe writes', async () => {
      writeNote('coral-stale', {
        title: 'Stale',
        tags: ['coral'],
        updatedAt: '2026-03-22T00:00:00.000Z',
        entrySeq: 2,
      });
      writeNote('coral-fresh', {
        title: 'Fresh',
        tags: ['coral'],
        updatedAt: '2026-03-23T00:00:00.000Z',
        entrySeq: 3,
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-missing': createIndexNote({
            title: 'Missing',
            updatedAt: '2026-03-21T00:00:00.000Z',
            entrySeq: 1,
          }),
          'coral-stale': createIndexNote({
            title: 'Stale',
            updatedAt: '2026-03-21T00:00:00.000Z',
            entrySeq: 2,
          }),
          'coral-fresh': createIndexNote({
            title: 'Fresh',
            updatedAt: '2026-03-23T00:00:00.000Z',
            entrySeq: 3,
          }),
        }),
        principles: {},
      });

      await internals.commitMetadataTargets([
        {
          kind: 'note',
          entryId: noteEntryId('coral-fresh'),
          slug: 'coral-fresh',
          entrySeq: 3,
          claimTimeUpdatedAt: '2026-03-23T00:00:00.000Z',
          addTags: ['kb'],
        },
        {
          kind: 'note',
          entryId: noteEntryId('coral-stale'),
          slug: 'coral-stale',
          entrySeq: 2,
          claimTimeUpdatedAt: '2026-03-21T00:00:00.000Z',
          addTags: ['kb'],
        },
        {
          kind: 'note',
          entryId: noteEntryId('coral-missing'),
          slug: 'coral-missing',
          entrySeq: 1,
          claimTimeUpdatedAt: '2026-03-21T00:00:00.000Z',
          addTags: ['kb'],
        },
      ]);

      expect(existsSync(join(runtime.notesDir(), 'coral-missing.md'))).toBe(false);
      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-stale.md'), 'utf-8')).tags).toEqual([
        'coral',
      ]);
      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-fresh.md'), 'utf-8')).tags).toEqual([
        'coral',
        'kb',
      ]);
      expect(runtime.readIndex()?.entries[noteEntryId('coral-stale')]?.tags).toEqual(['coral']);
      expect(runtime.readIndex()?.entries[noteEntryId('coral-fresh')]?.tags).toEqual(['coral', 'kb']);
      expect(runtime.readIndexState()).toMatchObject({
        mutationSeq: 1,
      });
      expect(readCurateState(runtime).processedThrough).toEqual(cursor('coral-missing', 1));
    });

    it('applies cleanup-time parent absorption using live tag support', async () => {
      writeNote('coral-parent-child', {
        title: 'Parent Child',
        tags: ['coral', 'stable-parent', 'stable-parent-child'],
        entrySeq: 1,
      });
      writeNote('coral-parent-one', {
        title: 'Parent One',
        tags: ['coral', 'stable-parent'],
        entrySeq: 2,
      });
      writeNote('coral-parent-two', {
        title: 'Parent Two',
        tags: ['coral', 'stable-parent'],
        entrySeq: 3,
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-parent-child': createIndexNote({
            title: 'Parent Child',
            tags: ['coral', 'stable-parent', 'stable-parent-child'],
            entrySeq: 1,
          }),
          'coral-parent-one': createIndexNote({
            title: 'Parent One',
            tags: ['coral', 'stable-parent'],
            entrySeq: 2,
          }),
          'coral-parent-two': createIndexNote({
            title: 'Parent Two',
            tags: ['coral', 'stable-parent'],
            entrySeq: 3,
          }),
        }),
        principles: {},
      });

      await internals.commitMetadataTargets([
        {
          kind: 'note',
          entryId: noteEntryId('coral-parent-child'),
          slug: 'coral-parent-child',
          entrySeq: 1,
          claimTimeUpdatedAt: DEFAULT_UPDATED_AT,
          desiredTags: ['coral', 'stable-parent', 'stable-parent-child'],
          cleanup: true,
        },
      ]);

      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-parent-child.md'), 'utf-8')).tags).toEqual([
        'coral',
        'stable-parent',
      ]);
      expect(runtime.readIndex()?.entries[noteEntryId('coral-parent-child')]?.tags).toEqual([
        'coral',
        'stable-parent',
      ]);
    });

    it('removes absorbed principles while preserving the remaining live principle list', async () => {
      writeNote('coral-alpha', {
        title: 'Alpha',
        principles: ['old-principle', 'kept-principle'],
        updatedAt: '2026-03-21T00:00:00.000Z',
        entrySeq: 4,
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            principles: ['old-principle', 'kept-principle'],
            updatedAt: '2026-03-21T00:00:00.000Z',
            entrySeq: 4,
          }),
        }),
        principles: {},
      });

      await internals.commitMetadataTargets([
        {
          kind: 'note',
          entryId: noteEntryId('coral-alpha'),
          slug: 'coral-alpha',
          entrySeq: 4,
          claimTimeUpdatedAt: '2026-03-21T00:00:00.000Z',
          addPrinciples: ['new-principle'],
          removePrinciples: ['old-principle'],
        },
      ]);

      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-alpha.md'), 'utf-8')).principles).toEqual([
        'kept-principle',
        'new-principle',
      ]);
      expect(runtime.readIndex()?.entries[noteEntryId('coral-alpha')]).toMatchObject({
        principles: ['kept-principle', 'new-principle'],
      });
    });
  });

  describe('runtime integration and errors', () => {
    it('persists discovery attempts and pending discovery changes through the standalone wrappers', async () => {
      const entry = {
        principle: 'contract-first-design',
        statement: 'Write the contract before the implementation.',
        notes: ['coral-alpha', 'coral-beta'],
        createdAt: '2026-03-25T12:00:00.000Z',
      };

      await internals.recordDiscoveryAttempt(52, 0);
      expect(readCurateState(runtime)).toMatchObject({
        discoveryHighSeq: 52,
        discoveryOffset: 0,
      });

      await internals.addPendingDiscovery(entry);
      await internals.addPendingDiscovery(entry);
      expect(readCurateState(runtime).pendingDiscoveries).toEqual([entry]);

      await internals.removePendingDiscovery(entry);
      expect(readCurateState(runtime).pendingDiscoveries).toEqual([]);
    });

    it('persists failure and retry clearing through the standalone wrappers', async () => {
      writeCurateState(
        runtime,
        createCurateState({
          lastAttemptedThrough: cursor('coral-retry', 9),
          activeClaim: {
            through: cursor('coral-retry', 9),
            startedAt: '2026-03-25T11:58:00.000Z',
          },
          consecutiveFailures: 1,
        }),
      );

      await internals.recordCurateFailure(null, new Error('Failed to spawn claude: ENOENT'));
      expect(readCurateState(runtime)).toMatchObject({
        lastAttemptedThrough: cursor('coral-retry', 9),
        retryNotBefore: '2026-03-25T16:00:00.000Z',
        activeClaim: null,
        consecutiveFailures: 2,
      });

      await internals.clearCurateRetryState();
      expect(readCurateState(runtime)).toMatchObject({
        retryNotBefore: null,
        activeClaim: null,
        consecutiveFailures: 0,
      });
    });

    it('keeps mutation lock acquisition flat while discovery drains pending entries and processes new proposals', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};
      const pendingDiscoveries = [
        {
          principle: 'deterministic-ordering',
          statement: 'Sort values before assigning identifiers.',
          notes: ['coral-discovery-01', 'coral-discovery-02'],
          createdAt: '2026-03-25T11:50:00.000Z',
        },
        {
          principle: 'contract-first-design',
          statement: 'Write the contract before the implementation.',
          notes: ['coral-discovery-03', 'coral-discovery-04'],
          createdAt: '2026-03-25T11:55:00.000Z',
        },
      ];

      for (let index = 1; index <= 54; index += 1) {
        const slug = `coral-discovery-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Discovery ${index}`,
          entrySeq: index,
          body: `Discovery body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Discovery ${index}`,
          entrySeq: index,
        });
      }

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {} });
      writeCurateState(
        runtime,
        createCurateState({
          processedThrough: cursor('coral-discovery-54', 54),
          pendingDiscoveries,
        }),
      );
      useScheduler(async () => ({
        stdout: JSON.stringify([
          {
            slug: 'single-source-of-truth',
            statement: 'Keep one canonical representation for each fact.',
            notes: ['coral-discovery-05', 'coral-discovery-06', 'coral-discovery-09'],
          },
          {
            slug: 'verify-at-boundaries',
            statement: 'Validate inputs at system boundaries before using them.',
            notes: ['coral-discovery-07', 'coral-discovery-08', 'coral-discovery-10'],
          },
        ]),
        stderr: '',
        code: 0,
        aborted: false,
      }));

      const lockSpy = vi.spyOn(runtime, 'withMutationLock');
      const readSpy = vi.spyOn(curateState, 'readCurateState');

      await internals.runPrincipleDiscovery(cursor('coral-discovery-54', 54));

      expect(lockSpy).toHaveBeenCalledTimes(2);
      expect(readSpy).toHaveBeenCalledTimes(2);
      lockSpy.mockRestore();
      readSpy.mockRestore();

      expect(readCurateState(runtime)).toMatchObject({
        pendingDiscoveries: [],
      });
      expect(
        parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-discovery-05.md'), 'utf-8')).principles,
      ).toEqual(['single-source-of-truth']);
      expect(
        parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-discovery-07.md'), 'utf-8')).principles,
      ).toEqual(['verify-at-boundaries']);
    });

    it('refines an existing principle in the conflict path and still assigns it to the proposed notes', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};

      for (let index = 1; index <= 50; index += 1) {
        const slug = `coral-discovery-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Discovery ${index}`,
          entrySeq: index,
          body: `Discovery body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Discovery ${index}`,
          entrySeq: index,
        });
      }

      mkdirSync(runtime.principlesDir(), { recursive: true });
      writeFileSync(
        runtime.principlePath('single-source-of-truth'),
        [
          '---',
          'createdAt: 2026-03-20T00:00:00.000Z',
          'updatedAt: 2026-03-20T00:00:00.000Z',
          '---',
          '',
          'Keep exactly one source for each fact.',
          '',
        ].join('\n'),
        'utf-8',
      );
      runtime.writeIndex({
        entries: createIndexEntries(notes),
        principles: {
          'single-source-of-truth': 'Keep exactly one source for each fact.',
        },
      });
      writeCurateState(
        runtime,
        createCurateState({
          processedThrough: cursor('coral-discovery-50', 50),
        }),
      );
      useScheduler(async () => ({
        stdout: JSON.stringify([
          {
            slug: 'single-source-of-truth',
            statement: 'Keep one canonical representation for each fact.',
            notes: ['coral-discovery-05', 'coral-discovery-06', 'coral-discovery-07'],
          },
        ]),
        stderr: '',
        code: 0,
        aborted: false,
      }));

      await internals.runPrincipleDiscovery(cursor('coral-discovery-50', 50));

      const principleRaw = readFileSync(runtime.principlePath('single-source-of-truth'), 'utf-8');
      expect(principleRaw).toContain('createdAt: 2026-03-20T00:00:00.000Z');
      expect(principleRaw).toContain('updatedAt: 2026-03-25T12:00:00.000Z');
      expect(principleRaw).toContain('Keep one canonical representation for each fact.');
      expect(runtime.readIndex()?.principles['single-source-of-truth']).toBe(
        'Keep one canonical representation for each fact.',
      );
      expect(
        parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-discovery-05.md'), 'utf-8')).principles,
      ).toEqual(['single-source-of-truth']);
      expect(readCurateState(runtime).pendingDiscoveries).toEqual([]);
    });

    it('merges absorbed principles after proposal processing without recreating deleted rows', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};

      for (let index = 1; index <= 51; index += 1) {
        const slug = `coral-discovery-${String(index).padStart(2, '0')}`;
        const principles = index >= 8 && index <= 9 ? ['single-owner'] : [];
        writeNote(slug, {
          title: `Discovery ${index}`,
          principles,
          entrySeq: index,
          body: `Discovery body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Discovery ${index}`,
          principles,
          entrySeq: index,
        });
      }

      mkdirSync(runtime.principlesDir(), { recursive: true });
      writeFileSync(
        runtime.principlePath('single-owner'),
        [
          '---',
          'createdAt: 2026-03-20T00:00:00.000Z',
          'updatedAt: 2026-03-20T00:00:00.000Z',
          '---',
          '',
          'Attach payloads to one owner.',
          '',
        ].join('\n'),
        'utf-8',
      );
      runtime.writeIndex({
        entries: createIndexEntries(notes),
        principles: {
          'single-owner': 'Attach payloads to one owner.',
        },
      });
      writeCurateState(
        runtime,
        createCurateState({
          processedThrough: cursor('coral-discovery-50', 50),
          pendingDiscoveries: [
            {
              principle: 'single-owner',
              statement: 'Attach payloads to one owner.',
              notes: ['coral-discovery-51'],
              createdAt: '2026-03-25T11:55:00.000Z',
            },
          ],
        }),
      );
      useScheduler(async () => ({
        stdout: JSON.stringify([
          {
            slug: 'payload-attachment-to-owner',
            statement: 'Attach payloads to exactly one owner.',
            notes: ['coral-discovery-05', 'coral-discovery-06', 'coral-discovery-07'],
            absorbs: ['single-owner'],
          },
        ]),
        stderr: '',
        code: 0,
        aborted: false,
      }));

      await internals.runPrincipleDiscovery(cursor('coral-discovery-50', 50));

      expect(existsSync(runtime.principlePath('single-owner'))).toBe(false);
      expect(existsSync(runtime.principlePath('payload-attachment-to-owner'))).toBe(true);
      expect(runtime.readIndex()?.principles).toEqual({
        'payload-attachment-to-owner': 'Attach payloads to exactly one owner.',
      });
      expect(
        parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-discovery-08.md'), 'utf-8')).principles,
      ).toEqual(['payload-attachment-to-owner']);
      expect(
        parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-discovery-09.md'), 'utf-8')).principles,
      ).toEqual(['payload-attachment-to-owner']);
      expect(readCurateState(runtime).pendingDiscoveries).toEqual([]);
    });

    it('writes the KB gitignore block once and leaves it unchanged on a second runtime start', async () => {
      const gitignorePath = join(tempDir, '.gitignore');
      writeFileSync(gitignorePath, 'notes/\n', 'utf-8');

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      const afterFirstStart = readFileSync(gitignorePath, 'utf-8');
      expect(afterFirstStart).toContain('notes/\n');
      expect(afterFirstStart).toContain('# Coral KB runtime (device-local, auto-managed)\ndata/\n');

      const secondRuntime = createKbRuntime({
        markdownRoot: tempDir,
        runtimeDir: tempDir,
      });
      const secondScheduler = createCurateScheduler({
        kb: secondRuntime,
        spawnCli: noopSpawnCli,
        scheduleDebounceMs: 0,
      });
      await secondScheduler.start();
      await settleCurateRuntime(secondScheduler);

      expect(readFileSync(gitignorePath, 'utf-8')).toBe(afterFirstStart);
    });

    it('runs cleanup successfully in a non-git KB root while removing cleanup tags', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};
      const spawn = vi.fn<SpawnCliFn>(async () => ({
        stdout: '[]',
        stderr: '',
        code: 0,
        aborted: false,
      }));

      const specs: Array<{ slug: string; seq: number; tags: string[] }> = [
        { slug: 'coral-pattern-note', seq: 1, tags: ['coral', 'isolated-pattern'] },
        { slug: 'coral-parent-child', seq: 2, tags: ['coral', 'stable-parent', 'stable-parent-child'] },
        { slug: 'coral-parent-one', seq: 3, tags: ['coral', 'stable-parent'] },
        { slug: 'coral-parent-two', seq: 4, tags: ['coral', 'stable-parent'] },
        { slug: 'coral-note-05', seq: 5, tags: ['coral'] },
        { slug: 'coral-note-06', seq: 6, tags: ['coral'] },
        { slug: 'coral-note-07', seq: 7, tags: ['coral'] },
        { slug: 'coral-note-08', seq: 8, tags: ['coral'] },
        { slug: 'coral-note-09', seq: 9, tags: ['coral'] },
        { slug: 'coral-note-10', seq: 10, tags: ['coral'] },
      ];

      for (const spec of specs) {
        writeNote(spec.slug, {
          title: spec.slug,
          tags: spec.tags,
          entrySeq: spec.seq,
        });
        notes[spec.slug] = createIndexNote({
          title: spec.slug,
          tags: spec.tags,
          entrySeq: spec.seq,
        });
      }

      runtime.writeIndex({
        entries: createIndexEntries(notes),
        principles: {},
      });
      writeCurateState(runtime, {
        ...readCurateState(runtime),
        initialized: true,
        migrationVersion: curateState.CURATE_STATE_MIGRATION_VERSION,
      });
      useScheduler(spawn);

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-pattern-note.md'), 'utf-8')).tags).toEqual([
        'coral',
      ]);
      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-parent-child.md'), 'utf-8')).tags).toEqual([
        'coral',
        'stable-parent',
      ]);
      expect(runtime.readIndex()?.entries[noteEntryId('coral-pattern-note')]?.tags).toEqual(['coral']);
      expect(runtime.readIndex()?.entries[noteEntryId('coral-parent-child')]?.tags).toEqual([
        'coral',
        'stable-parent',
      ]);
      expect(readCurateState(runtime).processedThrough).toEqual(cursor('coral-note-10', 10));
    });

    it('aborts the active spawn on stop() without leaving retry state or an active claim', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};
      const spawnStarted = createDeferred<void>();
      const spawnAborted = createDeferred<void>();
      const spawn = vi.fn<SpawnCliFn>(async ({ signal }) => {
        if (signal === undefined) {
          throw new Error('Expected curate stop signal.');
        }

        spawnStarted.resolve();
        return new Promise((resolve) => {
          const finish = () => {
            spawnAborted.resolve();
            resolve({
              stdout: '',
              stderr: '',
              code: null,
              aborted: true,
            });
          };

          if (signal.aborted) {
            finish();
            return;
          }

          signal.addEventListener('abort', finish, { once: true });
        });
      });

      for (let index = 1; index <= 10; index += 1) {
        const slug = `coral-stop-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Stop ${index}`,
          entrySeq: index,
        });
        notes[slug] = createIndexNote({
          title: `Stop ${index}`,
          entrySeq: index,
        });
      }

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {} });
      writeCurateState(runtime, createCurateState({ initialized: true }));
      useScheduler(spawn);

      await scheduler.start();
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
      await spawnStarted.promise;

      expect(readCurateState(runtime)).toMatchObject({
        lastAttemptedThrough: cursor('coral-stop-10', 10),
        activeClaim: {
          through: cursor('coral-stop-10', 10),
        },
      });

      const stopPromise = scheduler.stop();
      await spawnAborted.promise;
      await expect(stopPromise).resolves.toBeUndefined();

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readCurateState(runtime)).toMatchObject({
        lastAttemptedThrough: cursor('coral-stop-10', 10),
        retryNotBefore: null,
        activeClaim: null,
        consecutiveFailures: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(scheduler.isRunning()).toBe(false);
    });

    it('throws a CurateJsonParseError when classification returns malformed JSON', async () => {
      useScheduler(async () => ({
        stdout: '[',
        stderr: '',
        code: 0,
        aborted: false,
      }));
      const claim = {
        entries: [
          buildClaimedNote({
            slug: 'coral-alpha',
            title: 'Alpha',
            entrySeq: 1,
          }),
        ],
        through: cursor('coral-alpha', 1),
      };

      await expect(
        internals.runClassificationBatches(claim, {
          entries: createIndexEntries({
            'coral-alpha': createIndexNote({
              title: 'Alpha',
              entrySeq: 1,
            }),
          }),
          principles: {},
        }),
      ).rejects.toMatchObject({
        name: 'CurateJsonParseError',
        message: 'Curate classification returned invalid JSON.',
      });
    });

    it('throws a CurateJsonParseError when principle discovery returns malformed JSON', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};

      for (let index = 1; index <= 50; index += 1) {
        const slug = `coral-discovery-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Discovery ${index}`,
          entrySeq: index,
          body: `Discovery body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Discovery ${index}`,
          entrySeq: index,
        });
      }

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {} });
      writeCurateState(
        runtime,
        createCurateState({
          processedThrough: cursor('coral-discovery-50', 50),
        }),
      );
      useScheduler(async () => ({
        stdout: '[',
        stderr: '',
        code: 0,
        aborted: false,
      }));

      await expect(
        internals.runPrincipleDiscovery(cursor('coral-discovery-50', 50)),
      ).rejects.toMatchObject({
        name: 'CurateJsonParseError',
        message: 'Curate discovery returned invalid JSON.',
      });
    });

    it('records retry state from scheduled failures using the claimed through cursor', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};

      for (let index = 1; index <= 10; index += 1) {
        const slug = `coral-failure-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Failure ${index}`,
          entrySeq: index,
        });
        notes[slug] = createIndexNote({
          title: `Failure ${index}`,
          entrySeq: index,
        });
      }

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {} });
      useScheduler(async () => ({
        stdout: '[',
        stderr: '',
        code: 0,
        aborted: false,
      }));

      await scheduler.start();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
        if (readCurateState(runtime).consecutiveFailures === 1) {
          break;
        }
      }

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Curate classification returned invalid JSON.'));
      expect(readCurateState(runtime)).toMatchObject({
        lastAttemptedThrough: cursor('coral-failure-10', 10),
        activeClaim: null,
        consecutiveFailures: 1,
      });
      expect(readCurateState(runtime).retryNotBefore).not.toBeNull();
    });
  });

  describe('start with missing index', () => {
    it('should rebuild index and complete migration when index.json is missing but notes exist', async () => {
      writeNote('test-note', { title: 'Test Note', entrySeq: 1 });

      // No index written — ensureIndex inside start() should rebuild it
      expect(runtime.readIndex()).toBeNull();

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      // Index rebuilt
      expect(runtime.readIndex()).not.toBeNull();

      // Curate state initialized
      const state = readCurateState(runtime);
      expect(state.initialized).toBe(true);
    });
  });
});
