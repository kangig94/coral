import type * as NodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsSpyState = vi.hoisted(() => ({
  readCalls: [] as string[],
  dirCalls: [] as string[],
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn((path: NodeFs.PathOrFileDescriptor, encoding?: BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null) => {
      const normalizedPath = String(path);
      fsSpyState.readCalls.push(normalizedPath);
      return actual.readFileSync(path, encoding as BufferEncoding);
    }),
    readdirSync: vi.fn((path: NodeFs.PathLike, options?: NodeFs.ObjectEncodingOptions & { withFileTypes?: false }) => {
      fsSpyState.dirCalls.push(String(path));
      return actual.readdirSync(path, options as never);
    }),
  };
});

import type * as RuntimeModule from '#src/kb/runtime.js';
import type * as MetadataCommitModule from '#src/kb/curate/metadata-commit.js';
import type * as PrinciplesModule from '#src/kb/curate/principles.js';
import type * as GitSyncModule from '#src/kb/curate/git-sync.js';
import type * as ReindexModule from '#src/kb/ops/reindex.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

type LoadedPerfModules = {
  runtime: typeof RuntimeModule;
  metadataCommit: typeof MetadataCommitModule;
  principles: typeof PrinciplesModule;
  gitSync: typeof GitSyncModule;
  reindex: typeof ReindexModule;
};

let tempRoot: string;

