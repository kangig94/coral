import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { extractBody } from '#src/kb/corpus/frontmatter.js';
import { createGitSyncController, detectGitConflictState } from '#src/kb/curate/git-sync.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { claimCurateRun } from '#src/kb/curate/runner.js';
import { readCurateConflictQuarantine } from '#src/kb/curate/conflict-quarantine.js';
import { curateDb } from '#src/kb/curate/db-access.js';
import { noteCursor, readCurateState, writeCurateState } from '#src/kb/curate/state/index.js';
import { noteEntryId, type KbIndex } from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { ExecResult, RuntimeExecOptions } from '#src/runtime/ports.js';
import { createKbTestDb } from './runtime-test-helpers.js';
import { createTestKbRuntime } from '../../fixtures/test-runtime.js';

const CREATED_AT = '2026-06-17T00:00:00.000Z';

let roots: string[] = [];
let originalClaudeConfigDir: string | undefined;

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Coral Test',
      GIT_AUTHOR_EMAIL: 'coral-test@example.invalid',
      GIT_COMMITTER_NAME: 'Coral Test',
      GIT_COMMITTER_EMAIL: 'coral-test@example.invalid',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function initRepo(path: string): void {
  git(path, ['init', '--initial-branch=main']);
  git(path, ['config', 'user.name', 'Coral Test']);
  git(path, ['config', 'user.email', 'coral-test@example.invalid']);
}

function renderConflictNote(body: string, inputFingerprint?: string): string {
  return [
    '---',
    'tags: [coral]',
    'principles: []',
    'source:',
    '  - test',
    `createdAt: ${CREATED_AT}`,
    `updatedAt: ${CREATED_AT}`,
    ...(inputFingerprint === undefined ? [] : [`inputFingerprint: ${inputFingerprint}`]),
    'entrySeq: 1',
    '---',
    '# Conflict',
    '',
    body,
    '',
  ].join('\n');
}

