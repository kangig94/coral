import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  projectIgnoreContextRefusal,
  resolveProjectContext,
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
} from '../../../clients/hooks/lib/project-ignore/index.mjs';
import {
  isRepositoryArenaAuthorized,
  prepareRepositoryArena,
  repositoryArenaDir,
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
} from '../../../clients/hooks/lib/project-ignore/arena.mjs';

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

function hookScript(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'clients', 'hooks', name);
}

function expectRepositoryArena(projectDir: string, expectedCommonGitDir: string): void {
  const context = resolveProjectContext(projectDir);
  expect(context).not.toBeNull();
  expect(context.commonGitDir).toBe(realpathSync(expectedCommonGitDir));
  expect(isRepositoryArenaAuthorized(context)).toBe(true);

  const expected = repositoryArenaDir(context.commonGitDir);
  const preparation = prepareRepositoryArena(context.commonGitDir);
  expect(preparation).toEqual({ state: 'prepared', path: realpathSync(expected) });
  const arena = preparation.path;
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
    expect(isRepositoryArenaAuthorized(context)).toBe(false);
    expect(existsSync(join(repository, '.metadata', 'coral'))).toBe(false);
  });

  it('rejects a symlink or non-directory arena component', () => {
    const repository = join(fixtureRoot, 'unsafe');
    const outside = join(fixtureRoot, 'outside');
    initRepository(repository);
    mkdirSync(outside);

    const commonGitDir = realpathSync(join(repository, '.git'));
    symlinkSync(outside, join(commonGitDir, 'coral'));
    expect(prepareRepositoryArena(commonGitDir)).toEqual({
      state: 'structural-conflict',
      path: join(commonGitDir, 'coral'),
      component: 'coral',
    });

    rmSync(join(commonGitDir, 'coral'));
    writeFileSync(join(commonGitDir, 'coral'), 'not a directory');
    expect(prepareRepositoryArena(commonGitDir)).toEqual({
      state: 'structural-conflict',
      path: join(commonGitDir, 'coral'),
      component: 'coral',
    });
  });
});

describe('project-ignore maintenance ownership', () => {
  it('refuses an LF-bearing repository path through the real owner before creating lock state', () => {
    const repositoryRoot = join(fixtureRoot, 'repository\nroot');
    const projectDir = join(repositoryRoot, 'nested\nproject');
    const home = join(fixtureRoot, 'fresh-home');
    initRepository(repositoryRoot);
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    mkdirSync(home);

    const ownerScript = hookScript('project-ignore-owner.mjs');
    const child = spawnSync(process.execPath, [ownerScript, '--project-dir', projectDir, '--create-symlink'], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(child.status).toBe(1);
    const result = JSON.parse(child.stdout);
    expect(result).toMatchObject({
      status: 'refused',
      artifacts: {
        exclude: { state: 'refused', reason: 'project-path-unrepresentable' },
      },
    });
    expect(child.stdout.trim()).toBe(JSON.stringify(result));
    expect(existsSync(join(home, '.coral'))).toBe(false);
    expect(existsSync(join(repositoryRoot, '.git', 'coral'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'coral'))).toBe(false);
  });

  it('refuses symlink creation when the real project has no .claude directory', () => {
    const repository = join(fixtureRoot, 'missing-claude');
    const home = join(fixtureRoot, 'missing-claude-home');
    initRepository(repository);
    mkdirSync(home);
    const excludePath = join(repository, '.git', 'info', 'exclude');
    const excludeBefore = readFileSync(excludePath, 'utf-8');
    const parentBefore = readdirSync(repository).sort();

    const child = spawnSync(
      process.execPath,
      [hookScript('project-ignore-owner.mjs'), '--project-dir', repository, '--create-symlink'],
      {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout)).toMatchObject({
      status: 'refused',
      artifacts: {
        symlink: { state: 'refused', reason: 'claude-directory-missing' },
      },
    });
    expect(existsSync(join(repository, '.claude'))).toBe(false);
    expect(existsSync(join(repository, '.claude', 'coral'))).toBe(false);
    expect(readFileSync(excludePath, 'utf-8')).toBe(excludeBefore);
    expect(readdirSync(repository).sort()).toEqual(parentBefore);
    expect(existsSync(join(home, '.coral', 'projects'))).toBe(false);
  });

  it('refuses symlink creation when the real project .claude path is not a directory', () => {
    const repository = join(fixtureRoot, 'invalid-claude');
    const home = join(fixtureRoot, 'invalid-claude-home');
    initRepository(repository);
    mkdirSync(home);
    const claudePath = join(repository, '.claude');
    const excludePath = join(repository, '.git', 'info', 'exclude');
    writeFileSync(claudePath, 'operator-owned parent\n');
    const excludeBefore = readFileSync(excludePath, 'utf-8');
    const parentBefore = readdirSync(repository).sort();

    const child = spawnSync(
      process.execPath,
      [hookScript('project-ignore-owner.mjs'), '--project-dir', repository, '--create-symlink'],
      {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout)).toMatchObject({
      status: 'refused',
      artifacts: {
        symlink: { state: 'refused', reason: 'claude-directory-invalid' },
      },
    });
    expect(readFileSync(claudePath, 'utf-8')).toBe('operator-owned parent\n');
    expect(existsSync(join(claudePath, 'coral'))).toBe(false);
    expect(readFileSync(excludePath, 'utf-8')).toBe(excludeBefore);
    expect(readdirSync(repository).sort()).toEqual(parentBefore);
    expect(existsSync(join(home, '.coral', 'projects'))).toBe(false);
  });
});
