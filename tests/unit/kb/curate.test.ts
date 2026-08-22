import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CorpusScanMod from '#src/kb/corpus/rescan/scan.js';
import * as curateState from '#src/kb/curate/state/index.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { createCurateScheduler, type CurateHandle, type RunCommunitySummaryJob } from '#src/kb/curate/scheduler.js';
import {
  buildClassificationPrompt,
  chunkEntriesByPromptBudget,
  takeClassificationBatchWithIndex,
} from '#src/kb/curate/classification/prompt.js';
import { buildMetadataTargets, validateAssignments } from '#src/kb/curate/classification/assignments.js';
import { parseClassificationResponse } from '#src/kb/curate/classification/parse.js';
import { buildDiscoveryPrompt, parseDiscoveryResponse, validateDiscoveryProposals } from '#src/kb/curate/discovery.js';
import type { ClassificationAssignment, CurateClaimedEntry, DiscoveryProposal } from '#src/kb/curate/pipeline-types.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { createCurateTestHandle, type CurateTestHandle } from '#tests/unit/kb/curate/__helpers__/test-handle.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { readCurateState, writeCurateState, type CurateState } from '#src/kb/curate/state/index.js';
import { readCurateRetryQueue, syncCurateRetryQueue } from '#src/kb/curate/retry.js';
import { parseCommunityFrontmatter, parseFrontmatter } from '#src/kb/corpus/frontmatter.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { applyBoundCorpusConsumerForTest, createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import {
  applyCommunitySummary,
  listStaleCommunities,
  readCommunitySummaryInput,
} from '#src/kb/curate/community/summary-surface.js';
import { bindOramaFtsForTest } from '#tests/unit/kb/expansion-test-helpers.js';
import {
  noteEntryId,
  sourceEntryId,
  type EntityGraph,
  type KbIndex,
  type NoteEntry,
  type SourceEntry,
} from '#src/kb/entry-types.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { curateDb } from '../../../src/kb/curate/db-access.js';

vi.mock('#src/kb/curate/usage-budget.js', () => ({
  isUsageBudgetExhausted: () => false,
}));

vi.mock('#src/kb/corpus/rescan/scan-worker.js', async () => {
  const actual = await vi.importActual<typeof CorpusScanMod>('#src/kb/corpus/rescan/scan.js');
  return {
    CORPUS_SCAN_WORKER_TIMEOUT_MS: 120_000,
    buildCorpusScanViewInWorker: vi.fn(async (...args: Parameters<typeof actual.buildCorpusScanView>) =>
      actual.buildCorpusScanView(...args),
    ),
  };
});

const DEFAULT_CREATED_AT = '2026-03-20T00:00:00.000Z';
const DEFAULT_UPDATED_AT = '2026-03-20T00:00:00.000Z';
const writableDbByRuntime = new WeakMap<KbRuntime, ReturnType<typeof createKbTestDb>>();

type NoteCurateClaimedEntry = Extract<CurateClaimedEntry, { kind: 'note' }>;

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