function writeFakeMergeDriver(pluginRoot: string): void {
  const bridgeDir = join(pluginRoot, 'bridge');
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(
    join(bridgeDir, 'coral-cli.cjs'),
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'kb' && args[1] === 'merge-frontmatter') {
  const [base, ours, theirs] = args.slice(2);
  const result = spawnSync('git', ['merge-file', ours, base, theirs], { encoding: 'utf-8' });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status === null ? 1 : result.status);
}
if (args[0] === 'kb' && args[1] === 'merge-entity-graph') {
  process.exit(0);
}
process.exit(2);
`,
    { encoding: 'utf-8', mode: 0o755 },
  );
}

beforeEach(() => {
  roots = [];
  originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  vi.useRealTimers();
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  for (const root of roots) {
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('git sync conflict recovery', () => {
  it('removes a stale git index lock when no git operation is in progress at controller construction', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-stale-index-lock-'));
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    const runtime = createRealRuntime('prod');
    initRepo(root);
    const db = createKbTestDb(root);
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
      db,
      runtime,
    });
    const indexLock = join(root, '.git', 'index.lock');
    writeFileSync(indexLock, 'stale', 'utf-8');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(indexLock, old, old);

    createGitSyncController({
      kb,
      curateAssistant: { complete: async () => '' },
      processPort: runtime.process,
      storagePort: runtime.storage,
      envPort: {
        get: () => undefined,
      },
    });

    expect(existsSync(indexLock)).toBe(false);
  });

  it('keeps a stale git index lock while a git operation state path is present', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-active-op-index-lock-'));
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    const runtime = createRealRuntime('prod');
    initRepo(root);
    const db = createKbTestDb(root);
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
      db,
      runtime,
    });
    const indexLock = join(root, '.git', 'index.lock');
    const rebaseState = join(root, '.git', 'rebase-merge');
    writeFileSync(indexLock, 'active operation', 'utf-8');
    mkdirSync(rebaseState, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(indexLock, old, old);

    createGitSyncController({
      kb,
      curateAssistant: { complete: async () => '' },
      processPort: runtime.process,
      storagePort: runtime.storage,
      envPort: {
        get: () => undefined,
      },
    });

    expect(existsSync(indexLock)).toBe(true);
    expect(existsSync(rebaseState)).toBe(true);
  });

  it('detects staged leftover conflict markers before rebase continuation', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-staged-marker-'));
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    const runtime = createRealRuntime('prod');
    initRepo(root);
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'staged.md'), renderConflictNote('Clean body.'), 'utf-8');
    git(root, ['add', 'notes/staged.md']);
    git(root, ['commit', '-m', 'seed']);

    writeFileSync(
      join(root, 'notes', 'staged.md'),
      renderConflictNote(['<<<<<<< ours', 'local', '=======', 'remote', '>>>>>>> theirs'].join('\n')),
      'utf-8',
    );
    git(root, ['add', 'notes/staged.md']);

    const conflictState = detectGitConflictState({
      root,
      processPort: runtime.process,
      paths: ['notes/'],
    });

    expect(conflictState.hasMarkers).toBe(true);
    expect(conflictState.markerPaths).toEqual(['notes/staged.md']);
  });

  it('uses the mocked assistant as the last-resort body resolver before recovery quarantine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-rebase-llm-resolve-'));
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const local = join(root, 'local');
    const peer = join(root, 'peer');
    const pluginRoot = join(root, 'plugin');
    writeFakeMergeDriver(pluginRoot);

    git(root, ['init', '--bare', '--initial-branch=main', remote]);
    mkdirSync(seed, { recursive: true });
    initRepo(seed);
    mkdirSync(join(seed, 'notes'), { recursive: true });
    writeFileSync(join(seed, '.gitattributes'), '*.md merge=coral-frontmatter\n', 'utf-8');
    writeFileSync(join(seed, 'notes', 'conflict.md'), renderConflictNote('Base body.'), 'utf-8');
    git(seed, ['add', '.gitattributes', 'notes/conflict.md']);
    git(seed, ['commit', '-m', 'seed']);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', '-u', 'origin', 'main']);

    git(root, ['clone', remote, local]);
    git(root, ['clone', remote, peer]);
    git(local, ['config', 'user.name', 'Coral Test']);
    git(local, ['config', 'user.email', 'coral-test@example.invalid']);
    git(local, ['config', 'core.editor', 'true']);
    git(peer, ['config', 'user.name', 'Coral Test']);
    git(peer, ['config', 'user.email', 'coral-test@example.invalid']);

    writeFileSync(join(peer, 'notes', 'conflict.md'), renderConflictNote('Peer body.'), 'utf-8');
    git(peer, ['add', 'notes/conflict.md']);
    git(peer, ['commit', '-m', 'peer body']);
    git(peer, ['push', 'origin', 'main']);

    writeFileSync(join(local, 'notes', 'conflict.md'), renderConflictNote('Local curate output.', 'local-fp'), 'utf-8');
    git(local, ['add', 'notes/conflict.md']);
    git(local, ['commit', '-m', 'curate local output']);

    const runtime = createRealRuntime('prod');
    const db = createKbTestDb(root);
    const kb = createTestKbRuntime({
      markdownRoot: local,
      runtimeDir: root,
      db,
      runtime,
    });
    const complete = vi.fn(async (request: Parameters<CurateAssistantPort['complete']>[0]) => {
      expect(request.purpose).toBe('git-conflict-resolution');
      expect(request.model).toBe('sonnet');
      expect(request.permissionMode).toBe('auto');
      expect(request.prompt).toContain('body content');
      expect(request.prompt).toContain('Do not touch frontmatter');

      writeFileSync(
        join(local, 'notes', 'conflict.md'),
        renderConflictNote(['Peer body.', '', 'Local curate output.'].join('\n'), 'local-fp'),
        'utf-8',
      );
      git(local, ['add', 'notes/conflict.md']);
      return 'resolved';
    });
    const controller = createGitSyncController({
      kb,
      curateAssistant: { complete },
      processPort: runtime.process,
      storagePort: runtime.storage,
      envPort: {
        get: (key: string) => {
          if (key === 'CORAL_KB_GIT_SYNC') {
            return '1';
          }
          if (key === 'CLAUDE_PLUGIN_ROOT') {
            return pluginRoot;
          }
          return undefined;
        },
      },
    });

    const syncResult = await controller.gitSync();

    expect(syncResult).toEqual({ kind: 'ambiguous' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(git(local, ['for-each-ref', '--format=%(refname)', 'refs/coral-recovery/main']).trim()).toBe('');
    expect(readCurateConflictQuarantine(curateDb(kb))).toEqual([]);
    const resolved = git(local, ['show', 'HEAD:notes/conflict.md']);
    expect(resolved).toContain('Peer body.');
    expect(resolved).toContain('Local curate output.');
    expect(resolved).not.toContain('<<<<<<<');
    expect(git(local, ['status', '--porcelain']).trim()).toBe('');
  });

  it('keeps resolving when a successful rebase continue stops on another conflicting commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-rebase-multi-llm-resolve-'));
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');

    const runtime = createRealRuntime('prod');
    const db = createKbTestDb(root);
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
      db,
      runtime,
    });

    let rebaseInProgress = false;
    let conflictMarkers = false;
    let head = 'local-before';
    let continueCalls = 0;

    const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', status: 0 });
    const fail = (stderr: string): ExecResult => ({ stdout: '', stderr, status: 1 });

    const processPort = {
      exec: vi.fn(async (command: string, args: string[], _options?: RuntimeExecOptions): Promise<ExecResult> => {
        expect(command).toBe('git');
        if (args[0] === 'fetch' && args[1] === 'origin') {
          return ok();
        }
        if (args[0] === 'rebase' && args[1] === 'origin/main') {
          rebaseInProgress = true;
          conflictMarkers = true;
          return fail('CONFLICT (content): Merge conflict in notes/conflict.md');
        }
        throw new Error(`unexpected async git ${args.join(' ')}`);
      }),
      execSync: vi.fn((command: string, args: string[], _options?: RuntimeExecOptions): ExecResult => {
        expect(command).toBe('git');

        if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
          return ok('true\n');
        }
        if (args[0] === 'remote') {
          return ok('origin\n');
        }
        if (args[0] === 'config') {
          return ok();
        }
        if (args[0] === 'symbolic-ref') {
          return ok('origin/main\n');
        }
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return ok(`${head}\n`);
        }
        if (args[0] === 'status' && args[1] === '--porcelain') {
          return ok();
        }
        if (args[0] === 'ls-files' && args[1] === '-u') {
          return ok(conflictMarkers ? '100644 deadbeef 1\tnotes/conflict.md\n' : '');
        }
        if (args[0] === 'diff' && args[1] === '--check') {
          return conflictMarkers ? fail('notes/conflict.md:9: leftover conflict marker') : ok();
        }
        if (args[0] === 'add' && args[1] === '-A') {
          return ok();
        }
        if (args[0] === 'rev-parse' && args[1] === '--git-path' && args[2] === 'rebase-merge') {
          return ok('.git/rebase-merge\n');
        }
        if (args[0] === 'rev-parse' && args[1] === '--git-path' && args[2] === 'rebase-apply') {
          return ok('.git/rebase-apply\n');
        }
        if (args.at(-2) === 'rebase' && args.at(-1) === '--continue') {
          continueCalls += 1;
          if (continueCalls === 1) {
            rebaseInProgress = true;
            conflictMarkers = true;
            return ok('stopped again on notes/conflict.md\n');
          }
          if (continueCalls === 2) {
            rebaseInProgress = false;
            conflictMarkers = false;
            head = 'local-after';
            return ok('successfully rebased and updated refs/heads/main\n');
          }
          throw new Error('unexpected extra rebase continue');
        }

        throw new Error(`unexpected sync git ${args.join(' ')}`);
      }),
    };

    const storagePort = {
      readFileSync: vi.fn(() => {
        throw new Error('missing');
      }),
      writeAtomicSync: vi.fn(() => true),
      existsSync: vi.fn((path: string) => {
        if (path === join(root, '.git', 'rebase-merge')) {
          return rebaseInProgress;
        }
        if (path === join(root, '.git', 'rebase-apply')) {
          return false;
        }
        return false;
      }),
      statSync: vi.fn(() => ({ size: 0, mtimeMs: 0, isDirectory: () => false, isFile: () => true })) as never,
      rmSync: vi.fn(),
    };

    const complete = vi.fn(async () => {
      expect(rebaseInProgress).toBe(true);
      expect(conflictMarkers).toBe(true);
      conflictMarkers = false;
      return 'resolved';
    });

    const controller = createGitSyncController({
      kb,
      curateAssistant: { complete },
      processPort,
      storagePort,
      envPort: {
        get: (key: string) => (key === 'CORAL_KB_GIT_SYNC' ? '1' : undefined),
      },
    });

    const syncResult = await controller.gitSync();

    expect(syncResult).toEqual({ kind: 'ambiguous' });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(continueCalls).toBe(2);
    expect(rebaseInProgress).toBe(false);
    expect(conflictMarkers).toBe(false);
    expect(processPort.execSync.mock.calls.some(([, args]) => args[0] === 'rebase' && args[1] === '--abort')).toBe(
      false,
    );
  });

  it('preserves conflicting local commits on a recovery ref, unwedges push, and quarantines the entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-rebase-recovery-'));
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const local = join(root, 'local');
    const peer = join(root, 'peer');
    const pluginRoot = join(root, 'plugin');
    writeFakeMergeDriver(pluginRoot);

    git(root, ['init', '--bare', '--initial-branch=main', remote]);
    mkdirSync(seed, { recursive: true });
    initRepo(seed);
    mkdirSync(join(seed, 'notes'), { recursive: true });
    writeFileSync(join(seed, '.gitattributes'), '*.md merge=coral-frontmatter\n', 'utf-8');
    writeFileSync(join(seed, 'notes', 'conflict.md'), renderConflictNote('Base body.'), 'utf-8');
    git(seed, ['add', '.gitattributes', 'notes/conflict.md']);
    git(seed, ['commit', '-m', 'seed']);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', '-u', 'origin', 'main']);

    git(root, ['clone', remote, local]);
    git(root, ['clone', remote, peer]);
    git(local, ['config', 'user.name', 'Coral Test']);
    git(local, ['config', 'user.email', 'coral-test@example.invalid']);
    git(peer, ['config', 'user.name', 'Coral Test']);
    git(peer, ['config', 'user.email', 'coral-test@example.invalid']);

    writeFileSync(join(peer, 'notes', 'conflict.md'), renderConflictNote('Peer body.'), 'utf-8');
    git(peer, ['add', 'notes/conflict.md']);
    git(peer, ['commit', '-m', 'peer body']);
    git(peer, ['push', 'origin', 'main']);

    writeFileSync(join(local, 'notes', 'conflict.md'), renderConflictNote('Local curate output.', 'local-fp'), 'utf-8');
    git(local, ['add', 'notes/conflict.md']);
    git(local, ['commit', '-m', 'curate local output']);

    const complete = vi.fn(async () => '');
    const runtime = createRealRuntime('prod');
    const db = createKbTestDb(root);
    const kb = createTestKbRuntime({
      markdownRoot: local,
      runtimeDir: root,
      db,
      runtime,
    });
    const controller = createGitSyncController({
      kb,
      curateAssistant: { complete },
      processPort: runtime.process,
      storagePort: runtime.storage,
      envPort: {
        get: (key: string) => {
          if (key === 'CORAL_KB_GIT_SYNC') {
            return '1';
          }
          if (key === 'CLAUDE_PLUGIN_ROOT') {
            return pluginRoot;
          }
          return undefined;
        },
      },
    });

    const syncResult = await controller.gitSync();

    expect(syncResult).toEqual({ kind: 'ambiguous' });
    expect(complete).toHaveBeenCalledTimes(3);
    const refs = git(local, ['for-each-ref', '--format=%(refname)', 'refs/coral-recovery/main'])
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(refs).toHaveLength(1);
    const recoveryRef = refs[0];
    expect(git(local, ['show', `${recoveryRef}:notes/conflict.md`])).toContain('Local curate output.');
    expect(git(local, ['rev-parse', 'HEAD']).trim()).toBe(git(local, ['rev-parse', 'origin/main']).trim());

    await controller.gitPush();
    expect(spawnSync('git', ['push', '--porcelain', 'origin', 'main'], { cwd: local, encoding: 'utf-8' }).status).toBe(
      0,
    );

    const quarantined = readCurateConflictQuarantine(curateDb(kb));
    expect(quarantined).toMatchObject([
      {
        entryId: noteEntryId('conflict'),
        slug: 'conflict',
        path: 'notes/conflict.md',
        recoveryRef,
      },
    ]);

    const remoteBody = extractBody(readFileSync(join(local, 'notes', 'conflict.md'), 'utf-8'));
    const remoteBodyHash = computeBodySurfaceHash(remoteBody);
    const pendingIndex: KbIndex = {
      entries: {
        [noteEntryId('conflict')]: {
          kind: 'note',
          slug: 'conflict',
          title: 'Conflict',
          tags: ['coral'],
          principles: [],
          source: ['test'],
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          entrySeq: 1,
          bodyHash: remoteBodyHash,
          inputFingerprint: 'stale-local-fingerprint',
        },
      },
      principles: {},
      entityMeta: {},
      relationships: [],
    };
    kb.writeIndex(pendingIndex);
    const state = readCurateState(curateDb(kb));
    writeCurateState(curateDb(kb), {
      ...state,
      lastAttemptedThrough: noteCursor('conflict', CREATED_AT),
      retryNotBefore: '2026-06-16T00:00:00.000Z',
    });

    const pendingConflictEntry = pendingIndex.entries[noteEntryId('conflict')];
    expect(pendingConflictEntry?.kind).toBe('note');
    if (pendingConflictEntry?.kind !== 'note') {
      throw new Error('expected conflict fixture to be indexed as a note');
    }
    expect(pendingConflictEntry.inputFingerprint).not.toBe(remoteBodyHash);
    expect(readCurateConflictQuarantine(curateDb(kb))).toHaveLength(1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T12:00:00.000Z'));
    await expect(claimCurateRun(kb, '2026-06-17')).resolves.toBeNull();
  });

  it('does not schedule a deferred auto commit while a git operation is in progress', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'coral-deferred-rebase-guard-'));
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    const runtime = createRealRuntime('prod');
    initRepo(root);
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'auto.md'), renderConflictNote('Original body.'), 'utf-8');
    git(root, ['add', 'notes/auto.md']);
    git(root, ['commit', '-m', 'seed']);
    writeFileSync(join(root, 'notes', 'auto.md'), renderConflictNote('Promoted body.'), 'utf-8');
    mkdirSync(join(root, '.git', 'rebase-merge'), { recursive: true });

    const db = createKbTestDb(root);
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
      db,
      runtime,
    });
    const controller = createGitSyncController({
      kb,
      curateAssistant: { complete: async () => '' },
      processPort: runtime.process,
      storagePort: runtime.storage,
      envPort: {
        get: () => undefined,
      },
    });
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();

    controller.scheduleDeferredCommit();
    rmSync(join(root, '.git', 'rebase-merge'), { recursive: true, force: true });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(git(root, ['status', '--porcelain']).trim()).toContain('M notes/auto.md');
  });

  it('skips auto commits while the index has unresolved merge conflicts', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-auto-commit-conflict-guard-'));
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    const runtime = createRealRuntime('prod');
    initRepo(root);
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'conflict.md'), renderConflictNote('Base body.'), 'utf-8');
    git(root, ['add', 'notes/conflict.md']);
    git(root, ['commit', '-m', 'seed']);
    git(root, ['checkout', '-b', 'feature']);
    writeFileSync(join(root, 'notes', 'conflict.md'), renderConflictNote('Feature body.'), 'utf-8');
    git(root, ['add', 'notes/conflict.md']);
    git(root, ['commit', '-m', 'feature body']);
    git(root, ['checkout', 'main']);
    writeFileSync(join(root, 'notes', 'conflict.md'), renderConflictNote('Main body.'), 'utf-8');
    git(root, ['add', 'notes/conflict.md']);
    git(root, ['commit', '-m', 'main body']);
    const merge = spawnSync('git', ['merge', 'feature'], { cwd: root, encoding: 'utf-8' });
    expect(merge.status).not.toBe(0);

    const db = createKbTestDb(root);
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
      db,
      runtime,
    });
    const controller = createGitSyncController({
      kb,
      curateAssistant: { complete: async () => '' },
      processPort: runtime.process,
      storagePort: runtime.storage,
      envPort: {
        get: () => undefined,
      },
    });
    const headBefore = git(root, ['rev-parse', 'HEAD']).trim();

    controller.gitAutoCommit('auto: kb mutation');

    expect(git(root, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(git(root, ['ls-files', '-u']).trim()).not.toBe('');
  });

  it('stamps the daemon version as a Coral-Version trailer on KB commits', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-commit-version-trailer-'));
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = join(root, '.claude');
    const runtime = createRealRuntime('prod');
    initRepo(root);
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'seed.md'), renderConflictNote('Seed body.'), 'utf-8');
    git(root, ['add', 'notes/seed.md']);
    git(root, ['commit', '-m', 'seed']);
    writeFileSync(join(root, 'notes', 'seed.md'), renderConflictNote('Updated body.'), 'utf-8');

    const db = createKbTestDb(root);
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
      db,
      runtime,
    });
    const controller = createGitSyncController({
      kb,
      curateAssistant: { complete: async () => '' },
      processPort: runtime.process,
      storagePort: runtime.storage,
      envPort: {
        get: () => undefined,
      },
    });

    controller.gitAutoCommit('curate: detect communities');

    const message = git(root, ['log', '-1', '--format=%B']).trim();
    expect(message).toContain('curate: detect communities');
    // `__VERSION__` is injected by esbuild in the bundle; under vitest it is
    // undefined, so the trailer falls back to `dev`.
    expect(message).toContain('Coral-Version: dev');
  });
});
