import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as curateState from '../curate-state.js';
import {
  buildClassificationPrompt,
  buildDiscoveryPrompt,
  buildMetadataTargets,
  chunkNotes,
  createCurateScheduler,
  parseClassificationResponse,
  parseDiscoveryResponse,
  validateAssignments,
  validateDiscoveryProposals,
  type ClassificationAssignment,
  type CurateClaimedNote,
  type CurateHandle,
  type DiscoveryProposal,
  type SpawnCliFn,
} from '../curate.js';
import { readCurateState, writeCurateState, type CurateState } from '../curate-state.js';
import { parseFrontmatter } from '../frontmatter.js';
import { createKbRuntime, type KbRuntime } from '../runtime.js';
import type { KbIndex } from '../types.js';

const DEFAULT_CREATED_AT = '2026-03-20T00:00:00.000Z';
const DEFAULT_UPDATED_AT = '2026-03-20T00:00:00.000Z';

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
  createdAt = DEFAULT_CREATED_AT,
  updatedAt = DEFAULT_UPDATED_AT,
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

function createIndexNote({
  title,
  tags = ['coral'],
  principles = [],
  source = ['kangig94/coral'],
  createdAt = DEFAULT_CREATED_AT,
  updatedAt = DEFAULT_UPDATED_AT,
  mutationSeqAtPromote,
}: {
  title: string;
  tags?: string[];
  principles?: string[];
  source?: string[];
  createdAt?: string;
  updatedAt?: string;
  mutationSeqAtPromote?: number;
}): KbIndex['notes'][string] {
  return {
    title,
    tags,
    principles,
    source,
    createdAt,
    updatedAt,
    ...(mutationSeqAtPromote === undefined ? {} : { mutationSeqAtPromote }),
  };
}

