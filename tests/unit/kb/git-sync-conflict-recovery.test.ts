import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { extractBody } from '#src/kb/corpus/frontmatter.js';
import { createGitSyncController } from '#src/kb/curate/git-sync.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { claimCurateRun } from '#src/kb/curate/runner.js';
import { readCurateConflictQuarantine } from '#src/kb/curate/conflict-quarantine.js';
import { curateDb } from '#src/kb/curate/db-access.js';
import { noteCursor, readCurateState, writeCurateState } from '#src/kb/curate/state/index.js';
import { noteEntryId, type KbIndex } from '#src/kb/entry-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createTestKbRuntime } from '../../fixtures/test-runtime.js';

const CREATED_AT = '2026-06-17T00:00:00.000Z';

let roots: string[] = [];
let originalClaudeConfigDir: string | undefined;

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
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
    join(bridgeDir, 'coral-cli'),
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
  vi.unstubAllGlobals();
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
    // `resolvePluginRoot()` checks the esbuild-injected `__PLUGIN_ROOT__` global first, and `vitest/setup.ts`
    // pins that to this repo's own `clients/` for every test — unstubbed, the merge driver invoked below would
    // be the real bundled `coral-cli`, not the fake one just written above.
    vi.stubGlobal('__PLUGIN_ROOT__', undefined);

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
    const db = openKbTestStoreDb(':memory:');
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
    // See the equivalent stub in the LLM-resolve test above: without it, `resolvePluginRoot()` resolves the
    // real bundled `clients/` (fixed by `vitest/setup.ts`) instead of the fake driver just written.
    vi.stubGlobal('__PLUGIN_ROOT__', undefined);

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
    const db = openKbTestStoreDb(':memory:');
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
});
