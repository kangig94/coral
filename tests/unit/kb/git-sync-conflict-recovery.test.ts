import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { extractBody } from '#src/kb/corpus/frontmatter.js';
import { createGitSyncController, detectGitConflictState } from '#src/kb/curate/git-sync.js';
import { claimCurateRun } from '#src/kb/curate/runner.js';
import { readCurateConflictQuarantine } from '#src/kb/curate/conflict-quarantine.js';
import { curateDb } from '#src/kb/curate/db-access.js';
import { noteCursor, readCurateState, writeCurateState } from '#src/kb/curate/state/index.js';
import { noteEntryId, type KbIndex } from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
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
      curateAssistant: { complete: async () => '' },
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
        claudeConfigDir: () => join(root, '.claude'),
      },
    });

    const syncResult = await controller.gitSync();

    expect(syncResult).toEqual({ kind: 'ambiguous' });
    const refs = git(local, ['for-each-ref', '--format=%(refname)', 'refs/coral-recovery/main'])
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(refs).toHaveLength(1);
    const recoveryRef = refs[0];
    expect(git(local, ['show', `${recoveryRef}:notes/conflict.md`])).toContain('Local curate output.');
    expect(git(local, ['rev-parse', 'HEAD']).trim()).toBe(git(local, ['rev-parse', 'origin/main']).trim());

    await controller.gitPush();
    expect(spawnSync('git', ['push', '--porcelain', 'origin', 'main'], { cwd: local, encoding: 'utf-8' }).status).toBe(0);

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

    expect(pendingIndex.entries[noteEntryId('conflict')]?.inputFingerprint).not.toBe(remoteBodyHash);
    expect(readCurateConflictQuarantine(curateDb(kb))).toHaveLength(1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-17T12:00:00.000Z'));
    await expect(claimCurateRun(kb, '2026-06-17')).resolves.toBeNull();
  });
});
