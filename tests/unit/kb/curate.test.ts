import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CorpusScanMod from '#src/kb/corpus/rescan/scan.js';
import * as curateState from '#src/kb/curate/state/index.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { createCurateScheduler, type CurateHandle, type RunCommunitySummaryJob } from '#src/kb/curate/scheduler.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { createCurateTestHandle, type CurateTestHandle } from '#tests/unit/kb/curate/__helpers__/test-handle.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { readCurateState, writeCurateState, type CurateState } from '#src/kb/curate/state/index.js';
import { readCurateRetryQueue, syncCurateRetryQueue } from '#src/kb/curate/retry.js';
import { parseFrontmatter } from '#src/kb/corpus/frontmatter.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { bindOramaFtsForTest } from '#tests/unit/kb/expansion-test-helpers.js';
import { noteEntryId, type KbIndex, type NoteEntry } from '#src/kb/entry-types.js';
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
const writableDbByRuntime = new WeakMap<KbRuntime, ReturnType<typeof openKbTestStoreDb>>();

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

function generatedCommunityRecords() {
  return [...runtime.generatedCommunityProjectionStore.readActiveGeneration().records];
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-'));
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude-config');
  gitSyncRuntime = createRealRuntime('prod');
  const db = openKbTestStoreDb(':memory:');
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
  describe('metadata targets and commit', () => {
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
  });

  describe('runtime integration and errors', () => {
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
  });
});
