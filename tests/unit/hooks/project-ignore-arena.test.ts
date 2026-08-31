import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isRepositoryProjectIgnoreStagingAuthorized,
  prepareRepositoryProjectIgnoreStagingDir,
  projectIgnoreContextRefusal,
  projectIgnoreRunDir,
  repositoryProjectIgnoreStagingDir,
  resolveProjectContext,
  sweepProjectIgnoreArenas,
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
} from '../../../clients/hooks/lib/project-ignore.mjs';
import {
  PROJECT_IGNORE_ARENA_SWEEP_BUDGET_MS,
  PROJECT_IGNORE_ARENA_SWEEP_MAX_RUNS,
  PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS,
  PROJECT_IGNORE_LOCK_WRAPPER_BUDGET_MS,
  PROJECT_IGNORE_SPAWN_TIMEOUT_MS,
  PROJECT_IGNORE_STAGING_ARENA_MAX_AGE_MS,
  projectIgnoreContextProbeDeadline,
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
} from '../../../clients/hooks/lib/hook-utils.mjs';

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'coral-project-ignore-arena-'));
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '--quiet');
  git(path, 'config', 'user.name', 'Coral Test');
  git(path, 'config', 'user.email', 'coral@example.invalid');
  writeFileSync(join(path, 'tracked.txt'), 'tracked\n');
  git(path, 'add', 'tracked.txt');
  git(path, 'commit', '--quiet', '-m', 'fixture');
}

function expectRepositoryArena(projectDir: string, expectedCommonGitDir: string): void {
  const context = resolveProjectContext(projectDir);
  expect(context).not.toBeNull();
  expect(context.commonGitDir).toBe(realpathSync(expectedCommonGitDir));
  expect(isRepositoryProjectIgnoreStagingAuthorized(context)).toBe(true);

  const expected = repositoryProjectIgnoreStagingDir(context.commonGitDir);
  const arena = prepareRepositoryProjectIgnoreStagingDir(context.commonGitDir);
  expect(arena).toBe(realpathSync(expected));
  expect(relative(context.commonGitDir, arena)).toBe(join('coral', 'staging', 'project-ignore'));
  expect(isAbsolute(relative(context.commonGitDir, arena))).toBe(false);
  expect(relative(context.commonGitDir, arena).startsWith('..')).toBe(false);
}

