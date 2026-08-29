import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CorpusScanMod from '#src/kb/corpus/rescan/scan.js';
import { createCurateTestHandle, type CurateTestHandle } from '#tests/unit/kb/curate/__helpers__/test-handle.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';
import { createCurateScheduler, type CurateHandle } from '#src/kb/curate/scheduler.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import type { KbRuntime } from '#src/kb/contract.js';
import {
  cursorTimestampFromStorageSeq,
  noteCursor,
  readCurateState,
  sourceCursor,
  writeCurateState,
} from '#src/kb/curate/state/index.js';
import { parseFrontmatter, parseSourceFrontmatter } from '#src/kb/corpus/frontmatter.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { reindex } from '#src/kb/ops/reindex.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { entryIdToVaultLink, noteEntryId, sourceEntryId, type KbEntryId } from '#src/kb/entry-types.js';
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
const DEFAULT_IMPORTED_AT = '2026-03-20T00:00:00.000Z';

function assistantFromText(stdout: string): CurateAssistantPort {
  return {
    complete: async () => stdout,
  };
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function renderRelatedLines(related: KbEntryId[]): string[] {
  if (related.length === 0) {
    return [];
  }

  return ['related:', ...related.map((entryId) => `  - "${entryIdToVaultLink(entryId)}"`)];
}

function renderNote({
  title,
  tags = ['coral'],
  principles = [],
  source = ['kangig94/coral'],
  createdAt = DEFAULT_CREATED_AT,
  updatedAt = DEFAULT_UPDATED_AT,
  entrySeq,
  related = [],
  body = 'Body.',
}: {
  title: string;
  tags?: string[];
  principles?: string[];
  source?: string[];
  createdAt?: string;
  updatedAt?: string;
  entrySeq?: number;
  related?: KbEntryId[];
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
    ...renderRelatedLines(related),
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
  tags = ['database'],
  url,
  importedAt = DEFAULT_IMPORTED_AT,
  inputFingerprint,
  entrySeq,
  related = [],
  body = 'Body.',
}: {
  title: string;
  type?: string;
  tags?: string[];
  url?: string;
  importedAt?: string;
  inputFingerprint?: string;
  entrySeq?: number;
  related?: KbEntryId[];
  body?: string;
}): string {
  const lines = [
    '---',
    `title: ${title}`,
    `type: ${type}`,
    `tags: [${tags.join(', ')}]`,
    ...(url === undefined ? [] : [`url: ${url}`]),
    `importedAt: ${importedAt}`,
    ...(inputFingerprint === undefined ? [] : [`inputFingerprint: ${inputFingerprint}`]),
    ...(entrySeq === undefined ? [] : [`entrySeq: ${entrySeq}`]),
    ...renderRelatedLines(related),
    '---',
    `# ${title}`,
    '',
    body,
  ];
  return `${lines.join('\n')}\n`;
}

function writeNote(runtime: KbRuntime, slug: string, options: Parameters<typeof renderNote>[0]): string {
  mkdirSync(runtime.notesDir(), { recursive: true });
  const notePath = join(runtime.notesDir(), `${slug}.md`);
  writeFileSync(notePath, renderNote(options), 'utf-8');
  return notePath;
}

function writeSource(runtime: KbRuntime, slug: string, options: Parameters<typeof renderSource>[0]): string {
  mkdirSync(runtime.sourcesDir(), { recursive: true });
  const sourcePath = join(runtime.sourcesDir(), `${slug}.md`);
  writeFileSync(sourcePath, renderSource(options), 'utf-8');
  return sourcePath;
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

describe('curate related-resolution and budget guards', () => {
  let tempDir: string;
  let runtime: KbRuntime;
  let scheduler: CurateHandle;
  let internals: CurateTestHandle;
  let gitSyncRuntime: ReturnType<typeof createRealRuntime>;

  function useScheduler(
    curateAssistant: CurateAssistantPort,
    usageBudget = { isExhausted: async (_signal: AbortSignal) => false },
  ): void {
    scheduler = createCurateScheduler({
      kb: runtime,
      curateAssistant,
      processPort: gitSyncRuntime.process,
      storagePort: gitSyncRuntime.storage,
      envPort: gitSyncRuntime.env,
      usageBudget,
      scheduleDebounceMs: 0,
    });
    internals = createCurateTestHandle({
      kb: runtime,
      curateAssistant,
      schedule: () => scheduler.schedule(),
    });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-ac6-ac8-'));
    gitSyncRuntime = createRealRuntime('prod');
    runtime = createTestKbRuntime({
      markdownRoot: tempDir,
      runtimeDir: tempDir,
      db: createKbTestDb(tempDir),
      runtime: gitSyncRuntime,
    });
    useScheduler(assistantFromText('[]'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('checks the injected system-account budget before any curate work', async () => {
    const usageBudget = { isExhausted: vi.fn(async () => true) };
    const inboundSync = vi.spyOn(runtime, 'runInboundSync');
    useScheduler(assistantFromText('[]'), usageBudget);

    await scheduler.start();
    await settleCurateRuntime(scheduler);

    expect(usageBudget.isExhausted).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(inboundSync).not.toHaveBeenCalled();
  });

  it('appends note related links without removing existing ones', async () => {
    writeNote(runtime, 'coral-alpha', {
      title: 'Alpha',
      updatedAt: '2026-03-21T00:00:00.000Z',
      entrySeq: 4,
      related: ['source:sqlite-overview'],
      body: 'Alpha body.',
    });
    runtime.writeIndex({
      entries: {
        [noteEntryId('coral-alpha')]: {
          kind: 'note',
          slug: 'coral-alpha',
          title: 'Alpha',
          tags: ['coral'],
          principles: [],
          source: ['kangig94/coral'],
          createdAt: DEFAULT_CREATED_AT,
          updatedAt: '2026-03-21T00:00:00.000Z',
          related: ['source:sqlite-overview'],
          bodyHash: computeBodySurfaceHash('Alpha body.'),
          entrySeq: 4,
        },
      },
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
        addRelated: ['note:coral-beta', 'source:sqlite-overview'],
      },
    ]);

    const raw = readFileSync(join(runtime.notesDir(), 'coral-alpha.md'), 'utf-8');
    expect(parseFrontmatter(raw)).toMatchObject({
      related: ['source:sqlite-overview', 'note:coral-beta'],
    });
    expect(raw).toContain('"[[sources/sqlite-overview]]"');
    expect(raw).toContain('"[[notes/coral-beta]]"');
    expect(runtime.readIndex()?.entries[noteEntryId('coral-alpha')]).toMatchObject({
      related: ['source:sqlite-overview', 'note:coral-beta'],
    });
    expect(readCurateState(curateDb(runtime)).processedThrough).toEqual(
      noteCursor('coral-alpha', cursorTimestampFromStorageSeq(4)),
    );
  });

  it('appends source related links, preserves source bytes, and refreshes the live source index', async () => {
    const sourcePath = writeSource(runtime, 'sqlite-query-planner', {
      title: 'SQLite Query Planner',
      tags: ['database'],
      entrySeq: 7,
      related: ['note:coral-alpha'],
      body: '## Outline\nKeep the source body stable.\n',
    });
    const originalRaw = readFileSync(sourcePath, 'utf-8');
    const preservedTail = originalRaw.slice(originalRaw.indexOf('# '));

    runtime.writeIndex({
      entries: {
        [sourceEntryId('sqlite-query-planner')]: {
          kind: 'source',
          slug: 'sqlite-query-planner',
          title: 'SQLite Query Planner',
          type: 'spec',
          tags: ['database'],
          importedAt: DEFAULT_IMPORTED_AT,
          related: ['note:coral-alpha'],
          bodyHash: computeBodySurfaceHash('## Outline\nKeep the source body stable.'),
          entrySeq: 7,
        },
      },
      principles: {},
      entityMeta: {},
      relationships: [],
    });

    await internals.commitMetadataTargets([
      {
        kind: 'source',
        entryId: sourceEntryId('sqlite-query-planner'),
        slug: 'sqlite-query-planner',
        entrySeq: 7,
        claimTimeFingerprint: fingerprint(originalRaw),
        addTags: ['kb'],
        addRelated: ['source:sqlite-overview', 'note:coral-alpha'],
      },
    ]);

    const updatedRaw = readFileSync(sourcePath, 'utf-8');
    expect(updatedRaw.slice(updatedRaw.indexOf('# '))).toBe(preservedTail);
    expect(parseSourceFrontmatter(updatedRaw)).toEqual({
      title: 'SQLite Query Planner',
      type: 'spec',
      tags: ['database', 'kb'],
      importedAt: DEFAULT_IMPORTED_AT,
      related: ['note:coral-alpha', 'source:sqlite-overview'],
      inputFingerprint: computeBodySurfaceHash('## Outline\nKeep the source body stable.'),
      entrySeq: 7,
    });
    expect(updatedRaw).toContain('"[[notes/coral-alpha]]"');
    expect(updatedRaw).toContain('"[[sources/sqlite-overview]]"');
    expect(runtime.readIndex()?.entries[sourceEntryId('sqlite-query-planner')]).toEqual({
      kind: 'source',
      slug: 'sqlite-query-planner',
      title: 'SQLite Query Planner',
      type: 'spec',
      tags: ['database', 'kb'],
      importedAt: DEFAULT_IMPORTED_AT,
      related: ['note:coral-alpha', 'source:sqlite-overview'],
      bodyHash: computeBodySurfaceHash('## Outline\nKeep the source body stable.'),
      inputFingerprint: computeBodySurfaceHash('## Outline\nKeep the source body stable.'),
      entrySeq: 7,
    });
  });

  it('rebuild preserves source entrySeq and related metadata', async () => {
    writeSource(runtime, 'sqlite-overview', {
      title: 'SQLite Overview',
      tags: ['database', 'query-planning'],
      entrySeq: 9,
      related: ['note:coral-alpha', 'source:sqlite-deep-dive'],
      body: 'Reference body.',
    });

    const result = await reindex(runtime);

    expect(result).toMatchObject({
      sources: 1,
      mode: 'text',
    });
    expect(runtime.readIndex()?.entries[sourceEntryId('sqlite-overview')]).toEqual({
      kind: 'source',
      slug: 'sqlite-overview',
      title: 'SQLite Overview',
      type: 'spec',
      tags: ['database', 'query-planning'],
      importedAt: DEFAULT_IMPORTED_AT,
      related: ['note:coral-alpha', 'source:sqlite-deep-dive'],
      bodyHash: computeBodySurfaceHash('Reference body.'),
      entrySeq: 9,
    });
  });

  it('auto-commit stages source metadata writes', async () => {
    runtime = createTestKbRuntime({
      markdownRoot: tempDir,
      runtimeDir: join(tempDir, 'data'),
      db: createKbTestDb(join(tempDir, 'data')),
      runtime: gitSyncRuntime,
    });
    mkdirSync(runtime.notesDir(), { recursive: true });
    mkdirSync(runtime.principlesDir(), { recursive: true });

    execFileSync('git', ['init'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const assignments: Array<{ entry: string; tags: string[]; related: string[] }> = [];
    const entries: Record<
      string,
      {
        kind: 'source';
        slug: string;
        title: string;
        type: string;
        tags: string[];
        importedAt: string;
        related: string[];
        bodyHash: string;
        inputFingerprint: string;
        entrySeq: number;
      }
    > = {};
    for (let index = 1; index <= 10; index += 1) {
      const slug = `sqlite-source-${String(index).padStart(2, '0')}`;
      writeSource(runtime, slug, {
        title: `SQLite Source ${index}`,
        tags: ['database'],
        inputFingerprint: `stale-sqlite-source-${String(index).padStart(2, '0')}`,
        entrySeq: index,
        body: `Reference body ${index}.`,
      });
      entries[sourceEntryId(slug)] = {
        kind: 'source',
        slug,
        title: `SQLite Source ${index}`,
        type: 'spec',
        tags: ['database'],
        importedAt: DEFAULT_IMPORTED_AT,
        related: [],
        bodyHash: computeBodySurfaceHash(`Reference body ${index}.`),
        inputFingerprint: `stale-sqlite-source-${String(index).padStart(2, '0')}`,
        entrySeq: index,
      };
      assignments.push({
        entry: sourceEntryId(slug),
        tags: ['database', 'curated'],
        related: [],
      });
    }

    runtime.writeIndex({ entries, principles: {}, entityMeta: {}, relationships: [] });
    runtime.writeIndexState({
      contentSeq: 10,
      metadataSeq: 10,
    });
    writeCurateState(curateDb(runtime), {
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
      initialized: true,
    });

    useScheduler(assistantFromText(JSON.stringify(assignments)));

    await scheduler.start();
    await settleCurateRuntime(scheduler);

    const status = execFileSync('git', ['status', '--short'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });
    const lastCommit = execFileSync('git', ['log', '--oneline', '-1'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });
    const nonRuntimeStatus = status
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .filter((line) => !['?? store.db', '?? store.db-shm', '?? store.db-wal', '?? store.db.format'].includes(line));

    expect(nonRuntimeStatus).toEqual([]);
    expect(lastCommit).toContain('curate:');
    expect(readCurateState(curateDb(runtime)).processedThrough).toEqual(
      sourceCursor('sqlite-source-10', DEFAULT_IMPORTED_AT),
    );
  });
});