function cursor(note: string, _entrySeq: number) {
  return curateState.noteCursor(note, DEFAULT_CREATED_AT);
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
  inputFingerprint,
}: {
  title: string;
  tags?: string[];
  principles?: string[];
  source?: string[];
  createdAt?: string;
  updatedAt?: string;
  entrySeq?: number;
  body?: string;
  inputFingerprint?: string;
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
  type = 'reference',
  tags = ['source'],
  importedAt = DEFAULT_CREATED_AT,
  entrySeq,
  body = 'Source body.',
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

function createIndexNote({
  title,
  tags = ['coral'],
  principles = [],
  source = ['kangig94/coral'],
  createdAt = DEFAULT_CREATED_AT,
  updatedAt = DEFAULT_UPDATED_AT,
  entrySeq,
  body = 'Body.',
  inputFingerprint,
}: {
  title: string;
  tags?: string[];
  principles?: string[];
  source?: string[];
  createdAt?: string;
  updatedAt?: string;
  entrySeq?: number;
  body?: string;
  inputFingerprint?: string;
}): Omit<NoteEntry, 'kind' | 'slug'> {
  return {
    title,
    tags,
    principles,
    source,
    createdAt,
    updatedAt,
    bodyHash: computeBodySurfaceHash(body),
    ...(inputFingerprint === undefined ? {} : { inputFingerprint }),
    ...(entrySeq === undefined ? {} : { entrySeq }),
  };
}

function createIndexSource({
  title,
  type = 'reference',
  tags = ['source'],
  importedAt = DEFAULT_CREATED_AT,
  entrySeq,
  body = 'Source body.',
}: {
  title: string;
  type?: string;
  tags?: string[];
  importedAt?: string;
  entrySeq?: number;
  body?: string;
}): Omit<SourceEntry, 'kind' | 'slug'> {
  return {
    title,
    type,
    tags,
    importedAt,
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

function readIndexEntryTags(index: KbIndex | null | undefined, entryId: string): string[] | undefined {
  const entry = index?.entries[entryId];
  return entry !== undefined && 'tags' in entry ? entry.tags : undefined;
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
    cursor: cursor(slug, entrySeq),
  };
}

const noopCurateAssistant: CurateAssistantPort = {
  complete: async () => '[]',
};

function assistantFromText(stdout: string): CurateAssistantPort {
  return {
    complete: async () => stdout,
  };
}

function assistantFromComplete(complete: CurateAssistantPort['complete']): CurateAssistantPort {
  return { complete };
}

let tempDir: string;
let runtime: KbRuntime;
let scheduler: CurateHandle;
let internals: CurateTestHandle;
let gitSyncRuntime: ReturnType<typeof createRealRuntime>;
let originalClaudeConfigDir: string | undefined;

function useScheduler(
  curateAssistant: CurateAssistantPort = noopCurateAssistant,
  scheduleDebounceMs = 0,
  runCommunitySummaryJob?: RunCommunitySummaryJob,
): void {
  scheduler = createCurateScheduler({
    kb: runtime,
    curateAssistant,
    processPort: gitSyncRuntime.process,
    storagePort: gitSyncRuntime.storage,
    envPort: gitSyncRuntime.env,
    usageBudget: { isExhausted: async () => false },
    scheduleDebounceMs,
    ...(runCommunitySummaryJob === undefined ? {} : { runCommunitySummaryJob }),
  });
  internals = createCurateTestHandle({
    kb: runtime,
    curateAssistant,
    schedule: () => scheduler.schedule(),
  });
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
    inputFingerprint?: string;
  },
): string {
  mkdirSync(runtime.notesDir(), { recursive: true });
  const notePath = join(runtime.notesDir(), `${slug}.md`);
  writeFileSync(notePath, renderNote(options), 'utf-8');
  return notePath;
}

function writeSource(
  slug: string,
  options: {
    title: string;
    type?: string;
    tags?: string[];
    importedAt?: string;
    entrySeq?: number;
    body?: string;
  },
): string {
  mkdirSync(runtime.sourcesDir(), { recursive: true });
  const sourcePath = join(runtime.sourcesDir(), `${slug}.md`);
  writeFileSync(sourcePath, renderSource(options), 'utf-8');
  return sourcePath;
}

function generatedCommunityRecords() {
  return [...runtime.generatedCommunityProjectionStore.readActiveGeneration().records];
}

function generatedCommunityFrontmatters() {
  return generatedCommunityRecords().map((record) => parseCommunityFrontmatter(record.content));
}

async function settleCurateRuntime(handle: CurateHandle): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await vi.advanceTimersByTimeAsync(1);
    if (!handle.isRunning()) {
      return;
    }
  }

  throw new Error('Curate runtime did not settle.');
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-'));
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude-config');
  gitSyncRuntime = createRealRuntime('prod');
  const db = createKbTestDb(tempDir);
  ({ kb: runtime } = createKbTestRuntime({
    markdownRoot: tempDir,
    runtimeDir: tempDir,
    db,
    runtime: gitSyncRuntime,
    curateAssistant: noopCurateAssistant,
  }));
  writableDbByRuntime.set(runtime, db);
  bindOramaFtsForTest(runtime);
  useScheduler();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('curate', () => {
  describe('prompt building and response parsing', () => {
    it('builds a classification prompt with entity and relationship vocabularies plus the new response shape', () => {
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
        [
          {
            name: 'graph-rag',
            type: 'concept',
            description: 'Graph-backed retrieval.',
            relevant: true,
            support: 3,
          },
          {
            name: 'retrieval-pipeline',
            type: 'operation',
            description: 'Retrieval workflow orchestration.',
            relevant: false,
            support: 1,
          },
        ],
        ['contract-first-design', 'deterministic-ordering'],
      );

      expect(prompt).toContain('Entity type vocabulary:');
      expect(prompt).toContain('Relationship type vocabulary:');
      expect(prompt).toContain('Existing entity vocabulary:\n\n- graph-rag: concept (Graph-backed retrieval.)');
      expect(prompt).toContain('- retrieval-pipeline: operation');
      expect(prompt).toContain('Principle names:\n\n- contract-first-design\n- deterministic-ordering');
      expect(prompt).toContain('## note:coral-alpha\nAlpha\nAlpha body.');
      expect(prompt).toContain('## note:coral-beta\nBeta\nBeta body.');
      expect(prompt).toContain(
        '"newEntities": { "<entity-name>": { "type": "<entity-type>", "description": "<one sentence>" } }',
      );
      expect(prompt).toContain(
        '"relationships": [{ "source": "<entity-name>", "target": "<entity-name>", "type": "<relationship-type>", "description": "<one sentence>" }]',
      );
    });

    it('truncates oversized entity vocabularies under the prompt token budget', () => {
      const prompt = buildClassificationPrompt(
        [
          buildClaimedNote({
            slug: 'coral-alpha',
            title: 'Alpha',
            body: 'Alpha body.',
            entrySeq: 1,
          }),
        ],
        Array.from({ length: 500 }, (_, index) => ({
          name: `entity-${String(index).padStart(3, '0')}-descriptor`,
          type: 'concept' as const,
          description: 'A long description that exists only to consume prompt budget tokens.',
          relevant: true,
          support: 0,
        })),
        [],
      );

      expect(prompt).toContain('- entity-000-descriptor: concept');
      expect(prompt).not.toContain('- entity-499-descriptor: concept');
    });

    it('keeps indexed classification vocabulary ordered by relevance, support, then entity name', () => {
      const claimedEntries = [
        buildClaimedNote({
          slug: 'coral-alpha',
          title: 'Vector Store Guide',
          body: 'Vector storage explains retrieval.',
          entrySeq: 1,
        }),
        buildClaimedNote({
          slug: 'coral-beta',
          title: 'Archive',
          body: 'Archive only.',
          entrySeq: 2,
        }),
      ];
      const index: KbIndex = {
        entries: createIndexEntries({
          'coral-alpha': createIndexNote({
            title: 'Vector Store Guide',
            tags: ['retrieval'],
            entrySeq: 1,
          }),
          'support-alpha': createIndexNote({
            title: 'Support Alpha',
            tags: ['maintenance-history'],
            entrySeq: 3,
          }),
          'support-beta': createIndexNote({
            title: 'Support Beta',
            tags: ['maintenance-history'],
            entrySeq: 4,
          }),
          'support-gamma': createIndexNote({
            title: 'Support Gamma',
            tags: ['maintenance-history'],
            entrySeq: 5,
          }),
        }),
        principles: {},
        entityMeta: {
          'maintenance-history': {
            type: 'concept',
            description: 'Background material.',
          },
          'graph-rag': {
            type: 'concept',
            description: 'Graph-backed retrieval.',
          },
          retrieval: {
            type: 'operation',
            description: 'Retrieval workflows.',
          },
          'vector-store': {
            type: 'component',
            description: 'Vector storage.',
          },
        },
        relationships: [
          {
            source: 'graph-rag',
            target: 'retrieval',
            type: 'enables',
            description: 'Graph RAG enables retrieval.',
            evidence: ['note:coral-alpha', 'note:coral-beta'],
          },
        ],
      };

      const { batch, vocabulary } = takeClassificationBatchWithIndex(claimedEntries, index, [], 10);

      expect(batch.map((entry) => entry.entryId)).toEqual(['note:coral-alpha', 'note:coral-beta']);
      expect(
        vocabulary.map((entry) => ({
          name: entry.name,
          relevant: entry.relevant,
          support: entry.support,
        })),
      ).toEqual([
        { name: 'retrieval', relevant: true, support: 3 },
        { name: 'graph-rag', relevant: true, support: 2 },
        { name: 'vector-store', relevant: true, support: 0 },
        { name: 'maintenance-history', relevant: false, support: 3 },
      ]);
    });

    it('parses classification responses from raw and code-fenced JSON arrays with newEntities and relationships', () => {
      const entryMap = new Map<string, true>([
        [noteEntryId('coral-alpha'), true],
        [noteEntryId('coral-beta'), true],
      ]);
      const raw = JSON.stringify([
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['graph-rag', 'retrieval-pipeline'],
          principles: ['deterministic-ordering'],
          related: ['source:retrieval-paper'],
          newEntities: {
            'retrieval-pipeline': {
              type: 'operation',
              description: 'A retrieval pipeline.',
            },
          },
          relationships: [
            {
              source: 'graph-rag',
              target: 'retrieval-pipeline',
              type: 'enables',
              description: 'Graph RAG enables the retrieval pipeline.',
            },
          ],
        },
        {
          entry: noteEntryId('coral-beta'),
          tags: ['graph-rag'],
          principles: [],
        },
      ]);

      expect(parseClassificationResponse(raw, entryMap)).toEqual([
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['graph-rag', 'retrieval-pipeline'],
          principles: ['deterministic-ordering'],
          related: ['source:retrieval-paper'],
          newEntities: {
            'retrieval-pipeline': {
              type: 'operation',
              description: 'A retrieval pipeline.',
            },
          },
          relationships: [
            {
              source: 'graph-rag',
              target: 'retrieval-pipeline',
              type: 'enables',
              description: 'Graph RAG enables the retrieval pipeline.',
            },
          ],
        },
        {
          entry: noteEntryId('coral-beta'),
          tags: ['graph-rag'],
          principles: [],
        },
      ]);
      expect(parseClassificationResponse(`\`\`\`json\n${raw}\n\`\`\``, entryMap)).toEqual([
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['graph-rag', 'retrieval-pipeline'],
          principles: ['deterministic-ordering'],
          related: ['source:retrieval-paper'],
          newEntities: {
            'retrieval-pipeline': {
              type: 'operation',
              description: 'A retrieval pipeline.',
            },
          },
          relationships: [
            {
              source: 'graph-rag',
              target: 'retrieval-pipeline',
              type: 'enables',
              description: 'Graph RAG enables the retrieval pipeline.',
            },
          ],
        },
        {
          entry: noteEntryId('coral-beta'),
          tags: ['graph-rag'],
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
            {
              entry: noteEntryId('coral-missing'),
              tags: ['coral'],
              principles: [],
              newEntities: 'nope',
            },
            {
              entry: noteEntryId('coral-alpha'),
              tags: ['coral'],
              principles: [],
              relationships: [{ source: 'coral', target: 'coral', type: 'bad-type', description: '' }],
            },
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

    it('validates assignments with sparse entity admission, structural quality gates, and relationship endpoint checks', () => {
      const index: KbIndex = {
        entries: createIndexEntries({
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            tags: ['coral', 'graph-rag'],
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
        entityMeta: {
          coral: {
            type: 'domain',
            description: 'Coral domain.',
          },
          'graph-rag': {
            type: 'concept',
            description: 'Graph-backed retrieval.',
          },
        },
        relationships: [],
      };
      const claimedNotes = [
        buildClaimedNote({ slug: 'coral-alpha', title: 'Alpha', entrySeq: 1 }),
        buildClaimedNote({ slug: 'coral-beta', title: 'Beta', entrySeq: 2 }),
        buildClaimedNote({ slug: 'coral-gamma', title: 'Gamma', entrySeq: 3 }),
      ];
      const proposals: ClassificationAssignment[] = [
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['coral', 'graph-rag', 'retrieval-pipeline', 'sparse-entity'],
          principles: ['deterministic-ordering', 'unknown-principle'],
          newEntities: {
            'retrieval-pipeline': {
              type: 'operation',
              description: 'A retrieval pipeline.',
            },
            'sparse-entity': {
              type: 'concept',
              description: 'A sparse but valid entity.',
            },
          },
          relationships: [
            {
              source: 'graph-rag',
              target: 'retrieval-pipeline',
              type: 'enables',
              description: 'Graph RAG enables the retrieval pipeline.',
            },
            {
              source: 'graph-rag',
              target: 'missing-endpoint',
              type: 'enables',
              description: 'Invalid endpoints must be dropped.',
            },
          ],
        },
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['coral', 'retrieval-pipeline', 'graph-rag'],
          principles: ['deterministic-ordering'],
        },
        {
          entry: noteEntryId('coral-beta'),
          tags: ['coral', 'bad-entity', 'single'],
          principles: [],
          newEntities: {
            'bad-entity': {
              type: 'invalid-type' as never,
              description: 'Bad type.',
            },
            single: {
              type: 'concept',
              description: 'One segment should be dropped.',
            },
          },
        },
        {
          entry: noteEntryId('coral-gamma'),
          tags: ['coral', 'empty-description'],
          principles: ['unknown-principle'],
          newEntities: {
            'empty-description': {
              type: 'concept',
              description: '   ',
            },
          },
        },
        {
          entry: noteEntryId('coral-outside'),
          tags: ['retrieval-pipeline'],
          principles: ['deterministic-ordering'],
        },
      ];

      expect(validateAssignments(proposals, index, claimedNotes)).toEqual([
        {
          entry: noteEntryId('coral-alpha'),
          tags: ['coral', 'graph-rag', 'retrieval-pipeline', 'sparse-entity'],
          principles: ['deterministic-ordering'],
          newEntities: {
            'retrieval-pipeline': {
              type: 'operation',
              description: 'A retrieval pipeline.',
            },
            'sparse-entity': {
              type: 'concept',
              description: 'A sparse but valid entity.',
            },
          },
          relationships: [
            {
              source: 'graph-rag',
              target: 'retrieval-pipeline',
              type: 'enables',
              description: 'Graph RAG enables the retrieval pipeline.',
            },
          ],
        },
        {
          entry: noteEntryId('coral-beta'),
          tags: ['coral'],
          principles: [],
        },
        {
          entry: noteEntryId('coral-gamma'),
          tags: ['coral'],
          principles: [],
        },
      ]);
    });

    it('builds a discovery prompt with corpus file, truncated note bodies, and merge/refine instructions', () => {
      const longBody = 'x'.repeat(5000);
      const realRuntime = createRealRuntime('prod');
      const { prompt, corpusPath } = buildDiscoveryPrompt(
        { storagePort: realRuntime.storage, ids: realRuntime.ids, envPort: realRuntime.env },
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
      expect(statSync(corpusPath).mode & 0o777).toBe(0o600);
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
        entityMeta: {},
        relationships: [],
      });
      writeCurateState(
        curateDb(runtime),
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

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {}, entityMeta: {}, relationships: [] });

      await expect(internals.claimCurateRun('2026-03-25')).resolves.toBeNull();
    });

    it('uses the repair frontier for threshold checks before claiming', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};

      for (let index = 1; index <= 10; index += 1) {
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

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {}, entityMeta: {}, relationships: [] });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          lastRunDay: '2026-03-24',
        }),
      );
      syncCurateRetryQueue(curateDb(runtime), [
        {
          entryId: noteEntryId('coral-note-05'),
          entrySeq: 5,
          detectedAt: '2026-03-25T11:59:00.000Z',
        },
      ]);

      await expect(internals.claimCurateRun('2026-03-25')).resolves.toBeNull();
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        activeClaim: null,
        lastAttemptedThrough: null,
      });
    });

    it('claims a new-day cohort in content-cursor order', async () => {
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

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {}, entityMeta: {}, relationships: [] });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          lastRunDay: '2026-03-24',
        }),
      );

      const claim = await internals.claimCurateRun('2026-03-25');

      expect(claim).not.toBeNull();
      expect(claim?.entries.map((note) => note.entrySeq)).toEqual([8, 5, 4, 9, 1, 7, 6, 10, 3, 2]);
      expect(claim?.entries.map((note) => note.slug)).toEqual([
        'coral-eight',
        'coral-five',
        'coral-four',
        'coral-nine',
        'coral-one',
        'coral-seven',
        'coral-six',
        'coral-ten',
        'coral-three',
        'coral-two',
      ]);
      expect(claim?.through).toEqual(cursor('coral-two', 2));
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        lastRunDay: '2026-03-25',
        lastAttemptedThrough: cursor('coral-two', 2),
        activeClaim: {
          through: cursor('coral-two', 2),
        },
      });
    });

    it('orders pending notes and sources by timestamp, kind, and slug rather than entrySeq', async () => {
      const timestamp = '2026-03-20T00:00:00.000Z';
      const entries: KbIndex['entries'] = {};

      for (const [slug, seq] of [
        ['source-e', 1],
        ['source-d', 2],
        ['source-c', 3],
        ['source-b', 4],
        ['source-a', 5],
      ] as const) {
        writeSource(slug, {
          title: slug,
          importedAt: timestamp,
          entrySeq: seq,
          body: `${slug} body.`,
        });
        entries[sourceEntryId(slug)] = {
          kind: 'source',
          slug,
          ...createIndexSource({
            title: slug,
            importedAt: timestamp,
            entrySeq: seq,
            body: `${slug} body.`,
          }),
        };
      }

      for (const [slug, seq] of [
        ['coral-e', 10],
        ['coral-d', 9],
        ['coral-c', 8],
        ['coral-b', 7],
        ['coral-a', 6],
      ] as const) {
        writeNote(slug, {
          title: slug,
          createdAt: timestamp,
          updatedAt: timestamp,
          entrySeq: seq,
          body: `${slug} body.`,
        });
        entries[noteEntryId(slug)] = {
          kind: 'note',
          slug,
          ...createIndexNote({
            title: slug,
            createdAt: timestamp,
            updatedAt: timestamp,
            entrySeq: seq,
            body: `${slug} body.`,
          }),
        };
      }

      runtime.writeIndex({ entries, principles: {}, entityMeta: {}, relationships: [] });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          lastRunDay: '2026-03-24',
        }),
      );

      const claim = await internals.claimCurateRun('2026-03-25');

      expect(claim?.entries.map((entry) => entry.entryId)).toEqual([
        noteEntryId('coral-a'),
        noteEntryId('coral-b'),
        noteEntryId('coral-c'),
        noteEntryId('coral-d'),
        noteEntryId('coral-e'),
        sourceEntryId('source-a'),
        sourceEntryId('source-b'),
        sourceEntryId('source-c'),
        sourceEntryId('source-d'),
        sourceEntryId('source-e'),
      ]);
      expect(claim?.through).toEqual(curateState.sourceCursor('source-e', timestamp));
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

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {}, entityMeta: {}, relationships: [] });
      writeCurateState(
        curateDb(runtime),
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
        entityMeta: {},
        relationships: [],
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
          entryId: noteEntryId('coral-alpha'),
          slug: 'coral-alpha',
          entrySeq: 2,
          cursor: cursor('coral-alpha', 2),
          claimTimeUpdatedAt: '2026-03-22T00:00:00.000Z',
          desiredTags: ['coral', 'kb'],
          addPrinciples: ['deterministic-ordering'],
        },
        {
          kind: 'note',
          entryId: noteEntryId('coral-beta'),
          slug: 'coral-beta',
          entrySeq: 1,
          cursor: cursor('coral-beta', 1),
          claimTimeUpdatedAt: '2026-03-23T00:00:00.000Z',
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
        entityMeta: {},
        relationships: [],
      });

      await internals.commitMetadataTargets([
        {
          kind: 'note',
          entryId: noteEntryId('coral-alpha'),
          slug: 'coral-alpha',
          entrySeq: 4,
          cursor: cursor('coral-alpha', 4),
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
        inputFingerprint: computeBodySurfaceHash('Alpha body.'),
        related: [],
        entrySeq: 4,
      });
      expect(runtime.readIndex()?.entries[noteEntryId('coral-alpha')]).toEqual({
        kind: 'note',
        slug: 'coral-alpha',
        title: 'Alpha',
        bodyHash: computeBodySurfaceHash('Alpha body.'),
        tags: ['coral', 'existing-tag', 'kb'],
        principles: ['existing-principle', 'deterministic-ordering'],
        source: ['kangig94/coral'],
        createdAt: DEFAULT_CREATED_AT,
        updatedAt,
        inputFingerprint: computeBodySurfaceHash('Alpha body.'),
        related: [],
        entrySeq: 4,
      });
      expect(runtime.readIndexState()).toMatchObject({
        contentSeq: 0,
        metadataSeq: 1,
      });
      expect(readCurateState(curateDb(runtime)).processedThrough).toEqual(cursor('coral-alpha', 4));
    });

    it('does not publish prepared metadata writes when a later target fails validation', async () => {
      const updatedAt = '2026-03-21T00:00:00.000Z';
      const alphaPath = writeNote('coral-alpha', {
        title: 'Alpha',
        tags: ['coral'],
        updatedAt,
        entrySeq: 4,
        body: 'Alpha body.',
      });
      const zetaPath = join(runtime.notesDir(), 'coral-zeta.md');
      writeFileSync(
        zetaPath,
        [
          '---',
          'tags: [coral',
          'principles: []',
          'source:',
          '  - kangig94/coral',
          `createdAt: ${DEFAULT_CREATED_AT}`,
          `updatedAt: ${updatedAt}`,
          'entrySeq: 5',
          '---',
          '# Zeta',
          '',
          'Malformed frontmatter.',
        ].join('\n'),
        'utf-8',
      );
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-alpha': createIndexNote({
            title: 'Alpha',
            tags: ['coral'],
            updatedAt,
            entrySeq: 4,
          }),
        }),
        principles: {},
        entityMeta: {},
        relationships: [],
      });
      const originalAlphaRaw = readFileSync(alphaPath, 'utf-8');
      const originalIndex = runtime.readIndex();
      const originalState = readCurateState(curateDb(runtime));

      await expect(
        internals.commitMetadataTargets([
          {
            kind: 'note',
            entryId: noteEntryId('coral-alpha'),
            slug: 'coral-alpha',
            entrySeq: 4,
            cursor: cursor('coral-alpha', 4),
            claimTimeUpdatedAt: updatedAt,
            addTags: ['kb'],
          },
          {
            kind: 'note',
            entryId: noteEntryId('coral-zeta'),
            slug: 'coral-zeta',
            entrySeq: 5,
            cursor: cursor('coral-zeta', 5),
            claimTimeUpdatedAt: updatedAt,
            addTags: ['kb'],
          },
        ]),
      ).rejects.toThrow(/YAML parse error/);

      expect(readFileSync(alphaPath, 'utf-8')).toBe(originalAlphaRaw);
      expect(runtime.readIndex()).toEqual(originalIndex);
      expect(readCurateState(curateDb(runtime))).toEqual(originalState);
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
        entityMeta: {},
        relationships: [],
      });

      await internals.commitMetadataTargets([
        {
          kind: 'note',
          entryId: noteEntryId('coral-fresh'),
          slug: 'coral-fresh',
          entrySeq: 3,
          cursor: cursor('coral-fresh', 3),
          claimTimeUpdatedAt: '2026-03-23T00:00:00.000Z',
          addTags: ['kb'],
        },
        {
          kind: 'note',
          entryId: noteEntryId('coral-stale'),
          slug: 'coral-stale',
          entrySeq: 2,
          cursor: cursor('coral-stale', 2),
          claimTimeUpdatedAt: '2026-03-21T00:00:00.000Z',
          addTags: ['kb'],
        },
        {
          kind: 'note',
          entryId: noteEntryId('coral-missing'),
          slug: 'coral-missing',
          entrySeq: 1,
          cursor: cursor('coral-missing', 1),
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
      expect(readIndexEntryTags(runtime.readIndex(), noteEntryId('coral-stale'))).toEqual(['coral']);
      expect(readIndexEntryTags(runtime.readIndex(), noteEntryId('coral-fresh'))).toEqual(['coral', 'kb']);
      expect(runtime.readIndexState()).toMatchObject({
        contentSeq: 0,
        metadataSeq: 1,
      });
      expect(readCurateState(curateDb(runtime)).processedThrough).toEqual(cursor('coral-missing', 1));
    });

    it('does not write or advance past the repair frontier during metadata commits', async () => {
      const safeCursor = curateState.noteCursor('coral-safe', '2026-03-20T00:00:04.000Z');
      const blockedCursor = curateState.noteCursor('coral-blocked', '2026-03-20T00:00:06.000Z');
      writeNote('coral-safe', {
        title: 'Safe',
        tags: ['coral'],
        createdAt: safeCursor.timestamp,
        updatedAt: '2026-03-21T00:00:00.000Z',
        entrySeq: 4,
      });
      writeNote('coral-blocked', {
        title: 'Blocked',
        tags: ['coral'],
        createdAt: blockedCursor.timestamp,
        updatedAt: '2026-03-22T00:00:00.000Z',
        entrySeq: 6,
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-safe': createIndexNote({
            title: 'Safe',
            tags: ['coral'],
            createdAt: safeCursor.timestamp,
            updatedAt: '2026-03-21T00:00:00.000Z',
            entrySeq: 4,
          }),
          'coral-blocked': createIndexNote({
            title: 'Blocked',
            tags: ['coral'],
            createdAt: blockedCursor.timestamp,
            updatedAt: '2026-03-22T00:00:00.000Z',
            entrySeq: 6,
          }),
        }),
        principles: {},
        entityMeta: {},
        relationships: [],
      });
      writeCurateState(curateDb(runtime), createCurateState());
      syncCurateRetryQueue(curateDb(runtime), [
        {
          entryId: noteEntryId('coral-frontier'),
          entrySeq: 5,
          detectedAt: '2026-03-25T11:59:00.000Z',
        },
      ]);

      await internals.commitMetadataTargets([
        {
          kind: 'note',
          entryId: noteEntryId('coral-safe'),
          slug: 'coral-safe',
          entrySeq: 4,
          cursor: safeCursor,
          claimTimeUpdatedAt: '2026-03-21T00:00:00.000Z',
          addTags: ['kb'],
        },
        {
          kind: 'note',
          entryId: noteEntryId('coral-blocked'),
          slug: 'coral-blocked',
          entrySeq: 6,
          cursor: blockedCursor,
          claimTimeUpdatedAt: '2026-03-22T00:00:00.000Z',
          addTags: ['kb'],
        },
      ]);

      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-safe.md'), 'utf-8')).tags).toEqual([
        'coral',
        'kb',
      ]);
      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-blocked.md'), 'utf-8')).tags).toEqual([
        'coral',
      ]);
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        processedThrough: safeCursor,
      });
      expect(readCurateRetryQueue(curateDb(runtime))).toMatchObject([
        {
          entryId: noteEntryId('coral-frontier'),
          entrySeq: 5,
          detectedAt: '2026-03-25T11:59:00.000Z',
        },
      ]);
    });

    it('applies desiredTags exactly when committing note metadata', async () => {
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
        entityMeta: {},
        relationships: [],
      });

      await internals.commitMetadataTargets([
        {
          kind: 'note',
          entryId: noteEntryId('coral-parent-child'),
          slug: 'coral-parent-child',
          entrySeq: 1,
          claimTimeUpdatedAt: DEFAULT_UPDATED_AT,
          desiredTags: ['coral', 'stable-parent', 'stable-parent-child'],
        },
      ]);

      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-parent-child.md'), 'utf-8')).tags).toEqual([
        'coral',
        'stable-parent',
        'stable-parent-child',
      ]);
      expect(readIndexEntryTags(runtime.readIndex(), noteEntryId('coral-parent-child'))).toEqual([
        'coral',
        'stable-parent',
        'stable-parent-child',
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
        entityMeta: {},
        relationships: [],
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
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        discoveryHighSeq: 52,
        discoveryOffset: 0,
      });

      await internals.addPendingDiscovery(entry);
      await internals.addPendingDiscovery(entry);
      expect(readCurateState(curateDb(runtime)).pendingDiscoveries).toEqual([entry]);

      await internals.removePendingDiscovery(entry);
      expect(readCurateState(curateDb(runtime)).pendingDiscoveries).toEqual([]);
    });

    it('persists failure and retry clearing through the standalone wrappers', async () => {
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          lastAttemptedThrough: cursor('coral-retry', 9),
          activeClaim: {
            through: cursor('coral-retry', 9),
            startedAt: '2026-03-25T11:58:00.000Z',
          },
          consecutiveClaimFailures: 1,
        }),
      );

      await internals.recordCurateFailure(null, new Error('Failed to spawn claude: ENOENT'));
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        lastAttemptedThrough: cursor('coral-retry', 9),
        retryNotBefore: '2026-03-25T16:00:00.000Z',
        activeClaim: null,
        consecutiveClaimFailures: 2,
      });

      await internals.clearCurateRetryState();
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        retryNotBefore: null,
        activeClaim: null,
        consecutiveClaimFailures: 0,
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

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {}, entityMeta: {}, relationships: [] });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          processedThrough: cursor('coral-discovery-54', 54),
          pendingDiscoveries,
        }),
      );
      useScheduler(
        assistantFromText(
          JSON.stringify([
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
        ),
      );

      const lockSpy = vi.spyOn(runtime, 'withMutationLock');
      const readSpy = vi.spyOn(curateState, 'readCurateState');

      await internals.runPrincipleDiscovery(cursor('coral-discovery-54', 54));

      expect(lockSpy).toHaveBeenCalledTimes(2);
      expect(readSpy).toHaveBeenCalledTimes(3);
      lockSpy.mockRestore();
      readSpy.mockRestore();

      expect(readCurateState(curateDb(runtime))).toMatchObject({
        pendingDiscoveries: [],
      });
      expect(
        parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-discovery-05.md'), 'utf-8')).principles,
      ).toEqual(['single-source-of-truth']);
      expect(
        parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-discovery-07.md'), 'utf-8')).principles,
      ).toEqual(['verify-at-boundaries']);
    });

    it('replays a rewound discovery frontier even below the normal threshold', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};

      for (let index = 1; index <= 10; index += 1) {
        const slug = `coral-replay-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Replay ${index}`,
          entrySeq: index,
          body: `Replay body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Replay ${index}`,
          entrySeq: index,
        });
      }

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {}, entityMeta: {}, relationships: [] });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          processedThrough: cursor('coral-replay-10', 10),
          discoveryHighSeq: 4,
        }),
      );
      const spawn = vi.fn<CurateAssistantPort['complete']>(async () =>
        JSON.stringify([
          {
            slug: 'replayed-principle',
            statement: 'Replay rewound note ranges when discovery falls behind.',
            notes: ['coral-replay-05', 'coral-replay-06', 'coral-replay-07'],
          },
        ]),
      );
      useScheduler(assistantFromComplete(spawn));

      await internals.runPrincipleDiscovery(cursor('coral-replay-10', 10));

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        discoveryHighSeq: 10,
      });
      expect(
        parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-replay-05.md'), 'utf-8')).principles,
      ).toEqual(['replayed-principle']);
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
        entityMeta: {},
        relationships: [],
      });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          processedThrough: cursor('coral-discovery-50', 50),
        }),
      );
      useScheduler(
        assistantFromText(
          JSON.stringify([
            {
              slug: 'single-source-of-truth',
              statement: 'Keep one canonical representation for each fact.',
              notes: ['coral-discovery-05', 'coral-discovery-06', 'coral-discovery-07'],
            },
          ]),
        ),
      );

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
      expect(readCurateState(curateDb(runtime)).pendingDiscoveries).toEqual([]);
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
        entityMeta: {},
        relationships: [],
      });
      writeCurateState(
        curateDb(runtime),
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
      useScheduler(
        assistantFromText(
          JSON.stringify([
            {
              slug: 'payload-attachment-to-owner',
              statement: 'Attach payloads to exactly one owner.',
              notes: ['coral-discovery-05', 'coral-discovery-06', 'coral-discovery-07'],
              absorbs: ['single-owner'],
            },
          ]),
        ),
      );

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
      expect(readCurateState(curateDb(runtime)).pendingDiscoveries).toEqual([]);
    });

    it('re-reads and preserves fresh repair state when discovery resumes after the LLM await', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};

      for (let index = 1; index <= 50; index += 1) {
        const slug = `coral-stale-${String(index).padStart(2, '0')}`;
        writeNote(slug, {
          title: `Stale ${index}`,
          entrySeq: index,
          body: `Stale body ${index}.`,
        });
        notes[slug] = createIndexNote({
          title: `Stale ${index}`,
          entrySeq: index,
        });
      }

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {}, entityMeta: {}, relationships: [] });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          processedThrough: cursor('coral-stale-50', 50),
        }),
      );

      const spawnStarted = createDeferred<void>();
      const releaseSpawn = createDeferred<void>();
      useScheduler(
        assistantFromComplete(async () => {
          spawnStarted.resolve();
          await releaseSpawn.promise;
          return JSON.stringify([
            {
              slug: 'stale-batch-principle',
              statement: 'Do not persist pre-await curate snapshots.',
              notes: ['coral-stale-05', 'coral-stale-06', 'coral-stale-07'],
            },
          ]);
        }),
      );

      const discoveryPromise = internals.runPrincipleDiscovery(cursor('coral-stale-50', 50));
      await spawnStarted.promise;

      const pendingDiscovery = {
        principle: 'existing-pending-principle',
        statement: 'Preserve fresh pending discoveries.',
        notes: ['coral-stale-01'],
        createdAt: '2026-03-25T11:58:00.000Z',
      };
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          processedThrough: cursor('coral-stale-10', 10),
          discoveryHighSeq: 9,
          pendingDiscoveries: [pendingDiscovery],
        }),
      );
      syncCurateRetryQueue(curateDb(runtime), [
        {
          entryId: noteEntryId('coral-stale-11'),
          entrySeq: 11,
          detectedAt: '2026-03-25T11:59:00.000Z',
        },
      ]);

      releaseSpawn.resolve();
      await discoveryPromise;

      expect(existsSync(runtime.principlePath('stale-batch-principle'))).toBe(false);
      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-stale-05.md'), 'utf-8')).principles).toEqual(
        [],
      );
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        processedThrough: cursor('coral-stale-10', 10),
        discoveryHighSeq: 9,
        discoveryOffset: 0,
        pendingDiscoveries: [pendingDiscovery],
      });
      expect(readCurateRetryQueue(curateDb(runtime))).toMatchObject([
        {
          entryId: noteEntryId('coral-stale-11'),
          entrySeq: 11,
          detectedAt: '2026-03-25T11:59:00.000Z',
        },
      ]);
    });

    it('invokes the injected runCommunitySummaryJob during the curate community subphase', async () => {
      const runCommunitySummaryJob = vi.fn(async (_signal: AbortSignal) => false);
      useScheduler(noopCurateAssistant, 0, runCommunitySummaryJob);

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      expect(runCommunitySummaryJob).toHaveBeenCalled();
      expect(runCommunitySummaryJob.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    });

    it('writes the KB gitignore block once and leaves it unchanged on a second runtime start', async () => {
      const gitignorePath = join(tempDir, '.gitignore');
      writeFileSync(gitignorePath, 'notes/\n', 'utf-8');

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      const afterFirstStart = readFileSync(gitignorePath, 'utf-8');
      expect(afterFirstStart).toContain('notes/\n');
      expect(afterFirstStart).toContain('# Coral KB runtime (device-local, auto-managed)\ndata/\n');

      const secondDb = createKbTestDb(tempDir);
      const { kb: secondRuntime } = createKbTestRuntime({
        markdownRoot: tempDir,
        runtimeDir: tempDir,
        db: secondDb,
        runtime: gitSyncRuntime,
        curateAssistant: noopCurateAssistant,
      });
      writableDbByRuntime.set(secondRuntime, secondDb);
      const secondScheduler = createCurateScheduler({
        kb: secondRuntime,
        curateAssistant: noopCurateAssistant,
        processPort: gitSyncRuntime.process,
        storagePort: gitSyncRuntime.storage,
        envPort: gitSyncRuntime.env,
        usageBudget: { isExhausted: async () => false },
        scheduleDebounceMs: 0,
      });
      await secondScheduler.start();
      await settleCurateRuntime(secondScheduler);

      expect(readFileSync(gitignorePath, 'utf-8')).toBe(afterFirstStart);
    });

    it('runs successfully in a non-git KB root without rewriting tags when classification returns no assignments', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};
      const spawn = vi.fn<CurateAssistantPort['complete']>(async () => '[]');

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
        entityMeta: {},
        relationships: [],
      });
      writeCurateState(curateDb(runtime), {
        ...readCurateState(curateDb(runtime)),
        initialized: true,
      });
      useScheduler(assistantFromComplete(spawn));

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-pattern-note.md'), 'utf-8')).tags).toEqual([
        'coral',
        'isolated-pattern',
      ]);
      expect(parseFrontmatter(readFileSync(join(runtime.notesDir(), 'coral-parent-child.md'), 'utf-8')).tags).toEqual([
        'coral',
        'stable-parent',
        'stable-parent-child',
      ]);
      expect(readIndexEntryTags(runtime.readIndex(), noteEntryId('coral-pattern-note'))).toEqual([
        'coral',
        'isolated-pattern',
      ]);
      expect(readIndexEntryTags(runtime.readIndex(), noteEntryId('coral-parent-child'))).toEqual([
        'coral',
        'stable-parent',
        'stable-parent-child',
      ]);
      expect(readCurateState(curateDb(runtime)).processedThrough).toEqual(cursor('coral-pattern-note', 1));
    });

    it('does not re-classify a peer-classified note when inputFingerprint matches bodyHash', async () => {
      const body = 'Peer classified body.';
      const inputFingerprint = computeBodySurfaceHash(body);
      const spawn = vi.fn<CurateAssistantPort['complete']>(async () => {
        throw new Error('classification should be skipped');
      });

      writeNote('coral-peer-classified', {
        title: 'Peer Classified',
        tags: ['coral', 'peer-classified'],
        inputFingerprint,
        entrySeq: 2,
        body,
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-peer-classified': createIndexNote({
            title: 'Peer Classified',
            tags: ['coral', 'peer-classified'],
            inputFingerprint,
            entrySeq: 2,
            body,
          }),
        }),
        principles: {},
        entityMeta: {
          coral: { type: 'domain', description: 'Coral domain.' },
          'peer-classified': { type: 'concept', description: 'Peer-provided classification.' },
        },
        relationships: [],
      });
      writeCurateState(curateDb(runtime), createCurateState({ initialized: true }));
      useScheduler(assistantFromComplete(spawn));

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      expect(spawn).not.toHaveBeenCalled();
    });

    it('re-classifies a note after the body changes and stamps the current inputFingerprint', async () => {
      const oldBody = 'Original classified body.';
      const editedBody = 'Edited classified body.';
      const oldFingerprint = computeBodySurfaceHash(oldBody);
      const expectedFingerprint = computeBodySurfaceHash(editedBody);
      const spawn = vi.fn<CurateAssistantPort['complete']>(async (request) =>
        request.purpose === 'classification'
          ? JSON.stringify([
              {
                entry: noteEntryId('coral-edited-body'),
                tags: ['edited-body'],
                newEntities: {
                  'edited-body': {
                    type: 'concept',
                    description: 'Edited body classification.',
                  },
                },
              },
            ])
          : '[]',
      );

      writeNote('coral-edited-body', {
        title: 'Edited Body',
        tags: ['coral'],
        inputFingerprint: oldFingerprint,
        entrySeq: 2,
        body: editedBody,
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-edited-body': createIndexNote({
            title: 'Edited Body',
            tags: ['coral'],
            inputFingerprint: oldFingerprint,
            entrySeq: 2,
            body: editedBody,
          }),
        }),
        principles: {},
        entityMeta: {
          coral: { type: 'domain', description: 'Coral domain.' },
          'edited-body': { type: 'concept', description: 'Edited body classification.' },
        },
        relationships: [],
      });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          initialized: true,
          lastAttemptedThrough: cursor('coral-prior', 1),
          retryNotBefore: '2026-03-25T11:00:00.000Z',
        }),
      );
      useScheduler(assistantFromComplete(spawn));

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      expect(spawn.mock.calls.filter(([request]) => request.purpose === 'classification')).toHaveLength(1);
      const raw = readFileSync(join(runtime.notesDir(), 'coral-edited-body.md'), 'utf-8');
      expect(parseFrontmatter(raw)).toMatchObject({
        tags: ['edited-body'],
        inputFingerprint: expectedFingerprint,
      });
      expect(runtime.readIndex()?.entries[noteEntryId('coral-edited-body')]).toMatchObject({
        bodyHash: expectedFingerprint,
        inputFingerprint: expectedFingerprint,
      });
    });

    it('classifies a note that has no inputFingerprint', async () => {
      const body = 'Seed body awaiting classification.';
      const expectedFingerprint = computeBodySurfaceHash(body);
      const spawn = vi.fn<CurateAssistantPort['complete']>(async (request) =>
        request.purpose === 'classification'
          ? JSON.stringify([
              {
                entry: noteEntryId('coral-seed-note'),
                tags: ['seed-classified'],
                newEntities: {
                  'seed-classified': {
                    type: 'concept',
                    description: 'Seed note classification.',
                  },
                },
              },
            ])
          : '[]',
      );

      writeNote('coral-seed-note', {
        title: 'Seed Note',
        tags: ['coral'],
        entrySeq: 2,
        body,
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-seed-note': createIndexNote({
            title: 'Seed Note',
            tags: ['coral'],
            entrySeq: 2,
            body,
          }),
        }),
        principles: {},
        entityMeta: {
          coral: { type: 'domain', description: 'Coral domain.' },
          'seed-classified': { type: 'concept', description: 'Seed note classification.' },
        },
        relationships: [],
      });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          initialized: true,
          lastAttemptedThrough: cursor('coral-prior', 1),
          retryNotBefore: '2026-03-25T11:00:00.000Z',
        }),
      );
      useScheduler(assistantFromComplete(spawn));

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      expect(spawn.mock.calls.filter(([request]) => request.purpose === 'classification')).toHaveLength(1);
      const raw = readFileSync(join(runtime.notesDir(), 'coral-seed-note.md'), 'utf-8');
      expect(parseFrontmatter(raw)).toMatchObject({
        tags: ['seed-classified'],
        inputFingerprint: expectedFingerprint,
      });
    });

    it('aborts the active spawn on stop() without leaving retry state or an active claim', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {};
      const spawnStarted = createDeferred<void>();
      const spawnAborted = createDeferred<void>();
      const spawn = vi.fn<CurateAssistantPort['complete']>(async ({ signal }) => {
        if (signal === undefined) {
          throw new Error('Expected curate stop signal.');
        }

        spawnStarted.resolve();
        return new Promise<string>((_resolve, reject) => {
          const finish = () => {
            spawnAborted.resolve();
            reject(new Error('Claude invocation aborted during curate.'));
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

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {}, entityMeta: {}, relationships: [] });
      runtime.writeIndexState({
        contentSeq: 10,
        metadataSeq: 10,
      });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          initialized: true,
        }),
      );
      useScheduler(assistantFromComplete(spawn));

      await scheduler.start();
      vi.advanceTimersByTime(0);
      await Promise.resolve();
      await Promise.resolve();
      await spawnStarted.promise;

      expect(readCurateState(curateDb(runtime))).toMatchObject({
        lastAttemptedThrough: cursor('coral-stop-10', 10),
        activeClaim: {
          through: cursor('coral-stop-10', 10),
        },
      });

      const stopPromise = scheduler.stop();
      await spawnAborted.promise;
      await expect(stopPromise).resolves.toBeUndefined();

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        lastAttemptedThrough: cursor('coral-stop-10', 10),
        retryNotBefore: null,
        activeClaim: null,
        consecutiveClaimFailures: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(scheduler.isRunning()).toBe(false);
    });

    it('throws a CurateJsonParseError when classification returns malformed JSON', async () => {
      useScheduler(assistantFromText('['));
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
          entityMeta: {},
          relationships: [],
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

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {}, entityMeta: {}, relationships: [] });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          processedThrough: cursor('coral-discovery-50', 50),
        }),
      );
      useScheduler(assistantFromText('['));

      await expect(internals.runPrincipleDiscovery(cursor('coral-discovery-50', 50))).rejects.toMatchObject({
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

      runtime.writeIndex({ entries: createIndexEntries(notes), principles: {}, entityMeta: {}, relationships: [] });
      runtime.writeIndexState({
        contentSeq: 10,
        metadataSeq: 10,
      });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          initialized: true,
        }),
      );
      useScheduler(assistantFromText('['));

      await scheduler.start();
      for (let attempt = 0; attempt < 30; attempt += 1) {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
        await Promise.resolve();
        if (readCurateState(curateDb(runtime)).consecutiveClaimFailures === 1) {
          break;
        }
      }

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Curate classification returned invalid JSON.'));
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        lastAttemptedThrough: cursor('coral-failure-10', 10),
        activeClaim: null,
        consecutiveClaimFailures: 1,
      });
      expect(readCurateState(curateDb(runtime)).retryNotBefore).not.toBeNull();
    });

    it('rebuilds text artifacts for entity-graph communities (topology only, no LLM summary)', async () => {
      const notes: Record<string, ReturnType<typeof createIndexNote>> = {
        'coral-transformers-a': createIndexNote({
          title: 'Transformers A',
          tags: ['coral', 'transformer', 'attention'],
          entrySeq: 1,
        }),
        'coral-transformers-b': createIndexNote({
          title: 'Transformers B',
          tags: ['coral', 'transformer', 'attention', 'self-attention'],
          entrySeq: 2,
        }),
        'coral-sqlite-a': createIndexNote({
          title: 'SQLite A',
          tags: ['coral', 'sqlite', 'query-planning'],
          entrySeq: 3,
        }),
        'coral-sqlite-b': createIndexNote({
          title: 'SQLite B',
          tags: ['coral', 'sqlite', 'query-planning', 'indexing'],
          entrySeq: 4,
        }),
      };

      writeNote('coral-transformers-a', {
        title: 'Transformers A',
        tags: ['coral', 'transformer', 'attention'],
        entrySeq: 1,
        body: 'Transformer attention patterns.',
      });
      writeNote('coral-transformers-b', {
        title: 'Transformers B',
        tags: ['coral', 'transformer', 'attention', 'self-attention'],
        entrySeq: 2,
        body: 'Self-attention variants.',
      });
      writeNote('coral-sqlite-a', {
        title: 'SQLite A',
        tags: ['coral', 'sqlite', 'query-planning'],
        entrySeq: 3,
        body: 'SQLite query planning overview.',
      });
      writeNote('coral-sqlite-b', {
        title: 'SQLite B',
        tags: ['coral', 'sqlite', 'query-planning', 'indexing'],
        entrySeq: 4,
        body: 'Indexing and planner tradeoffs.',
      });
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
          'entrySeq: 9',
          '---',
          '# Coral Malformed',
          '',
          'Body.',
        ].join('\n'),
        'utf-8',
      );

      runtime.writeIndex({
        entries: createIndexEntries(notes),
        principles: {},
        entityMeta: {},
        relationships: [],
      });
      const graph: EntityGraph = {
        entityMeta: {
          attention: { type: 'concept', description: 'Attention mechanisms.' },
          transformer: { type: 'technology', description: 'Transformer architectures.' },
          'self-attention': { type: 'pattern', description: 'Self-attention variants.' },
          sqlite: { type: 'technology', description: 'SQLite.' },
          'query-planning': { type: 'operation', description: 'Query planning.' },
          indexing: { type: 'operation', description: 'Index maintenance.' },
        },
        relationships: [
          {
            source: 'transformer',
            target: 'attention',
            type: 'requires',
            description: 'Transformers rely on attention.',
            evidence: ['note:coral-transformers-a'],
          },
          {
            source: 'self-attention',
            target: 'attention',
            type: 'specializes',
            description: 'Self-attention specializes attention.',
            evidence: ['note:coral-transformers-b'],
          },
          {
            source: 'sqlite',
            target: 'query-planning',
            type: 'requires',
            description: 'SQLite depends on query planning.',
            evidence: ['note:coral-sqlite-a'],
          },
          {
            source: 'query-planning',
            target: 'indexing',
            type: 'enables',
            description: 'Query planning informs indexing.',
            evidence: ['note:coral-sqlite-b'],
          },
        ],
      };
      await runtime.writeEntityGraph(graph);
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          initialized: true,
          consecutiveClaimFailures: 3,
        }),
      );

      useScheduler();

      const lockSpy = vi.spyOn(runtime, 'withMutationLock');
      const indexSyncSuccessSpy = vi.spyOn(runtime, 'recordIndexSyncSuccess');

      await expect(internals.runCommunitySubphase()).resolves.toBe(true);

      expect(lockSpy).toHaveBeenCalledTimes(1);
      await applyBoundCorpusConsumerForTest(runtime, writableDbByRuntime.get(runtime)!);
      expect(indexSyncSuccessSpy.mock.calls.length).toBeGreaterThan(0);

      const state = readCurateState(curateDb(runtime));
      expect(state).toMatchObject({
        consecutiveClaimFailures: 3,
        consecutiveCommunityBatchFailures: 0,
      });
      expect(readCurateRetryQueue(curateDb(runtime)).map((repair) => repair.entryId)).toContain('note:coral-malformed');

      const communityDocs = generatedCommunityRecords();
      expect(communityDocs.length).toBeGreaterThan(0);
      expect(communityDocs.every((record) => !record.content.includes('## Summary'))).toBe(true);
      expect(
        communityDocs.every(
          (record) => parseCommunityFrontmatter(record.content).summaryInputFingerprint === undefined,
        ),
      ).toBe(true);
    });

    it('carries prior summary and fingerprint through a topology rebuild', async () => {
      const readCommunityFingerprints = (): Array<string | undefined> =>
        generatedCommunityFrontmatters().map((frontmatter) => frontmatter.summaryInputFingerprint);

      writeNote('coral-peer-community', {
        title: 'Peer Community',
        tags: ['graph-rag', 'retrieval'],
        entrySeq: 1,
        body: 'Graph-backed retrieval improves context selection.',
      });
      const entityMeta: EntityGraph['entityMeta'] = {
        'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
        retrieval: { type: 'operation', description: 'Retrieval workflows.' },
      };
      const relationships: EntityGraph['relationships'] = [
        {
          source: 'graph-rag',
          target: 'retrieval',
          type: 'enables',
          description: 'Graph structure improves retrieval.',
          evidence: ['note:coral-peer-community'],
        },
      ];
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-peer-community': createIndexNote({
            title: 'Peer Community',
            tags: ['graph-rag', 'retrieval'],
            entrySeq: 1,
          }),
        }),
        principles: {},
        entityMeta,
        relationships,
      });
      await runtime.writeEntityGraph({ entityMeta, relationships });
      writeCurateState(curateDb(runtime), createCurateState({ initialized: true }));

      useScheduler();
      await expect(internals.runCommunitySubphase()).resolves.toBe(true);
      expect(readCommunityFingerprints().every((fp) => fp === undefined)).toBe(true);

      const firstGenerated = generatedCommunityRecords()[0];
      if (firstGenerated === undefined) {
        throw new Error('Expected generated community projection records.');
      }
      const slug = firstGenerated.slug;
      await applyCommunitySummary(runtime, slug, 'Peer summary.');
      expect(readCommunityFingerprints().every((fp) => fp !== undefined)).toBe(true);

      // Rescan observes the generated projection freshness without rebuilding corpus markdown.
      await applyBoundCorpusConsumerForTest(runtime, writableDbByRuntime.get(runtime)!);

      // The frontmatter fingerprint must survive the refresh, otherwise the
      // freshness gate reopens and the agent re-summarizes unchanged work.
      expect(readCommunityFingerprints().every((fp) => fp !== undefined)).toBe(true);

      await expect(internals.runCommunitySubphase()).resolves.toBe(true);
      expect(readCommunityFingerprints().every((fp) => fp !== undefined)).toBe(true);
    });

    it('preserves an unrelated community fingerprint when a new cluster shifts the topology', async () => {
      const fingerprintBySlug = (): Map<string, string | undefined> => {
        const map = new Map<string, string | undefined>();
        for (const record of generatedCommunityRecords()) {
          map.set(record.slug, parseCommunityFrontmatter(record.content).summaryInputFingerprint);
        }
        return map;
      };

      writeNote('coral-peer-community', {
        title: 'Peer Community',
        tags: ['graph-rag', 'retrieval'],
        entrySeq: 1,
        body: 'Graph-backed retrieval improves context selection.',
      });
      const metaA: EntityGraph['entityMeta'] = {
        'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
        retrieval: { type: 'operation', description: 'Retrieval workflows.' },
      };
      const relsA: EntityGraph['relationships'] = [
        {
          source: 'graph-rag',
          target: 'retrieval',
          type: 'enables',
          description: 'Graph structure improves retrieval.',
          evidence: ['note:coral-peer-community'],
        },
      ];
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-peer-community': createIndexNote({
            title: 'Peer Community',
            tags: ['graph-rag', 'retrieval'],
            entrySeq: 1,
          }),
        }),
        principles: {},
        entityMeta: metaA,
        relationships: relsA,
      });
      await runtime.writeEntityGraph({ entityMeta: metaA, relationships: relsA });
      writeCurateState(curateDb(runtime), createCurateState({ initialized: true }));

      useScheduler();
      await expect(internals.runCommunitySubphase()).resolves.toBe(true);

      const clusterARecords = generatedCommunityRecords();
      for (const record of clusterARecords) {
        await applyCommunitySummary(runtime, record.slug, 'Cluster A summary.');
      }
      const before = fingerprintBySlug();
      expect([...before.values()].every((fp) => fp !== undefined)).toBe(true);

      // Introduce a second, disjoint cluster — the entity-graph topology changes
      // but cluster A's members and evidence are untouched.
      writeNote('coral-vector-store', {
        title: 'Vector Store',
        tags: ['vector-db', 'embedding'],
        entrySeq: 2,
        body: 'Vector stores index embeddings for similarity search.',
      });
      const metaAB: EntityGraph['entityMeta'] = {
        ...metaA,
        'vector-db': { type: 'technology', description: 'Vector database.' },
        embedding: { type: 'concept', description: 'Embedding vectors.' },
      };
      const relsAB: EntityGraph['relationships'] = [
        ...relsA,
        {
          source: 'vector-db',
          target: 'embedding',
          type: 'requires',
          description: 'Vector DBs store embeddings.',
          evidence: ['note:coral-vector-store'],
        },
      ];
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-peer-community': createIndexNote({
            title: 'Peer Community',
            tags: ['graph-rag', 'retrieval'],
            entrySeq: 1,
          }),
          'coral-vector-store': createIndexNote({
            title: 'Vector Store',
            tags: ['vector-db', 'embedding'],
            entrySeq: 2,
          }),
        }),
        principles: {},
        entityMeta: metaAB,
        relationships: relsAB,
      });
      await runtime.writeEntityGraph({ entityMeta: metaAB, relationships: relsAB });

      // Rescan with the shifted topology observes the generated projection freshness.
      await applyBoundCorpusConsumerForTest(runtime, writableDbByRuntime.get(runtime)!);

      // Cluster A's fingerprint must be carried through unchanged; if the refresh
      // drops it, the agent would re-summarize work that never changed.
      const after = fingerprintBySlug();
      for (const [slug, fp] of before) {
        expect(after.get(slug)).toBe(fp);
      }
    });

    it('topology run materializes generated docs without summaries', async () => {
      writeNote('coral-peer-community', {
        title: 'Peer Community',
        tags: ['graph-rag', 'retrieval'],
        entrySeq: 1,
        body: 'Graph-backed retrieval improves context selection.',
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-peer-community': createIndexNote({
            title: 'Peer Community',
            tags: ['graph-rag', 'retrieval'],
            entrySeq: 1,
          }),
        }),
        principles: {},
        entityMeta: {
          'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
          retrieval: { type: 'operation', description: 'Retrieval workflows.' },
        },
        relationships: [
          {
            source: 'graph-rag',
            target: 'retrieval',
            type: 'enables',
            description: 'Graph structure improves retrieval.',
            evidence: ['note:coral-peer-community'],
          },
        ],
      });
      await runtime.writeEntityGraph({
        entityMeta: {
          'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
          retrieval: { type: 'operation', description: 'Retrieval workflows.' },
        },
        relationships: [
          {
            source: 'graph-rag',
            target: 'retrieval',
            type: 'enables',
            description: 'Graph structure improves retrieval.',
            evidence: ['note:coral-peer-community'],
          },
        ],
      });
      writeCurateState(curateDb(runtime), createCurateState({ initialized: true }));

      useScheduler();
      await expect(internals.runCommunitySubphase()).resolves.toBe(true);

      const communityDocs = generatedCommunityRecords();
      expect(communityDocs.length).toBeGreaterThan(0);
      const generatedFrontmatter = generatedCommunityFrontmatters();
      expect(generatedFrontmatter.every((frontmatter) => frontmatter.summaryInputFingerprint === undefined)).toBe(true);
      expect(communityDocs.every((record) => !record.content.includes('## Summary'))).toBe(true);
    });

    it('discards the topology batch on mutation-lock failures and retries cleanly on the next run', async () => {
      writeNote('coral-graph-rag', {
        title: 'Graph RAG',
        tags: ['graph-rag', 'retrieval'],
        entrySeq: 1,
        body: 'Graph structure improves retrieval.',
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-graph-rag': createIndexNote({
            title: 'Graph RAG',
            tags: ['graph-rag', 'retrieval'],
            entrySeq: 1,
          }),
        }),
        principles: {},
        entityMeta: {},
        relationships: [],
      });
      await runtime.writeEntityGraph({
        entityMeta: {
          'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
          retrieval: { type: 'operation', description: 'Retrieval workflows.' },
        },
        relationships: [
          {
            source: 'graph-rag',
            target: 'retrieval',
            type: 'enables',
            description: 'Graph structure improves retrieval.',
            evidence: ['note:coral-graph-rag'],
          },
        ],
      });
      writeCurateState(
        curateDb(runtime),
        createCurateState({
          initialized: true,
          consecutiveClaimFailures: 2,
          consecutiveCommunityBatchFailures: 4,
        }),
      );

      useScheduler();

      const lockSpy = vi.spyOn(runtime, 'withMutationLock').mockRejectedValueOnce(new Error('topology failed'));

      await expect(internals.runCommunitySubphase()).rejects.toThrow('topology failed');
      lockSpy.mockRestore();

      const stateAfterFailure = readCurateState(curateDb(runtime));
      const docsAfterFailure = generatedCommunityRecords();

      expect(stateAfterFailure.communitySummaryTopologyHash).toBeUndefined();
      // The throw must skip the success-path state write: the seeded failure
      // counter survives unchanged (not reset to 0).
      expect(stateAfterFailure.consecutiveCommunityBatchFailures).toBe(4);
      expect(docsAfterFailure).toEqual([]);

      await expect(internals.runCommunitySubphase()).resolves.toBe(true);

      const docsAfterRecovery = generatedCommunityRecords();
      expect(docsAfterRecovery.length).toBeGreaterThan(0);
      expect(docsAfterRecovery.every((record) => !record.content.includes('## Summary'))).toBe(true);
      expect(readCurateState(curateDb(runtime))).toMatchObject({
        consecutiveClaimFailures: 2,
        consecutiveCommunityBatchFailures: 0,
      });
    });

    it('backs off community batch retries by scheduler tick and resets on success', async () => {
      writeNote('coral-community-backoff', {
        title: 'Community Backoff',
        tags: ['community-backoff', 'scheduler'],
        entrySeq: 1,
        body: 'Scheduler backoff should skip community prepare ticks after failures.',
      });
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-community-backoff': createIndexNote({
            title: 'Community Backoff',
            tags: ['community-backoff', 'scheduler'],
            entrySeq: 1,
          }),
        }),
        principles: {},
        entityMeta: {},
        relationships: [],
      });
      await runtime.writeEntityGraph({
        entityMeta: {
          'community-backoff': { type: 'concept', description: 'Tick-based community backoff.' },
          scheduler: { type: 'operation', description: 'Scheduler ticks.' },
        },
        relationships: [
          {
            source: 'community-backoff',
            target: 'scheduler',
            type: 'requires',
            description: 'Community retries rely on scheduler ticks.',
            evidence: ['note:coral-community-backoff'],
          },
        ],
      });

      // Pre-seed one failure so the scheduler starts with 2 skip ticks (2^1 = 2).
      writeCurateState(
        curateDb(runtime),
        createCurateState({ initialized: true, consecutiveCommunityBatchFailures: 1 }),
      );

      useScheduler(noopCurateAssistant, 100);

      // Spy on captureCorpusSnapshot which is called from the generated-projection community batch.
      const captureSnapshotSpy = vi.spyOn(runtime, 'captureCorpusSnapshot');

      await scheduler.start();
      expect(internals.calculateCommunityBatchBackoffTicks(7)).toBe(64);
      // With 1 failure, 2 skip ticks are queued; two ticks pass without community batch.
      const snapshotsAfterStart = captureSnapshotSpy.mock.calls.length;

      await vi.advanceTimersByTimeAsync(100);
      // Tick 1: community batch skipped (pendingCommunitySkipTicks 2→1).
      expect(captureSnapshotSpy.mock.calls.length).toBe(snapshotsAfterStart);

      await vi.advanceTimersByTimeAsync(100);
      // Tick 2: community batch skipped (pendingCommunitySkipTicks 1→0).
      expect(captureSnapshotSpy.mock.calls.length).toBe(snapshotsAfterStart);

      await vi.advanceTimersByTimeAsync(100);
      // Tick 3: skip ticks exhausted, community batch runs.
      expect(captureSnapshotSpy.mock.calls.length).toBeGreaterThan(snapshotsAfterStart);

      await settleCurateRuntime(scheduler);
      expect(generatedCommunityRecords().length).toBeGreaterThan(0);
    });

    it('runs the community-summary job after topology materializes and commits on its result', async () => {
      writeNote('coral-peer-summary', {
        title: 'Peer Summary',
        tags: ['graph-rag', 'retrieval'],
        entrySeq: 1,
        body: 'Graph-backed retrieval improves context selection.',
      });
      const entityMeta: EntityGraph['entityMeta'] = {
        'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
        retrieval: { type: 'operation', description: 'Retrieval workflows.' },
      };
      const relationships: EntityGraph['relationships'] = [
        {
          source: 'graph-rag',
          target: 'retrieval',
          type: 'enables',
          description: 'Graph structure improves retrieval.',
          evidence: ['note:coral-peer-summary'],
        },
      ];
      runtime.writeIndex({
        entries: createIndexEntries({
          'coral-peer-summary': createIndexNote({
            title: 'Peer Summary',
            tags: ['graph-rag', 'retrieval'],
            entrySeq: 1,
          }),
        }),
        principles: {},
        entityMeta,
        relationships,
      });
      await runtime.writeEntityGraph({ entityMeta, relationships });
      writeCurateState(curateDb(runtime), createCurateState({ initialized: true }));

      let topologyExistedWhenCalled = false;
      const summaryJob = vi.fn<RunCommunitySummaryJob>(async () => {
        topologyExistedWhenCalled = generatedCommunityRecords().length > 0;
        return true;
      });
      useScheduler(noopCurateAssistant, 0, summaryJob);

      await expect(internals.runCommunitySubphase()).resolves.toBe(true);
      // The subphase itself does not run the summary job — that is the scheduler's
      // responsibility — so drive a full scheduler run to exercise the wiring.
      await scheduler.start();
      await settleCurateRuntime(scheduler);

      expect(summaryJob).toHaveBeenCalled();
      expect(summaryJob.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
      expect(topologyExistedWhenCalled).toBe(true);
    });
  });

  describe('start with missing index', () => {
    it('rebuilds index and initializes curate state when index.json is missing but notes exist', async () => {
      writeNote('test-note', { title: 'Test Note', entrySeq: 1 });

      // No index written — ensureCorpusFreshness inside start() should rebuild it
      expect(runtime.readIndex()).toBeNull();

      await scheduler.start();
      await settleCurateRuntime(scheduler);

      expect(runtime.readIndex()).not.toBeNull();

      const state = readCurateState(curateDb(runtime));
      expect(state.initialized).toBe(true);
    });
  });
});