describe('project-ignore repository arena', () => {
  it('refuses a bare repository without classifying it as a no-repository working tree', () => {
    const bareRepository = join(fixtureRoot, 'bare.git');
    const plainDirectory = join(fixtureRoot, 'plain');
    mkdirSync(bareRepository);
    mkdirSync(plainDirectory);
    git(bareRepository, 'init', '--bare', '--quiet');

    const bareContext = resolveProjectContext(bareRepository);
    const plainContext = resolveProjectContext(plainDirectory);

    expect(bareContext).toBeNull();
    expect(projectIgnoreContextRefusal(bareContext)).toMatchObject({
      status: 'refused',
      artifacts: {
        symlink: { state: 'refused', reason: 'project-context-unresolvable' },
      },
    });
    expect(plainContext).toMatchObject({
      projectDir: realpathSync(plainDirectory),
      gitDir: null,
      gitRoot: realpathSync(plainDirectory),
      commonGitDir: null,
      excludePath: null,
    });
  });

  it('places each invocation in its startedAt-pid directory', () => {
    expect(projectIgnoreRunDir('/git/coral/staging/project-ignore', 1234, 5678)).toBe(
      join('/git/coral/staging/project-ignore', '1234-5678'),
    );
  });

  it('is contained by the common Git directory in an ordinary repository', () => {
    const repository = join(fixtureRoot, 'ordinary');
    initRepository(repository);

    expectRepositoryArena(repository, join(repository, '.git'));
  });

  it('is contained by the common Git directory from a linked worktree', () => {
    const repository = join(fixtureRoot, 'main');
    const worktree = join(fixtureRoot, 'linked');
    initRepository(repository);
    git(repository, 'worktree', 'add', '--quiet', '--detach', worktree);

    expectRepositoryArena(worktree, join(repository, '.git'));
  });

  it('is contained by the submodule common Git directory', () => {
    const source = join(fixtureRoot, 'source');
    const repository = join(fixtureRoot, 'parent');
    initRepository(source);
    initRepository(repository);
    git(repository, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', source, 'module');

    expectRepositoryArena(join(repository, 'module'), join(repository, '.git', 'modules', 'module'));
  });

  it('does not authorize a separate Git directory inside the working tree', () => {
    const repository = join(fixtureRoot, 'separate');
    mkdirSync(repository);
    git(repository, 'init', '--quiet', '--separate-git-dir=.metadata');

    const context = resolveProjectContext(repository);
    expect(context).not.toBeNull();
    expect(context.commonGitDir).toBe(realpathSync(join(repository, '.metadata')));
    expect(isRepositoryProjectIgnoreStagingAuthorized(context)).toBe(false);
    expect(existsSync(join(repository, '.metadata', 'coral'))).toBe(false);
  });

  it('rejects a symlink or non-directory arena component', () => {
    const repository = join(fixtureRoot, 'unsafe');
    const outside = join(fixtureRoot, 'outside');
    initRepository(repository);
    mkdirSync(outside);

    const commonGitDir = realpathSync(join(repository, '.git'));
    symlinkSync(outside, join(commonGitDir, 'coral'));
    expect(prepareRepositoryProjectIgnoreStagingDir(commonGitDir)).toBeNull();

    rmSync(join(commonGitDir, 'coral'));
    writeFileSync(join(commonGitDir, 'coral'), 'not a directory');
    expect(prepareRepositoryProjectIgnoreStagingDir(commonGitDir)).toBeNull();
  });
});

describe('project-ignore arena reclamation', () => {
  it('derives the cooperating residue age from the five-second owner lifetime', () => {
    expect(PROJECT_IGNORE_STAGING_ARENA_MAX_AGE_MS).toBe(120 * PROJECT_IGNORE_SPAWN_TIMEOUT_MS);
    expect(PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS).toBe(1500);
    expect(PROJECT_IGNORE_LOCK_WRAPPER_BUDGET_MS).toBe(250);
    expect(PROJECT_IGNORE_ARENA_SWEEP_BUDGET_MS).toBe(250);
    expect(PROJECT_IGNORE_ARENA_SWEEP_MAX_RUNS).toBe(32);
  });

  it('retains 599,999 ms and removes 600,000 ms after decisive ownership', () => {
    const firstArena = join(fixtureRoot, 'first');
    const secondArena = join(fixtureRoot, 'second');
    mkdirSync(join(firstArena, '400000-1'), { recursive: true });
    mkdirSync(join(secondArena, '400001-2'), { recursive: true });

    const result = sweepProjectIgnoreArenas([firstArena, secondArena], {
      now: 1_000_000,
      monotonicNow: () => 0,
    });

    expect(result).toEqual({ inspected: 2, removed: 1, failures: 0 });
    expect(existsSync(join(firstArena, '400000-1'))).toBe(false);
    expect(existsSync(join(secondArena, '400001-2'))).toBe(true);
  });

  it('inspects at most 32 parsed runs across both roots, oldest first', () => {
    const firstArena = join(fixtureRoot, 'first');
    const secondArena = join(fixtureRoot, 'second');
    mkdirSync(firstArena);
    mkdirSync(secondArena);
    for (let startedAt = 1; startedAt <= 40; startedAt += 1) {
      const arena = startedAt % 2 === 0 ? firstArena : secondArena;
      mkdirSync(join(arena, `${startedAt}-${startedAt}`));
    }

    const result = sweepProjectIgnoreArenas([firstArena, secondArena], {
      now: PROJECT_IGNORE_STAGING_ARENA_MAX_AGE_MS + 100,
      monotonicNow: () => 0,
    });

    expect(result.inspected).toBe(PROJECT_IGNORE_ARENA_SWEEP_MAX_RUNS);
    expect(result.removed).toBe(PROJECT_IGNORE_ARENA_SWEEP_MAX_RUNS);
    for (let startedAt = 1; startedAt <= 32; startedAt += 1) {
      const arena = startedAt % 2 === 0 ? firstArena : secondArena;
      expect(existsSync(join(arena, `${startedAt}-${startedAt}`))).toBe(false);
    }
    for (let startedAt = 33; startedAt <= 40; startedAt += 1) {
      const arena = startedAt % 2 === 0 ? firstArena : secondArena;
      expect(existsSync(join(arena, `${startedAt}-${startedAt}`))).toBe(true);
    }
  });

  it('stops before another run when the shared 250 ms budget is exhausted', () => {
    const firstArena = join(fixtureRoot, 'first');
    const secondArena = join(fixtureRoot, 'second');
    mkdirSync(join(firstArena, '1-1'), { recursive: true });
    mkdirSync(join(secondArena, '2-2'), { recursive: true });
    const readings = [0, 0, PROJECT_IGNORE_ARENA_SWEEP_BUDGET_MS];

    const result = sweepProjectIgnoreArenas([firstArena, secondArena], {
      now: PROJECT_IGNORE_STAGING_ARENA_MAX_AGE_MS + 100,
      monotonicNow: () => readings.shift() ?? PROJECT_IGNORE_ARENA_SWEEP_BUDGET_MS,
    });

    expect(result).toEqual({ inspected: 1, removed: 1, failures: 0 });
    expect(existsSync(join(firstArena, '1-1'))).toBe(false);
    expect(existsSync(join(secondArena, '2-2'))).toBe(true);
  });
});

describe('project-ignore maintenance ownership', () => {
  it('derives one absolute context-probe deadline from the owner chain start', () => {
    const chainStartedNs = 12_345_678_901n;
    const expectedDeadlineNs = chainStartedNs + BigInt(PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS) * 1_000_000n;

    expect(projectIgnoreContextProbeDeadline(chainStartedNs)).toBe(expectedDeadlineNs);
    expect(projectIgnoreContextProbeDeadline(chainStartedNs.toString())).toBe(expectedDeadlineNs);
    expect(projectIgnoreContextProbeDeadline('not-a-clock-reading')).toBeNull();
  });

  it('refuses an LF-bearing repository path through the real owner before creating lock state', () => {
    const repositoryRoot = join(fixtureRoot, 'repository\nroot');
    const projectDir = join(repositoryRoot, 'nested\nproject');
    const home = join(fixtureRoot, 'fresh-home');
    initRepository(repositoryRoot);
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    mkdirSync(home);

    const ownerScript = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'clients',
      'hooks',
      'project-ignore-owner.mjs',
    );
    const child = spawnSync(process.execPath, [ownerScript, '--project-dir', projectDir, '--create-symlink'], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout)).toMatchObject({
      status: 'refused',
      artifacts: {
        exclude: { state: 'refused', reason: 'project-path-unrepresentable' },
      },
    });
    expect(existsSync(join(home, '.coral'))).toBe(false);
    expect(existsSync(join(repositoryRoot, '.git', 'coral'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'coral'))).toBe(false);
  });

  it('routes both entry points through the exec-style owner and requires its child marker', () => {
    const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const sessionStart = readFileSync(join(repositoryRoot, 'clients', 'hooks', 'session-start.mjs'), 'utf-8');
    const initProject = readFileSync(join(repositoryRoot, 'clients', 'skills', 'init-project', 'SKILL.md'), 'utf-8');
    const owner = readFileSync(join(repositoryRoot, 'clients', 'hooks', 'project-ignore-owner.mjs'), 'utf-8');
    const child = readFileSync(join(repositoryRoot, 'clients', 'hooks', 'project-ignore.mjs'), 'utf-8');

    for (const entryPoint of [sessionStart, initProject]) {
      expect(entryPoint).toContain('project-ignore-owner.mjs');
    }
    expect(owner).toContain('--nonblock');
    expect(owner).toContain('--no-fork');
    expect(owner).toContain('--conflict-exit-code');
    expect(owner).toContain('--maintenance-locked');
    expect(owner).toContain('openProjectIgnoreMaintenanceLock()');
    expect(owner.indexOf('resolveProjectContext(request.projectDir, contextProbeDeadlineNs)')).toBeLessThan(
      owner.indexOf('openProjectIgnoreMaintenanceLock()'),
    );
    expect(owner).toContain('resolveProjectContext(request.projectDir, contextProbeDeadlineNs)');
    expect(owner).toContain('projectIgnoreContextProbeDeadline(startedNs)');
    expect(owner).toContain("'--project-context'");
    expect(owner).toContain("'/dev/fd/0'");
    expect(sessionStart).toContain("outcome: 'maintenance-busy'");
    expect(sessionStart).toContain("outcome: 'maintenance-lock-unavailable'");
    expect(sessionStart).toContain('timeout: PROJECT_IGNORE_SPAWN_TIMEOUT_MS');
    expect(child).toContain('lockWrapperWithinBudget(request.lockWrapperStartedNs)');
    expect(child).toContain('projectIgnoreContextProbeDeadline(request.lockWrapperStartedNs)');
    expect(child).toContain('contextProbeDeadlineNs,');
    expect(initProject).toContain('--validate-result');
    expect(initProject).toContain('CORAL_PROJECT_IGNORE_OUTCOME=unparseable-output');
    expect(initProject).not.toMatch(/(?:Retry|rerun) init-project/u);
    expect(initProject.match(/\/coral:init-project/gu)).toHaveLength(4);
  });
});
