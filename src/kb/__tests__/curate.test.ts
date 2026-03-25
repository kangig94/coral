import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClassificationAssignment,
  CurateClaimedNote,
  DiscoveryProposal,
} from '../curate.js';
import type { CurateState } from '../curate-state.js';
import type { KbIndex } from '../types.js';

const DEFAULT_CREATED_AT = '2026-03-20T00:00:00.000Z';
const DEFAULT_UPDATED_AT = '2026-03-20T00:00:00.000Z';

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

async function loadKbModules() {
  vi.resetModules();
  const [curate, detect, paths, frontmatter, curateState, curateTags] = await Promise.all([
    import('../curate.js'),
    import('../detect.js'),
    import('../paths.js'),
    import('../frontmatter.js'),
    import('../curate-state.js'),
    import('../curate-tags.js'),
  ]);
  return {
    curate,
    detect,
    paths,
    frontmatter,
    curateState,
    curateTags,
  };
}

function createKbContext(detect: Awaited<ReturnType<typeof loadKbModules>>['detect']) {
  const projectRoot = join(mockState.tmpHome, 'project');
  mkdirSync(projectRoot, { recursive: true });
  return detect.getKbContext({
    projectRoot,
    pluginRoot: '/plugin',
    coralEnv: {},
  });
}

function writeNote(
  paths: Pick<Awaited<ReturnType<typeof loadKbModules>>['paths'], 'notesDir'>,
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
  mkdirSync(paths.notesDir(), { recursive: true });
  const notePath = join(paths.notesDir(), `${slug}.md`);
  writeFileSync(notePath, renderNote(options), 'utf-8');
  return notePath;
}

async function settleCurateRuntime(
  curate: Pick<Awaited<ReturnType<typeof loadKbModules>>['curate'], 'curateRunActive'>,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await Promise.resolve();
    await Promise.resolve();
    if (!curate.curateRunActive()) {
      return;
    }
  }

  throw new Error('Curate runtime did not settle.');
}