function buildClaimedNote({
  slug,
  title,
  body = 'Body.',
  updatedAt = DEFAULT_UPDATED_AT,
  mutationSeqAtPromote,
}: {
  slug: string;
  title: string;
  body?: string;
  updatedAt?: string;
  mutationSeqAtPromote: number;
}): CurateClaimedNote {
  return {
    slug,
    title,
    body,
    updatedAt,
    mutationSeqAtPromote,
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
    mutationSeqAtPromote?: number;
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
      const prompt = buildClassificationPrompt([
        buildClaimedNote({
          slug: 'coral-alpha',
          title: 'Alpha',
          body: 'Alpha body.',
          mutationSeqAtPromote: 1,
        }),
        buildClaimedNote({
          slug: 'coral-beta',
          title: 'Beta',
          body: 'Beta body.',
          mutationSeqAtPromote: 2,
        }),
      ], ['coral', 'kb', 'ui-pattern'], ['contract-first-design', 'deterministic-ordering']);

      expect(prompt).toContain('Tag vocabulary:\n- coral\n- kb\n- ui-pattern');
      expect(prompt).toContain('Principle names:\n- contract-first-design\n- deterministic-ordering');
      expect(prompt).toContain('## coral-alpha\nAlpha\nAlpha body.');
      expect(prompt).toContain('## coral-beta\nBeta\nBeta body.');
      expect(prompt).toContain('Return a JSON array: [{ "note": "<slug>"');
    });

    it('parses classification responses from raw and code-fenced JSON arrays', () => {
      const noteMap = new Map<string, true>([
        ['coral-alpha', true],
        ['coral-beta', true],
      ]);
      const raw = JSON.stringify([
        {
          note: 'coral-alpha',
          tags: ['coral', 'kb'],
          principles: ['deterministic-ordering'],
        },
        {
          note: 'coral-beta',
          tags: ['coral'],
          principles: [],
        },
      ]);

      expect(parseClassificationResponse(raw, noteMap)).toEqual([
        {
          note: 'coral-alpha',
          tags: ['coral', 'kb'],
          principles: ['deterministic-ordering'],
        },
        {
          note: 'coral-beta',
          tags: ['coral'],
          principles: [],
        },
      ]);
      expect(parseClassificationResponse(`\`\`\`json\n${raw}\n\`\`\``, noteMap)).toEqual([
        {
          note: 'coral-alpha',
          tags: ['coral', 'kb'],
          principles: ['deterministic-ordering'],
        },
        {
          note: 'coral-beta',
          tags: ['coral'],
          principles: [],
        },
      ]);
    });

    it('returns an empty classification list for non-array JSON, malformed JSON, and malformed entries', () => {
      const noteMap = new Map<string, true>([['coral-alpha', true]]);

      expect(parseClassificationResponse('{"note":"coral-alpha"}', noteMap)).toEqual([]);
      expect(parseClassificationResponse('[', noteMap)).toEqual([]);
      expect(parseClassificationResponse(JSON.stringify([
        { note: 'coral-alpha', tags: ['coral'] },
        { note: 'coral-missing', tags: ['coral'], principles: [] },
        { note: 'coral-alpha', tags: ['coral'], principles: [] },
      ]), noteMap)).toEqual([
        {
          note: 'coral-alpha',
          tags: ['coral'],
          principles: [],
        },
      ]);
    });

    it('validates assignments by dropping unknown notes and principles while requiring new-tag support', () => {
      const index: KbIndex = {
        notes: {
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            tags: ['coral', 'existing-tag'],
            mutationSeqAtPromote: 1,
          }),
          'coral-beta': createIndexNote({
            title: 'Beta',
            mutationSeqAtPromote: 2,
          }),
          'coral-gamma': createIndexNote({
            title: 'Gamma',
            mutationSeqAtPromote: 3,
          }),
        },
        principles: {
          'deterministic-ordering': 'Sort once before assigning metadata.',
        },
      };
      const claimedNotes = [
        buildClaimedNote({ slug: 'coral-alpha', title: 'Alpha', mutationSeqAtPromote: 1 }),
        buildClaimedNote({ slug: 'coral-beta', title: 'Beta', mutationSeqAtPromote: 2 }),
        buildClaimedNote({ slug: 'coral-gamma', title: 'Gamma', mutationSeqAtPromote: 3 }),
      ];
      const proposals: ClassificationAssignment[] = [
        {
          note: 'coral-alpha',
          tags: ['existing-tag', 'new-supported', 'new-single'],
          principles: ['deterministic-ordering', 'unknown-principle'],
        },
        {
          note: 'coral-alpha',
          tags: ['new-supported', 'existing-tag'],
          principles: ['deterministic-ordering'],
        },
        {
          note: 'coral-beta',
          tags: ['new-supported', 'new-unsupported'],
          principles: [],
        },
        {
          note: 'coral-gamma',
          tags: ['new-supported'],
          principles: ['unknown-principle'],
        },
        {
          note: 'coral-outside',
          tags: ['new-supported'],
          principles: ['deterministic-ordering'],
        },
      ];

      expect(validateAssignments(proposals, index, claimedNotes)).toEqual([
        {
          note: 'coral-alpha',
          tags: ['coral', 'existing-tag', 'new-supported'],
          principles: ['deterministic-ordering'],
        },
        {
          note: 'coral-beta',
          tags: ['coral', 'new-supported'],
          principles: [],
        },
        {
          note: 'coral-gamma',
          tags: ['coral', 'new-supported'],
          principles: [],
        },
      ]);
    });

    it('builds a discovery prompt with note bodies truncated to five hundred characters', () => {
      const longBody = 'x'.repeat(600);
      const prompt = buildDiscoveryPrompt([
        buildClaimedNote({
          slug: 'coral-alpha',
          title: 'Alpha',
          body: longBody,
          mutationSeqAtPromote: 1,
        }),
      ], ['deterministic-ordering']);

      expect(prompt).toContain('Existing principle names. Do not duplicate them:\n- deterministic-ordering');
      expect(prompt).toContain(`## coral-alpha\nAlpha\n${'x'.repeat(500)}`);
      expect(prompt).not.toContain('x'.repeat(501));
    });

    it('parses discovery responses from raw and code-fenced JSON arrays and drops malformed entries', () => {
      const raw = JSON.stringify([
        {
          slug: 'stable-ownership',
          statement: 'Attach payloads to one owner.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
        {
          slug: 'missing-notes',
          statement: 'This one is malformed.',
        },
      ]);

      expect(parseDiscoveryResponse(raw)).toEqual([
        {
          slug: 'stable-ownership',
          statement: 'Attach payloads to one owner.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
      ]);
      expect(parseDiscoveryResponse(`\`\`\`json\n${raw}\n\`\`\``)).toEqual([
        {
          slug: 'stable-ownership',
          statement: 'Attach payloads to one owner.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
      ]);
      expect(parseDiscoveryResponse('{"slug":"not-an-array"}')).toEqual([]);
      expect(parseDiscoveryResponse('[')).toEqual([]);
    });

    it('validates discovery proposals for slug uniqueness, eligibility, and minimum note support', () => {
      const eligibleNotes = [
        buildClaimedNote({ slug: 'coral-alpha', title: 'Alpha', mutationSeqAtPromote: 1 }),
        buildClaimedNote({ slug: 'coral-beta', title: 'Beta', mutationSeqAtPromote: 2 }),
        buildClaimedNote({ slug: 'coral-gamma', title: 'Gamma', mutationSeqAtPromote: 3 }),
        buildClaimedNote({ slug: 'coral-delta', title: 'Delta', mutationSeqAtPromote: 4 }),
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

      expect(validateDiscoveryProposals(proposals, eligibleNotes, ['existing-principle'])).toEqual([
        {
          slug: 'shared-context',
          statement: 'Preserve one context owner.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
      ]);
    });
  });

  describe('claim logic and batching', () => {
    it('returns null when there are no pending notes beyond processedThrough', async () => {
      writeNote('coral-alpha', {
        title: 'Alpha',
        mutationSeqAtPromote: 1,
      });
      writeNote('coral-beta', {
        title: 'Beta',
        mutationSeqAtPromote: 2,
      });
      runtime.writeIndex({
        notes: {
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            mutationSeqAtPromote: 1,
          }),
          'coral-beta': createIndexNote({
            title: 'Beta',
            mutationSeqAtPromote: 2,
          }),
        },
        principles: {},
      });
      writeCurateState(runtime, createCurateState({
        processedThrough: {
          note: 'coral-beta',
          mutationSeqAtPromote: 2,
        },
      }));

      await expect(internals.claimCurateRun('2026-03-25')).resolves.toBeNull();
    });

    it('returns null when pending notes stay below the first-pass threshold', async () => {
      const notes: KbIndex['notes'] = {};

      for (let index = 1; index <= 9; index += 1) {
        const slug = `coral-note-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Note ${index}`,
          mutationSeqAtPromote: index,
          body: `Body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Note ${index}`,
          mutationSeqAtPromote: index,
        });
      }

      runtime.writeIndex({ notes, principles: {} });

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
      const notes: KbIndex['notes'] = {};

      for (const [slug, seq] of specs) {
        writeNote(slug, {
          title: `Note ${seq}`,
          mutationSeqAtPromote: seq,
          updatedAt: `2026-03-20T00:00:${String(seq).padStart(2, '0')}.000Z`,
          body: `Body ${seq}.`,
        });
        notes[slug] = createIndexNote({
          title: `Note ${seq}`,
          updatedAt: `2026-03-20T00:00:${String(seq).padStart(2, '0')}.000Z`,
          mutationSeqAtPromote: seq,
        });
      }

      runtime.writeIndex({ notes, principles: {} });
      writeCurateState(runtime, createCurateState({
        lastRunDay: '2026-03-24',
      }));

      const claim = await internals.claimCurateRun('2026-03-25');

      expect(claim).not.toBeNull();
      expect(claim?.notes.map((note) => note.mutationSeqAtPromote)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(claim?.notes.map((note) => note.slug)).toEqual([
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
      expect(claim?.through).toEqual({
        note: 'coral-ten',
        mutationSeqAtPromote: 10,
      });
      expect(readCurateState(runtime)).toMatchObject({
        lastRunDay: '2026-03-25',
        lastAttemptedThrough: {
          note: 'coral-ten',
          mutationSeqAtPromote: 10,
        },
        activeClaim: {
          through: {
            note: 'coral-ten',
            mutationSeqAtPromote: 10,
          },
        },
      });
    });

    it('claims at most thirty notes when the max-size threshold is reached', async () => {
      const notes: KbIndex['notes'] = {};

      for (let index = 31; index >= 1; index -= 1) {
        const slug = `coral-note-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Note ${index}`,
          mutationSeqAtPromote: index,
        });
        notes[slug] = createIndexNote({
          title: `Note ${index}`,
          mutationSeqAtPromote: index,
        });
      }

      runtime.writeIndex({ notes, principles: {} });
      writeCurateState(runtime, createCurateState({
        lastRunDay: '2026-03-25',
      }));

      const claim = await internals.claimCurateRun('2026-03-25');

      expect(claim?.notes).toHaveLength(30);
      expect(claim?.notes[0]?.mutationSeqAtPromote).toBe(1);
      expect(claim?.notes[29]?.mutationSeqAtPromote).toBe(30);
      expect(claim?.through).toEqual({
        note: 'coral-note-30',
        mutationSeqAtPromote: 30,
      });
    });

    it('chunks notes at the requested batch size including edge cases', () => {
      expect(chunkNotes([], 10)).toEqual([]);
      expect(chunkNotes(Array.from({ length: 10 }, (_, index) => index + 1), 10)).toEqual([
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      ]);
      expect(chunkNotes(Array.from({ length: 11 }, (_, index) => index + 1), 10)).toEqual([
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        [11],
      ]);
    });
  });

  describe('metadata targets and commit', () => {
    it('builds metadata targets for every claimed note including no-op targets', () => {
      const index: KbIndex = {
        notes: {
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            tags: ['coral'],
            principles: [],
            updatedAt: '2026-03-20T00:00:01.000Z',
            mutationSeqAtPromote: 2,
          }),
          'coral-beta': createIndexNote({
            title: 'Beta',
            tags: ['coral', 'kb'],
            principles: [],
            updatedAt: '2026-03-20T00:00:02.000Z',
            mutationSeqAtPromote: 1,
          }),
        },
        principles: {},
      };
      const assignments: ClassificationAssignment[] = [{
        note: 'coral-alpha',
        tags: ['coral', 'kb'],
        principles: ['deterministic-ordering'],
      }];
      const claimedNotes = [
        buildClaimedNote({
          slug: 'coral-alpha',
          title: 'Alpha',
          updatedAt: '2026-03-22T00:00:00.000Z',
          mutationSeqAtPromote: 2,
        }),
        buildClaimedNote({
          slug: 'coral-beta',
          title: 'Beta',
          updatedAt: '2026-03-23T00:00:00.000Z',
          mutationSeqAtPromote: 1,
        }),
      ];

      expect(buildMetadataTargets(assignments, index, claimedNotes)).toEqual([
        {
          note: 'coral-beta',
          mutationSeqAtPromote: 1,
          claimTimeUpdatedAt: '2026-03-23T00:00:00.000Z',
        },
        {
          note: 'coral-alpha',
          mutationSeqAtPromote: 2,
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
        mutationSeqAtPromote: 4,
        body: 'Alpha body.',
      });
      runtime.writeIndex({
        notes: {
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            tags: ['coral', 'existing-tag'],
            principles: ['existing-principle'],
            updatedAt,
            mutationSeqAtPromote: 4,
          }),
        },
        principles: {},
      });

      await internals.commitMetadataTargets([{
        note: 'coral-alpha',
        mutationSeqAtPromote: 4,
        claimTimeUpdatedAt: updatedAt,
        addTags: ['kb'],
        addPrinciples: ['deterministic-ordering'],
      }]);

      const raw = readFileSync(join(runtime.notesDir(), 'coral-alpha.md'), 'utf-8');
      expect(parseFrontmatter(raw)).toEqual({
        tags: ['coral', 'existing-tag', 'kb'],
        principles: ['existing-principle', 'deterministic-ordering'],
        source: ['kangig94/coral'],
        createdAt: DEFAULT_CREATED_AT,
        updatedAt,
        mutationSeqAtPromote: 4,
      });
      expect(runtime.readIndex()?.notes['coral-alpha']).toEqual({
        title: 'Alpha',
        tags: ['coral', 'existing-tag', 'kb'],
        principles: ['existing-principle', 'deterministic-ordering'],
        source: ['kangig94/coral'],
        createdAt: DEFAULT_CREATED_AT,
        updatedAt,
        mutationSeqAtPromote: 4,
      });
      expect(runtime.readIndexState()).toMatchObject({
        mutationSeq: 1,
      });
      expect(readCurateState(runtime).processedThrough).toEqual({
        note: 'coral-alpha',
        mutationSeqAtPromote: 4,
      });
    });

    it('skips stale notes, advances past missing notes, and only commits safe writes', async () => {
      writeNote('coral-stale', {
        title: 'Stale',
        tags: ['coral'],
        updatedAt: '2026-03-22T00:00:00.000Z',
        mutationSeqAtPromote: 2,
      });
      writeNote('coral-fresh', {
        title: 'Fresh',
        tags: ['coral'],
        updatedAt: '2026-03-23T00:00:00.000Z',
        mutationSeqAtPromote: 3,
      });
      runtime.writeIndex({
        notes: {
          'coral-missing': createIndexNote({
            title: 'Missing',
            updatedAt: '2026-03-21T00:00:00.000Z',
            mutationSeqAtPromote: 1,
          }),
          'coral-stale': createIndexNote({
            title: 'Stale',
            updatedAt: '2026-03-21T00:00:00.000Z',
            mutationSeqAtPromote: 2,
          }),
          'coral-fresh': createIndexNote({
            title: 'Fresh',
            updatedAt: '2026-03-23T00:00:00.000Z',
            mutationSeqAtPromote: 3,
          }),
        },
        principles: {},
      });

      await internals.commitMetadataTargets([
        {
          note: 'coral-fresh',
          mutationSeqAtPromote: 3,
          claimTimeUpdatedAt: '2026-03-23T00:00:00.000Z',
          addTags: ['kb'],
        },
        {
          note: 'coral-stale',
          mutationSeqAtPromote: 2,
          claimTimeUpdatedAt: '2026-03-21T00:00:00.000Z',
          addTags: ['kb'],
        },
        {
          note: 'coral-missing',
          mutationSeqAtPromote: 1,
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
      expect(runtime.readIndex()?.notes['coral-stale']?.tags).toEqual(['coral']);
      expect(runtime.readIndex()?.notes['coral-fresh']?.tags).toEqual(['coral', 'kb']);
      expect(runtime.readIndexState()).toMatchObject({
        mutationSeq: 1,
      });
      expect(readCurateState(runtime).processedThrough).toEqual({
        note: 'coral-missing',
        mutationSeqAtPromote: 1,
      });
    });

    it('applies cleanup-time parent absorption using live tag support', async () => {
      writeNote('coral-parent-child', {
        title: 'Parent Child',
        tags: ['coral', 'stable-parent', 'stable-parent-child'],
        mutationSeqAtPromote: 1,
      });
      writeNote('coral-parent-one', {
        title: 'Parent One',
        tags: ['coral', 'stable-parent'],
        mutationSeqAtPromote: 2,
      });
      writeNote('coral-parent-two', {
        title: 'Parent Two',
        tags: ['coral', 'stable-parent'],
        mutationSeqAtPromote: 3,
      });
      runtime.writeIndex({
        notes: {
          'coral-parent-child': createIndexNote({
            title: 'Parent Child',
            tags: ['coral', 'stable-parent', 'stable-parent-child'],
            mutationSeqAtPromote: 1,
          }),
          'coral-parent-one': createIndexNote({
            title: 'Parent One',
            tags: ['coral', 'stable-parent'],
            mutationSeqAtPromote: 2,
          }),
          'coral-parent-two': createIndexNote({
            title: 'Parent Two',
            tags: ['coral', 'stable-parent'],
            mutationSeqAtPromote: 3,
          }),
        },
        principles: {},
      });

      await internals.commitMetadataTargets([{
        note: 'coral-parent-child',
        mutationSeqAtPromote: 1,
        claimTimeUpdatedAt: DEFAULT_UPDATED_AT,
        desiredTags: ['coral', 'stable-parent', 'stable-parent-child'],
        cleanup: true,
      }]);

      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-parent-child.md'), 'utf-8')).tags).toEqual([
        'coral',
        'stable-parent',
      ]);
      expect(runtime.readIndex()?.notes['coral-parent-child']?.tags).toEqual([
        'coral',
        'stable-parent',
      ]);
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

      await internals.recordDiscoveryAttempt(52, '2026-03-25');
      expect(readCurateState(runtime)).toMatchObject({
        lastDiscoveryCorpusSize: 52,
        lastDiscoveryDay: '2026-03-25',
      });

      await internals.addPendingDiscovery(entry);
      await internals.addPendingDiscovery(entry);
      expect(readCurateState(runtime).pendingDiscoveries).toEqual([entry]);

      await internals.removePendingDiscovery(entry);
      expect(readCurateState(runtime).pendingDiscoveries).toEqual([]);
    });

    it('persists failure and retry clearing through the standalone wrappers', async () => {
      writeCurateState(runtime, createCurateState({
        lastAttemptedThrough: {
          note: 'coral-retry',
          mutationSeqAtPromote: 9,
        },
        activeClaim: {
          through: {
            note: 'coral-retry',
            mutationSeqAtPromote: 9,
          },
          startedAt: '2026-03-25T11:58:00.000Z',
        },
        consecutiveFailures: 1,
      }));

      await internals.recordCurateFailure(null, new Error('Failed to spawn claude: ENOENT'));
      expect(readCurateState(runtime)).toMatchObject({
        lastAttemptedThrough: {
          note: 'coral-retry',
          mutationSeqAtPromote: 9,
        },
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
      const notes: KbIndex['notes'] = {};
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
          mutationSeqAtPromote: index,
          body: `Discovery body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Discovery ${index}`,
          mutationSeqAtPromote: index,
        });
      }

      runtime.writeIndex({ notes, principles: {} });
      writeCurateState(runtime, createCurateState({
        processedThrough: {
          note: 'coral-discovery-54',
          mutationSeqAtPromote: 54,
        },
        pendingDiscoveries,
      }));
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

      await internals.runPrincipleDiscovery({
        note: 'coral-discovery-54',
        mutationSeqAtPromote: 54,
      });

      expect(lockSpy).toHaveBeenCalledTimes(3);
      expect(readSpy).toHaveBeenCalledTimes(2);
      lockSpy.mockRestore();
      readSpy.mockRestore();

      expect(readCurateState(runtime)).toMatchObject({
        lastDiscoveryCorpusSize: 50,
        lastDiscoveryDay: '2026-03-25',
        pendingDiscoveries: [],
      });
      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-discovery-05.md'), 'utf-8')).principles).toEqual([
        'single-source-of-truth',
      ]);
      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-discovery-07.md'), 'utf-8')).principles).toEqual([
        'verify-at-boundaries',
      ]);
    });

    it('writes the KB gitignore block once and leaves it unchanged on a second runtime start', async () => {
      const gitignorePath = join(tempDir, '.gitignore');
      writeFileSync(gitignorePath, 'notes/\n', 'utf-8');

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      const afterFirstStart = readFileSync(gitignorePath, 'utf-8');
      expect(afterFirstStart).toContain('notes/\n');
      expect(afterFirstStart).toContain('# Coral KB runtime (device-local, auto-managed)\ncurate-state.json\ndata/\n');

      const secondRuntime = createKbRuntime({
        markdownRoot: tempDir,
        runtimeDir: tempDir,
      });
      const secondScheduler = createCurateScheduler({
        kb: secondRuntime,
        spawnCli: noopSpawnCli,
      });
      await secondScheduler.start();
      await settleCurateRuntime(secondScheduler);

      expect(readFileSync(gitignorePath, 'utf-8')).toBe(afterFirstStart);
    });

    it('runs cleanup successfully in a non-git KB root while removing cleanup tags', async () => {
      const notes: KbIndex['notes'] = {};
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
          mutationSeqAtPromote: spec.seq,
        });
        notes[spec.slug] = createIndexNote({
          title: spec.slug,
          tags: spec.tags,
          mutationSeqAtPromote: spec.seq,
        });
      }

      runtime.writeIndex({
        notes,
        principles: {},
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
      expect(runtime.readIndex()?.notes['coral-pattern-note']?.tags).toEqual(['coral']);
      expect(runtime.readIndex()?.notes['coral-parent-child']?.tags).toEqual(['coral', 'stable-parent']);
      expect(readCurateState(runtime).processedThrough).toEqual({
        note: 'coral-note-10',
        mutationSeqAtPromote: 10,
      });
    });

    it('throws a CurateJsonParseError when classification returns malformed JSON', async () => {
      useScheduler(async () => ({
        stdout: '[',
        stderr: '',
        code: 0,
        aborted: false,
      }));
      const claim = {
        notes: [
          buildClaimedNote({
            slug: 'coral-alpha',
            title: 'Alpha',
            mutationSeqAtPromote: 1,
          }),
        ],
        through: {
          note: 'coral-alpha',
          mutationSeqAtPromote: 1,
        },
      };

      await expect(internals.runClassificationBatches(claim, {
        notes: {
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            mutationSeqAtPromote: 1,
          }),
        },
        principles: {},
      })).rejects.toMatchObject({
        name: 'CurateJsonParseError',
        message: 'Curate classification returned invalid JSON.',
      });
    });

    it('throws a CurateJsonParseError when principle discovery returns malformed JSON', async () => {
      const notes: KbIndex['notes'] = {};

      for (let index = 1; index <= 50; index += 1) {
        const slug = `coral-discovery-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Discovery ${index}`,
          mutationSeqAtPromote: index,
          body: `Discovery body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Discovery ${index}`,
          mutationSeqAtPromote: index,
        });
      }

      runtime.writeIndex({ notes, principles: {} });
      writeCurateState(runtime, createCurateState({
        processedThrough: {
          note: 'coral-discovery-50',
          mutationSeqAtPromote: 50,
        },
      }));
      useScheduler(async () => ({
        stdout: '[',
        stderr: '',
        code: 0,
        aborted: false,
      }));

      await expect(internals.runPrincipleDiscovery({
        note: 'coral-discovery-50',
        mutationSeqAtPromote: 50,
      })).rejects.toMatchObject({
        name: 'CurateJsonParseError',
        message: 'Curate discovery returned invalid JSON.',
      });
    });

    it('records retry state from scheduled failures using the claimed through cursor', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const notes: KbIndex['notes'] = {};

      for (let index = 1; index <= 10; index += 1) {
        const slug = `coral-failure-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Failure ${index}`,
          mutationSeqAtPromote: index,
        });
        notes[slug] = createIndexNote({
          title: `Failure ${index}`,
          mutationSeqAtPromote: index,
        });
      }

      runtime.writeIndex({ notes, principles: {} });
      useScheduler(async () => ({
        stdout: '[',
        stderr: '',
        code: 0,
        aborted: false,
      }));

      await scheduler.start();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await Promise.resolve();
        if (readCurateState(runtime).consecutiveFailures === 1) {
          break;
        }
      }

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Curate classification returned invalid JSON.'));
      expect(readCurateState(runtime)).toMatchObject({
        lastAttemptedThrough: {
          note: 'coral-failure-10',
          mutationSeqAtPromote: 10,
        },
        activeClaim: null,
        consecutiveFailures: 1,
      });
      expect(readCurateState(runtime).retryNotBefore).not.toBeNull();
    });
  });
});
