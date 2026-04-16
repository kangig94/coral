import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCurateScheduler, type CurateHandle, type SpawnCliFn } from '../curate/scheduler.js';
import type { KbRuntime } from '../contracts.js';
import { CURATE_STATE_MIGRATION_VERSION, readCurateState, writeCurateState } from '../curate/state.js';
import { parseFrontmatter, parseSourceFrontmatter } from '../frontmatter.js';
import { reindex } from '../ops/reindex.js';
import { createKbRuntime } from '../runtime.js';
import { entryIdToVaultLink, noteEntryId, sourceEntryId, type KbEntryId } from '../types.js';
import { createRealRuntime } from '../../execution/runtime.js';

vi.mock('../curate/usage-budget.js', () => ({
  isUsageBudgetExhausted: () => false,
}));

const DEFAULT_CREATED_AT = '2026-03-20T00:00:00.000Z';
const DEFAULT_UPDATED_AT = '2026-03-20T00:00:00.000Z';
const DEFAULT_IMPORTED_AT = '2026-03-20T00:00:00.000Z';

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
  entrySeq,
  related = [],
  body = 'Body.',
}: {
  title: string;
  type?: string;
  tags?: string[];
  url?: string;
  importedAt?: string;
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
    ...(entrySeq === undefined ? [] : [`entrySeq: ${entrySeq}`]),
    ...renderRelatedLines(related),
    '---',
    `# ${title}`,
    '',
    body,
  ];
  return `${lines.join('\n')}\n`;
}

function writeNote(
  runtime: KbRuntime,
  slug: string,
  options: Parameters<typeof renderNote>[0],
): string {
  mkdirSync(runtime.notesDir(), { recursive: true });
  const notePath = join(runtime.notesDir(), `${slug}.md`);
  writeFileSync(notePath, renderNote(options), 'utf-8');
  return notePath;
}

function writeSource(
  runtime: KbRuntime,
  slug: string,
  options: Parameters<typeof renderSource>[0],
): string {
  mkdirSync(runtime.sourcesDir(), { recursive: true });
  const sourcePath = join(runtime.sourcesDir(), `${slug}.md`);
  writeFileSync(sourcePath, renderSource(options), 'utf-8');
  return sourcePath;
}

async function settleCurateRuntime(handle: CurateHandle): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await vi.advanceTimersByTimeAsync(1);
    if (!handle.isRunning()) {
      return;
    }
  }

  throw new Error('Curate runtime did not settle.');
}

describe('curate AC6/AC8', () => {
  let tempDir: string;
  let runtime: KbRuntime;
  let scheduler: CurateHandle;
  let internals: NonNullable<CurateHandle['_testInternals']>;
  let gitSyncRuntime: ReturnType<typeof createRealRuntime>;

  function useScheduler(spawnCli: SpawnCliFn): void {
    scheduler = createCurateScheduler({
      kb: runtime,
      spawnCli,
      processPort: gitSyncRuntime.process,
      storagePort: gitSyncRuntime.storage,
      envPort: gitSyncRuntime.env,
      scheduleDebounceMs: 0,
    });
    internals = scheduler._testInternals!;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-ac6-ac8-'));
    runtime = createKbRuntime({
      markdownRoot: tempDir,
      runtimeDir: tempDir,
    });
    gitSyncRuntime = createRealRuntime();
    useScheduler(async () => ({
      stdout: '[]',
      stderr: '',
      code: 0,
      aborted: false,
    }));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
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
          entrySeq: 4,
        },
      },
      principles: {},
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
    expect(readCurateState(runtime).processedThrough).toEqual({
      entryId: noteEntryId('coral-alpha'),
      entrySeq: 4,
    });
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
          entrySeq: 7,
        },
      },
      principles: {},
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
      entrySeq: 9,
    });
  });

  it('auto-commit stages source metadata writes', async () => {
    runtime = createKbRuntime({
      markdownRoot: tempDir,
      runtimeDir: join(tempDir, 'data'),
    });
    mkdirSync(runtime.notesDir(), { recursive: true });
    mkdirSync(runtime.principlesDir(), { recursive: true });

    execFileSync('git', ['init'], {
      cwd: tempDir,
      encoding: 'utf-8',
    });

    const assignments: Array<{ entry: string; tags: string[]; related: string[] }> = [];
    const entries: Record<string, { kind: 'source'; slug: string; title: string; type: string; tags: string[]; importedAt: string; related: string[]; entrySeq: number }> = {};
    for (let index = 1; index <= 10; index += 1) {
      const slug = `sqlite-source-${String(index).padStart(2, '0')}`;
      writeSource(runtime, slug, {
        title: `SQLite Source ${index}`,
        tags: ['database'],
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
        entrySeq: index,
      };
      assignments.push({
        entry: sourceEntryId(slug),
        tags: ['database', 'curated'],
        related: [],
      });
    }

    runtime.writeIndex({ entries, principles: {} });
    runtime.writeIndexState({
      contentSeq: 10,
      metadataSeq: 10,
      mutationSeq: 10,
      textIndexedSeq: 10,
      vector: { bySpec: {} },
    });
    writeCurateState(runtime, {
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
      initialized: true,
      migrationVersion: CURATE_STATE_MIGRATION_VERSION,
    });

    useScheduler(async () => ({
      stdout: JSON.stringify(assignments),
      stderr: '',
      code: 0,
      aborted: false,
    }));

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

    expect(status.trim()).toBe('');
    expect(lastCommit).toContain('curate:');
    expect(readCurateState(runtime).processedThrough).toEqual({
      entryId: sourceEntryId('sqlite-source-10'),
      entrySeq: 10,
    });
  });
});