describe('curate', () => {
  beforeEach(() => {
    mockState.tmpHome = mkdtempSync(join(tmpdir(), 'coral-kb-curate-'));
    process.env.CORAL_KB_PATH = join(mockState.tmpHome, 'vault');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (mockState.tmpHome) {
      rmSync(mockState.tmpHome, { recursive: true, force: true });
    }
    mockState.tmpHome = '';
    delete process.env.CORAL_KB_PATH;
    vi.resetModules();
  });

  describe('prompt building and response parsing', () => {
    it('builds a classification prompt with every note, tag, and principle', async () => {
      const { curate } = await loadKbModules();
      const prompt = curate.buildClassificationPrompt([
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

    it('parses classification responses from raw and code-fenced JSON arrays', async () => {
      const { curate } = await loadKbModules();
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

      expect(curate.parseClassificationResponse(raw, noteMap)).toEqual([
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
      expect(curate.parseClassificationResponse(`\`\`\`json\n${raw}\n\`\`\``, noteMap)).toEqual([
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

    it('returns an empty classification list for non-array JSON, malformed JSON, and malformed entries', async () => {
      const { curate } = await loadKbModules();
      const noteMap = new Map<string, true>([['coral-alpha', true]]);

      expect(curate.parseClassificationResponse('{"note":"coral-alpha"}', noteMap)).toEqual([]);
      expect(curate.parseClassificationResponse('[', noteMap)).toEqual([]);
      expect(curate.parseClassificationResponse(JSON.stringify([
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

    it('validates assignments by dropping unknown notes and principles while requiring new-tag support', async () => {
      const { curate } = await loadKbModules();
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

      expect(curate.validateAssignments(proposals, index, claimedNotes)).toEqual([
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

    it('builds a discovery prompt with note bodies truncated to five hundred characters', async () => {
      const { curate } = await loadKbModules();
      const longBody = 'x'.repeat(600);
      const prompt = curate.buildDiscoveryPrompt([
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

    it('parses discovery responses from raw and code-fenced JSON arrays and drops malformed entries', async () => {
      const { curate } = await loadKbModules();
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

      expect(curate.parseDiscoveryResponse(raw)).toEqual([
        {
          slug: 'stable-ownership',
          statement: 'Attach payloads to one owner.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
      ]);
      expect(curate.parseDiscoveryResponse(`\`\`\`json\n${raw}\n\`\`\``)).toEqual([
        {
          slug: 'stable-ownership',
          statement: 'Attach payloads to one owner.',
          notes: ['coral-alpha', 'coral-beta', 'coral-gamma'],
        },
      ]);
      expect(curate.parseDiscoveryResponse('{"slug":"not-an-array"}')).toEqual([]);
      expect(curate.parseDiscoveryResponse('[')).toEqual([]);
    });

    it('validates discovery proposals for slug uniqueness, eligibility, and minimum note support', async () => {
      const { curate } = await loadKbModules();
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

      expect(curate.validateDiscoveryProposals(proposals, eligibleNotes, ['existing-principle'])).toEqual([
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
      const { curate, detect, paths, curateState } = await loadKbModules();
      const kb = createKbContext(detect);

      writeNote(paths, 'coral-alpha', {
        title: 'Alpha',
        mutationSeqAtPromote: 1,
      });
      writeNote(paths, 'coral-beta', {
        title: 'Beta',
        mutationSeqAtPromote: 2,
      });
      detect.writeKbIndex({
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
      curateState.writeCurateState(createCurateState({
        processedThrough: {
          note: 'coral-beta',
          mutationSeqAtPromote: 2,
        },
      }));

      await expect(curate.claimCurateRun(kb, '2026-03-25')).resolves.toBeNull();
    });

    it('returns null when pending notes stay below the first-pass threshold', async () => {
      const { curate, detect, paths } = await loadKbModules();
      const kb = createKbContext(detect);
      const notes: KbIndex['notes'] = {};

      for (let index = 1; index <= 9; index += 1) {
        const slug = `coral-note-${String(index).padStart(2, '0')}`;
        writeNote(paths, slug, {
          title: `Note ${index}`,
          mutationSeqAtPromote: index,
          body: `Body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Note ${index}`,
          mutationSeqAtPromote: index,
        });
      }

      detect.writeKbIndex({ notes, principles: {} });

      await expect(curate.claimCurateRun(kb, '2026-03-25')).resolves.toBeNull();
    });

    it('claims a new-day cohort in mutation-sequence order', async () => {
      const { curate, detect, paths, curateState } = await loadKbModules();
      const kb = createKbContext(detect);
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
        writeNote(paths, slug, {
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

      detect.writeKbIndex({ notes, principles: {} });
      curateState.writeCurateState(createCurateState({
        lastRunDay: '2026-03-24',
      }));

      const claim = await curate.claimCurateRun(kb, '2026-03-25');

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
      expect(curateState.readCurateState()).toMatchObject({
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
      const { curate, detect, paths, curateState } = await loadKbModules();
      const kb = createKbContext(detect);
      const notes: KbIndex['notes'] = {};

      for (let index = 31; index >= 1; index -= 1) {
        const slug = `coral-note-${String(index).padStart(2, '0')}`;
        writeNote(paths, slug, {
          title: `Note ${index}`,
          mutationSeqAtPromote: index,
        });
        notes[slug] = createIndexNote({
          title: `Note ${index}`,
          mutationSeqAtPromote: index,
        });
      }

      detect.writeKbIndex({ notes, principles: {} });
      curateState.writeCurateState(createCurateState({
        lastRunDay: '2026-03-25',
      }));

      const claim = await curate.claimCurateRun(kb, '2026-03-25');

      expect(claim?.notes).toHaveLength(30);
      expect(claim?.notes[0]?.mutationSeqAtPromote).toBe(1);
      expect(claim?.notes[29]?.mutationSeqAtPromote).toBe(30);
      expect(claim?.through).toEqual({
        note: 'coral-note-30',
        mutationSeqAtPromote: 30,
      });
    });

    it('chunks notes at the requested batch size including edge cases', async () => {
      const { curate } = await loadKbModules();

      expect(curate.chunkNotes([], 10)).toEqual([]);
      expect(curate.chunkNotes(Array.from({ length: 10 }, (_, index) => index + 1), 10)).toEqual([
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      ]);
      expect(curate.chunkNotes(Array.from({ length: 11 }, (_, index) => index + 1), 10)).toEqual([
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        [11],
      ]);
    });
  });

  describe('metadata targets and commit', () => {
    it('builds metadata targets for every claimed note including no-op targets', async () => {
      const { curate } = await loadKbModules();
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

      expect(curate.buildMetadataTargets(assignments, index, claimedNotes)).toEqual([
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
      const { curate, detect, paths, frontmatter, curateState } = await loadKbModules();
      const kb = createKbContext(detect);
      const updatedAt = '2026-03-21T00:00:00.000Z';

      writeNote(paths, 'coral-alpha', {
        title: 'Alpha',
        tags: ['coral', 'existing-tag'],
        principles: ['existing-principle'],
        updatedAt,
        mutationSeqAtPromote: 4,
        body: 'Alpha body.',
      });
      detect.writeKbIndex({
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

      await curate.commitMetadataTargets(kb, [{
        note: 'coral-alpha',
        mutationSeqAtPromote: 4,
        claimTimeUpdatedAt: updatedAt,
        addTags: ['kb'],
        addPrinciples: ['deterministic-ordering'],
      }]);

      const raw = readFileSync(join(paths.notesDir(), 'coral-alpha.md'), 'utf-8');
      expect(frontmatter.parseFrontmatter(raw)).toEqual({
        tags: ['coral', 'existing-tag', 'kb'],
        principles: ['existing-principle', 'deterministic-ordering'],
        source: ['kangig94/coral'],
        createdAt: DEFAULT_CREATED_AT,
        updatedAt,
        mutationSeqAtPromote: 4,
      });
      expect(detect.readKbIndex()?.notes['coral-alpha']).toEqual({
        title: 'Alpha',
        tags: ['coral', 'existing-tag', 'kb'],
        principles: ['existing-principle', 'deterministic-ordering'],
        source: ['kangig94/coral'],
        createdAt: DEFAULT_CREATED_AT,
        updatedAt,
        mutationSeqAtPromote: 4,
      });
      expect(detect.readIndexState()).toMatchObject({
        mutationSeq: 1,
      });
      expect(curateState.readCurateState().processedThrough).toEqual({
        note: 'coral-alpha',
        mutationSeqAtPromote: 4,
      });
    });

    it('skips stale notes, advances past missing notes, and only commits safe writes', async () => {
      const { curate, detect, paths, frontmatter, curateState } = await loadKbModules();
      const kb = createKbContext(detect);

      writeNote(paths, 'coral-stale', {
        title: 'Stale',
        tags: ['coral'],
        updatedAt: '2026-03-22T00:00:00.000Z',
        mutationSeqAtPromote: 2,
      });
      writeNote(paths, 'coral-fresh', {
        title: 'Fresh',
        tags: ['coral'],
        updatedAt: '2026-03-23T00:00:00.000Z',
        mutationSeqAtPromote: 3,
      });
      detect.writeKbIndex({
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

      await curate.commitMetadataTargets(kb, [
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

      expect(existsSync(join(paths.notesDir(), 'coral-missing.md'))).toBe(false);
      expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-stale.md'), 'utf-8')).tags).toEqual([
        'coral',
      ]);
      expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-fresh.md'), 'utf-8')).tags).toEqual([
        'coral',
        'kb',
      ]);
      expect(detect.readKbIndex()?.notes['coral-stale']?.tags).toEqual(['coral']);
      expect(detect.readKbIndex()?.notes['coral-fresh']?.tags).toEqual(['coral', 'kb']);
      expect(detect.readIndexState()).toMatchObject({
        mutationSeq: 1,
      });
      expect(curateState.readCurateState().processedThrough).toEqual({
        note: 'coral-missing',
        mutationSeqAtPromote: 1,
      });
    });

    it('applies cleanup-time parent absorption using live tag support', async () => {
      const { curate, detect, paths, frontmatter } = await loadKbModules();
      const kb = createKbContext(detect);

      writeNote(paths, 'coral-parent-child', {
        title: 'Parent Child',
        tags: ['coral', 'stable-parent', 'stable-parent-child'],
        mutationSeqAtPromote: 1,
      });
      writeNote(paths, 'coral-parent-one', {
        title: 'Parent One',
        tags: ['coral', 'stable-parent'],
        mutationSeqAtPromote: 2,
      });
      writeNote(paths, 'coral-parent-two', {
        title: 'Parent Two',
        tags: ['coral', 'stable-parent'],
        mutationSeqAtPromote: 3,
      });
      detect.writeKbIndex({
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

      await curate.commitMetadataTargets(kb, [{
        note: 'coral-parent-child',
        mutationSeqAtPromote: 1,
        claimTimeUpdatedAt: DEFAULT_UPDATED_AT,
        desiredTags: ['coral', 'stable-parent', 'stable-parent-child'],
        cleanup: true,
      }]);

      expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-parent-child.md'), 'utf-8')).tags).toEqual([
        'coral',
        'stable-parent',
      ]);
      expect(detect.readKbIndex()?.notes['coral-parent-child']?.tags).toEqual([
        'coral',
        'stable-parent',
      ]);
    });
  });

  describe('runtime integration and errors', () => {
    it('writes the KB gitignore block once and leaves it unchanged on a second runtime start', async () => {
      mkdirSync(process.env.CORAL_KB_PATH!, { recursive: true });
      const gitignorePath = join(process.env.CORAL_KB_PATH!, '.gitignore');
      writeFileSync(gitignorePath, 'notes/\n', 'utf-8');

      const first = await loadKbModules();
      await first.curate.startCurateRuntime(createKbContext(first.detect));
      await settleCurateRuntime(first.curate);

      const afterFirstStart = readFileSync(gitignorePath, 'utf-8');
      expect(afterFirstStart).toContain('notes/\n');
      expect(afterFirstStart).toContain('# Coral KB runtime (device-local, auto-managed)\ncurate-state.json\ndata/\n');

      const second = await loadKbModules();
      await second.curate.startCurateRuntime(createKbContext(second.detect));
      await settleCurateRuntime(second.curate);

      expect(readFileSync(gitignorePath, 'utf-8')).toBe(afterFirstStart);
    });

    it('runs cleanup successfully in a non-git KB root while removing cleanup tags', async () => {
      const { curate, detect, paths, frontmatter, curateState } = await loadKbModules();
      const kb = createKbContext(detect);
      const notes: KbIndex['notes'] = {};
      const spawn = vi.fn(async () => ({
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
        writeNote(paths, spec.slug, {
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

      detect.writeKbIndex({
        notes,
        principles: {},
      });
      curate.setCurateSpawnFn(spawn);

      await curate.startCurateRuntime(kb);
      await settleCurateRuntime(curate);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-pattern-note.md'), 'utf-8')).tags).toEqual([
        'coral',
      ]);
      expect(frontmatter.parseFrontmatter(readFileSync(join(paths.notesDir(), 'coral-parent-child.md'), 'utf-8')).tags).toEqual([
        'coral',
        'stable-parent',
      ]);
      expect(detect.readKbIndex()?.notes['coral-pattern-note']?.tags).toEqual(['coral']);
      expect(detect.readKbIndex()?.notes['coral-parent-child']?.tags).toEqual(['coral', 'stable-parent']);
      expect(curateState.readCurateState().processedThrough).toEqual({
        note: 'coral-note-10',
        mutationSeqAtPromote: 10,
      });
    });

    it('throws a CurateJsonParseError when classification returns malformed JSON', async () => {
      const { curate, detect } = await loadKbModules();
      const kb = createKbContext(detect);
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

      curate.setCurateSpawnFn(async () => ({
        stdout: '[',
        stderr: '',
        code: 0,
        aborted: false,
      }));

      await expect(curate.runClassificationBatches(kb, claim, {
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
      const { curate, detect, paths, curateState } = await loadKbModules();
      const kb = createKbContext(detect);
      const notes: KbIndex['notes'] = {};

      for (let index = 1; index <= 50; index += 1) {
        const slug = `coral-discovery-${String(index).padStart(2, '0')}`;
        writeNote(paths, slug, {
          title: `Discovery ${index}`,
          mutationSeqAtPromote: index,
          body: `Discovery body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Discovery ${index}`,
          mutationSeqAtPromote: index,
        });
      }

      detect.writeKbIndex({ notes, principles: {} });
      curateState.writeCurateState(createCurateState({
        processedThrough: {
          note: 'coral-discovery-50',
          mutationSeqAtPromote: 50,
        },
      }));
      curate.setCurateSpawnFn(async () => ({
        stdout: '[',
        stderr: '',
        code: 0,
        aborted: false,
      }));

      await expect(curate.runPrincipleDiscovery(kb, detect.readKbIndex()!, {
        note: 'coral-discovery-50',
        mutationSeqAtPromote: 50,
      })).rejects.toMatchObject({
        name: 'CurateJsonParseError',
        message: 'Curate discovery returned invalid JSON.',
      });
    });

    it('records retry state from scheduled failures using the claimed through cursor', async () => {
      const { curate, detect, paths, curateState } = await loadKbModules();
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const notes: KbIndex['notes'] = {};

      for (let index = 1; index <= 10; index += 1) {
        const slug = `coral-failure-${String(index).padStart(2, '0')}`;
        writeNote(paths, slug, {
          title: `Failure ${index}`,
          mutationSeqAtPromote: index,
        });
        notes[slug] = createIndexNote({
          title: `Failure ${index}`,
          mutationSeqAtPromote: index,
        });
      }

      detect.writeKbIndex({ notes, principles: {} });
      curate.setCurateSpawnFn(async () => ({
        stdout: '[',
        stderr: '',
        code: 0,
        aborted: false,
      }));

      await curate.startCurateRuntime(createKbContext(detect));
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await Promise.resolve();
        if (curateState.readCurateState().consecutiveFailures === 1) {
          break;
        }
      }

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Curate classification returned invalid JSON.'));
      expect(curateState.readCurateState()).toMatchObject({
        lastAttemptedThrough: {
          note: 'coral-failure-10',
          mutationSeqAtPromote: 10,
        },
        activeClaim: null,
        consecutiveFailures: 1,
      });
      expect(curateState.readCurateState().retryNotBefore).not.toBeNull();
    });
  });
});