function renderNote({
  title,
  tags,
  body,
  entrySeq,
}: {
  title: string;
  tags: string[];
  body: string;
  entrySeq: number;
}): string {
  return [
    '---',
    `tags: [${tags.join(', ')}]`,
    'principles: []',
    'source:',
    '  - kangig94/coral',
    'createdAt: 2026-04-01T00:00:00.000Z',
    'updatedAt: 2026-04-01T00:00:00.000Z',
    `entrySeq: ${entrySeq}`,
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function renderSource({
  title,
  tags,
  body,
  entrySeq,
}: {
  title: string;
  tags: string[];
  body: string;
  entrySeq: number;
}): string {
  return [
    '---',
    `title: ${title}`,
    'type: article',
    `tags: [${tags.join(', ')}]`,
    'importedAt: 2026-04-01',
    `entrySeq: ${entrySeq}`,
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

async function loadPerfModules(): Promise<LoadedPerfModules> {
  // vi.mock is hoisted; resetModules clears the import cache so re-imports get fresh module instances while keeping the mock factory registered and fsSpyState intact.
  vi.resetModules();
  const runtime = await import('#src/kb/runtime.js');
  const metadataCommit = await import('#src/kb/curate/metadata-commit.js');
  const principles = await import('#src/kb/curate/principles.js');
  const gitSync = await import('#src/kb/curate/git-sync.js');
  const reindex = await import('#src/kb/ops/reindex.js');
  return {
    runtime,
    metadataCommit,
    principles,
    gitSync,
    reindex,
  };
}

function clearFsObservability(): void {
  fsSpyState.readCalls = [];
  fsSpyState.dirCalls = [];
}

function corpusReadCalls(kb: {
  notesDir(): string;
  sourcesDir(): string;
  principlesDir(): string;
  communitiesDir(): string;
  entityGraphPath(): string;
}): string[] {
  const roots = [kb.notesDir(), kb.sourcesDir(), kb.principlesDir(), kb.communitiesDir()];
  return fsSpyState.readCalls.filter((path) => roots.some((root) => path.startsWith(root)) || path === kb.entityGraphPath());
}

function corpusDirWalks(kb: {
  notesDir(): string;
  sourcesDir(): string;
  principlesDir(): string;
  communitiesDir(): string;
}): string[] {
  const dirs = new Set([kb.notesDir(), kb.sourcesDir(), kb.principlesDir(), kb.communitiesDir()]);
  return fsSpyState.dirCalls.filter((path) => dirs.has(path));
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'coral-runtime-perf-'));
  clearFsObservability();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('runtime hot-path perf regressions', () => {
  it('single-note metadata edit avoids unrelated corpus reads and directory walks', async () => {
    const { metadataCommit, principles, reindex } = await loadPerfModules();
    void principles;

    mkdirSync(join(tempRoot, 'notes'), { recursive: true });
    mkdirSync(join(tempRoot, 'sources'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'notes', 'target-note.md'),
      renderNote({
        title: 'Target Note',
        tags: ['coral'],
        body: 'Metadata-only target.',
        entrySeq: 1,
      }),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'notes', 'other-note.md'),
      renderNote({
        title: 'Other Note',
        tags: ['other'],
        body: 'Unrelated note.',
        entrySeq: 2,
      }),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'sources', 'other-source.md'),
      renderSource({
        title: 'Other Source',
        tags: ['sqlite'],
        body: 'Unrelated source.',
        entrySeq: 3,
      }),
      'utf-8',
    );

    const kb = createTestKbRuntime({
      markdownRoot: tempRoot,
      runtimeDir: tempRoot,
      db: createKbTestDb(tempRoot),
    });
    const { bindOramaFtsForTest } = await import('#tests/unit/kb/expansion-test-helpers.js');
    bindOramaFtsForTest(kb);
    await reindex.reindex(kb);
    await kb.fts.read().read().search('warmup', 1);
    const entry = kb.readIndexOrEmpty().entries['note:target-note'];
    if (entry === undefined || entry.kind !== 'note' || entry.entrySeq === undefined) {
      throw new Error('Expected target note to exist in the index.');
    }

    clearFsObservability();

    await metadataCommit.commitMetadataTargets(kb, [
      {
        kind: 'note',
        entryId: 'note:target-note',
        slug: 'target-note',
        entrySeq: entry.entrySeq,
        claimTimeUpdatedAt: entry.updatedAt,
        addTags: ['touched'],
      },
    ]);

    const unrelatedReads = corpusReadCalls(kb).filter((path) => path !== kb.notePath('target-note'));
    expect(unrelatedReads).toEqual([]);
    expect(corpusDirWalks(kb)).toEqual([]);
  });

  it('100 no-op gitSync calls avoid corpus file reads and directory walks', async () => {
    const { metadataCommit, principles, gitSync } = await loadPerfModules();
    void metadataCommit;
    void principles;

    mkdirSync(join(tempRoot, 'notes'), { recursive: true });
    mkdirSync(join(tempRoot, 'sources'), { recursive: true });
    writeFileSync(
      join(tempRoot, 'notes', 'coral-note.md'),
      renderNote({
        title: 'Coral Note',
        tags: ['coral'],
        body: 'Stable note.',
        entrySeq: 1,
      }),
      'utf-8',
    );
    writeFileSync(
      join(tempRoot, 'sources', 'sqlite-source.md'),
      renderSource({
        title: 'SQLite Source',
        tags: ['sqlite'],
        body: 'Stable source.',
        entrySeq: 2,
      }),
      'utf-8',
    );

    const kb = createTestKbRuntime({
      markdownRoot: tempRoot,
      runtimeDir: tempRoot,
      db: createKbTestDb(tempRoot),
    });
    kb.readIndex();
    clearFsObservability();

    const execSync = vi.fn((command: string, args: string[]) => {
      expect(command).toBe('git');
      const key = args.join(' ');
      if (key === 'rev-parse --is-inside-work-tree') {
        return { stdout: 'true\n', stderr: '', status: 0 };
      }
      if (key === 'remote') {
        return { stdout: 'origin\n', stderr: '', status: 0 };
      }
      if (key === 'symbolic-ref refs/remotes/origin/HEAD --short') {
        return { stdout: 'origin/main\n', stderr: '', status: 0 };
      }
      if (key === 'rev-parse HEAD') {
        return { stdout: 'deadbeef\n', stderr: '', status: 0 };
      }
      if (key === 'status --porcelain') {
        return { stdout: '', stderr: '', status: 0 };
      }
      if (key.startsWith('diff --name-status --find-renames HEAD@{1}..HEAD')) {
        return { stdout: '', stderr: '', status: 0 };
      }
      throw new Error(`Unexpected git execSync: ${key}`);
    });

    const exec = vi.fn(async (command: string, args: string[]) => {
      expect(command).toBe('git');
      const key = args.join(' ');
      if (key === 'fetch origin' || key === 'rebase origin/main') {
        return { stdout: '', stderr: '', status: 0 };
      }
      throw new Error(`Unexpected git exec: ${key}`);
    });

    const controller = gitSync.createGitSyncController({
      kb,
      spawnCli: async () => ({
        stdout: '',
        stderr: '',
        code: 0,
        aborted: false,
      }),
      processPort: {
        execSync,
        exec,
      },
      storagePort: {
        readFileSync: () => '',
        existsSync: () => false,
        writeAtomicSync: () => true,
      },
      envPort: {
        get: (key: string) => (key === 'CORAL_KB_GIT_SYNC' ? '1' : undefined),
      },
    });

    for (let index = 0; index < 100; index += 1) {
      await kb.runInboundSync(() => controller.gitSync(), { structuredDiff: true });
    }

    expect(corpusReadCalls(kb)).toEqual([]);
    expect(corpusDirWalks(kb)).toEqual([]);
  });
});