describe('community summary agent surface', () => {
  it('detects stale communities and closes the gate when a summary is applied', async () => {
    writeNote('coral-peer-community', {
      title: 'Peer Community',
      tags: ['graph-rag', 'retrieval'],
      entrySeq: 1,
      body: 'Graph-backed retrieval improves context selection.',
    });
    const entityMeta: EntityGraph['entityMeta'] = {
      'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
      retrieval: { type: 'operation', description: 'Retrieval workflows.' },
    };
    const relationships: EntityGraph['relationships'] = [
      {
        source: 'graph-rag',
        target: 'retrieval',
        type: 'enables',
        description: 'Graph structure improves retrieval.',
        evidence: ['note:coral-peer-community'],
      },
    ];
    runtime.writeIndex({
      entries: createIndexEntries({
        'coral-peer-community': createIndexNote({
          title: 'Peer Community',
          tags: ['graph-rag', 'retrieval'],
          entrySeq: 1,
        }),
      }),
      principles: {},
      entityMeta,
      relationships,
    });
    await runtime.writeEntityGraph({ entityMeta, relationships });
    writeCurateState(curateDb(runtime), createCurateState({ initialized: true }));

    useScheduler();
    await expect(internals.runCommunitySubphase()).resolves.toBe(true);

    const records = generatedCommunityRecords();
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      await applyCommunitySummary(runtime, record.slug, 'Initial summary.');
    }

    // All summaries applied → the server recomputes a matching fingerprint, so nothing is stale.
    expect(listStaleCommunities(runtime)).toEqual([]);

    // Mutate the representative input; generated docs remain projection-store authority.
    const fallbackRecord = records[0];
    if (fallbackRecord === undefined) {
      throw new Error('Expected generated community projection records.');
    }
    const staleRecord = generatedCommunityRecords().find((record) => record.children === undefined) ?? fallbackRecord;
    const slug = staleRecord.slug;
    writeNote('coral-peer-community', {
      title: 'Peer Community',
      tags: ['graph-rag', 'retrieval'],
      entrySeq: 1,
      body: 'Graph-backed retrieval cluster changed after the previous generated summary.',
    });
    expect(listStaleCommunities(runtime).some((community) => community.slug === slug)).toBe(true);

    const input = readCommunitySummaryInput(runtime, slug);
    expect(input).not.toBeNull();
    expect(input?.input).toContain('graph-rag');

    // Applying a summary recomputes the fingerprint server-side and closes the gate.
    expect((await applyCommunitySummary(runtime, slug, 'Graph-backed retrieval cluster.')).written).toBe(true);
    expect(listStaleCommunities(runtime).some((community) => community.slug === slug)).toBe(false);

    // Unknown slugs are no-ops, not crashes.
    expect(readCommunitySummaryInput(runtime, 'no-such-community')).toBeNull();
    expect((await applyCommunitySummary(runtime, 'no-such-community', 'x')).written).toBe(false);
  });
});
