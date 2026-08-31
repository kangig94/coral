import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
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
  PROJECT_IGNORE_LOCK_CONFLICT_EXIT_CODE,
  PROJECT_IGNORE_LOCK_UNAVAILABLE_EXIT_CODE,
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

function hookScript(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'clients', 'hooks', name);
}

function initProjectApplyBlock(): string {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const skill = readFileSync(join(repositoryRoot, 'clients', 'skills', 'init-project', 'SKILL.md'), 'utf-8');
  const block = [...skill.matchAll(/```bash\n([\s\S]*?)\n\s*```/gu)]
    .map((match) => match[1])
    .find((candidate) => candidate.includes('CORAL_PROJECT_IGNORE_SCRIPT='));
  if (!block) throw new Error('init-project apply block not found');
  return block
    .replace(/^ {2}/gmu, '')
    .replace(/^CORAL_PROJECT_IGNORE_SCRIPT=.*$/mu, 'CORAL_PROJECT_IGNORE_SCRIPT="project-ignore-validator"')
    .replace(/^CORAL_PROJECT_IGNORE_OWNER=.*$/mu, 'CORAL_PROJECT_IGNORE_OWNER="project-ignore-owner"');
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

  it('repairs a retained young run directory before its age permits deletion', () => {
    const arena = join(fixtureRoot, 'arena');
    const runDir = join(arena, '400001-2');
    mkdirSync(runDir, { recursive: true });
    chmodSync(runDir, 0o300);

    const result = sweepProjectIgnoreArenas([arena], {
      now: 1_000_000,
      monotonicNow: () => 0,
    });

    expect(result).toEqual({ inspected: 1, removed: 0, failures: 0 });
    expect(statSync(runDir).mode & 0o777).toBe(0o700);
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
    expect(child.stderr).toContain(
      'The project-relative path contains a carriage return or line feed, which .git/info/exclude cannot represent as one pattern.',
    );
    expect(child.stderr).toContain('Remedy: rename the affected project directory to remove CR and LF characters.');
    expect(existsSync(join(home, '.coral'))).toBe(false);
    expect(existsSync(join(repositoryRoot, '.git', 'coral'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude', 'coral'))).toBe(false);
  });

  it('normalizes every owned directory across fresh owner runs under an owner-read-masking umask', () => {
    const repository = join(fixtureRoot, 'repository');
    const home = join(fixtureRoot, 'home');
    initRepository(repository);
    mkdirSync(join(repository, '.claude'));
    mkdirSync(home);
    const ownerScript = hookScript('project-ignore-owner.mjs');
    const fallbackArena = join(home, '.coral', 'staging', 'project-ignore');
    const repositoryArena = join(repository, '.git', 'coral', 'staging', 'project-ignore');
    let privateDirectories = [
      join(home, '.coral'),
      join(home, '.coral', 'staging'),
      fallbackArena,
      join(repository, '.git', 'coral'),
      join(repository, '.git', 'coral', 'staging'),
      repositoryArena,
    ];
    const previousUmask = process.umask(0o400);
    try {
      const first = spawnSync(process.execPath, [ownerScript, '--project-dir', repository, '--create-symlink'], {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(first.status).toBe(0);

      const link = join(repository, '.claude', 'coral');
      const projectLeaf = readlinkSync(link);
      expect(JSON.parse(first.stdout)).toMatchObject({
        status: 'complete',
        artifacts: { symlink: { state: 'created' } },
      });
      expect(statSync(dirname(projectLeaf)).mode & 0o777).toBe(0o700);
      expect(statSync(projectLeaf).mode & 0o777).toBe(0o700);
      chmodSync(dirname(projectLeaf), 0o300);
      chmodSync(projectLeaf, 0o300);
      const fallbackRun = join(fallbackArena, `${Date.now()}-900001`);
      const repositoryRun = join(repositoryArena, `${Date.now()}-900002`);
      mkdirSync(fallbackRun, { mode: 0o700 });
      mkdirSync(repositoryRun, { mode: 0o700 });
      const marker = join(fallbackArena, `.durability-${'0'.repeat(64)}.pending`);
      writeFileSync(marker, 'not-an-absolute-path');
      chmodSync(marker, 0o600);

      const second = spawnSync(process.execPath, [ownerScript, '--project-dir', repository, '--create-symlink'], {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const third = spawnSync(process.execPath, [ownerScript, '--project-dir', repository, '--create-symlink'], {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      privateDirectories = [
        join(home, '.coral'),
        dirname(projectLeaf),
        projectLeaf,
        join(home, '.coral', 'staging'),
        fallbackArena,
        join(fallbackArena, 'quarantine'),
        fallbackRun,
        join(repository, '.git', 'coral'),
        join(repository, '.git', 'coral', 'staging'),
        repositoryArena,
        repositoryRun,
      ];

      expect(second.status).toBe(1);
      expect(JSON.parse(second.stdout)).toMatchObject({
        status: 'refused',
        artifacts: {
          durabilityReconciliation: {
            state: 'refused',
            reasons: ['durability-evidence-quarantined'],
          },
        },
      });
      expect(third.status).toBe(0);
      expect(JSON.parse(third.stdout)).toMatchObject({
        status: 'complete',
        artifacts: { durabilityReconciliation: { state: 'reconciled' } },
      });
      expect(existsSync(link)).toBe(true);
      expect(statSync(join(home, '.coral', 'staging', 'project-ignore.maintenance.lock')).mode & 0o777).toBe(0o600);
      for (const path of privateDirectories) {
        expect(statSync(path).mode & 0o777).toBe(0o700);
      }
    } finally {
      process.umask(previousUmask);
      for (const path of privateDirectories) {
        try {
          chmodSync(path, 0o700);
        } catch {
          // best effort: cleanup removes whatever it can reach
        }
      }
    }
  });

  it('repairs an existing owner-write-only maintenance lock before opening it', () => {
    const repository = join(fixtureRoot, 'repository');
    const home = join(fixtureRoot, 'home');
    const staging = join(home, '.coral', 'staging');
    const lock = join(staging, 'project-ignore.maintenance.lock');
    initRepository(repository);
    mkdirSync(staging, { recursive: true });
    writeFileSync(lock, '');
    chmodSync(lock, 0o200);
    const ownerScript = hookScript('project-ignore-owner.mjs');

    const child = spawnSync(process.execPath, [ownerScript, '--project-dir', repository], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout).status).toBe('complete');
    expect(statSync(lock).mode & 0o777).toBe(0o600);
  });

  it('repairs an existing owner-write-and-execute-only repository arena component', () => {
    const repository = join(fixtureRoot, 'repository');
    const home = join(fixtureRoot, 'home');
    initRepository(repository);
    mkdirSync(home);
    const component = join(repository, '.git', 'coral');
    mkdirSync(join(component, 'staging', 'project-ignore'), { recursive: true });
    chmodSync(component, 0o300);
    const ownerScript = hookScript('project-ignore-owner.mjs');

    const child = spawnSync(process.execPath, [ownerScript, '--project-dir', repository], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const componentMode = statSync(component).mode & 0o777;
    chmodSync(component, 0o700);

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout).status).toBe('complete');
    expect(componentMode).toBe(0o700);
  });

  it('writes refusal remedies to stderr while stdout remains result JSON', () => {
    const repository = join(fixtureRoot, 'repository');
    const home = join(fixtureRoot, 'home');
    initRepository(repository);
    mkdirSync(home);
    const context = resolveProjectContext(repository);
    expect(context).not.toBeNull();
    writeFileSync(join(repository, '.git', 'coral'), 'not a directory');
    const script = hookScript('project-ignore.mjs');
    const startedNs = process.hrtime.bigint().toString();

    const child = spawnSync(
      process.execPath,
      [
        script,
        '--project-dir',
        repository,
        '--maintenance-locked',
        '--lock-wrapper-started-ns',
        startedNs,
        '--project-context',
        JSON.stringify(context),
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    const result = JSON.parse(child.stdout);
    expect(child.status).toBe(1);
    expect(result).toMatchObject({
      status: 'refused',
      artifacts: { exclude: { state: 'refused', reason: 'repository-arena-unavailable' } },
    });
    expect(child.stdout.trim()).toBe(JSON.stringify(result));
    expect(child.stderr).toContain('Coral could not prepare its staging arena in the authorized common Git directory.');
    expect(child.stderr).toContain('It is attempted again at the next session start.');
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

  it('pins the init-project lock branches to the hook exit-code constants', () => {
    const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const initProject = readFileSync(join(repositoryRoot, 'clients', 'skills', 'init-project', 'SKILL.md'), 'utf-8');
    const sessionStart = readFileSync(join(repositoryRoot, 'clients', 'hooks', 'session-start.mjs'), 'utf-8');
    const conflictBranch = `if [ "$CORAL_PROJECT_IGNORE_STATUS" -eq ${PROJECT_IGNORE_LOCK_CONFLICT_EXIT_CODE} ]; then`;
    const unavailableBranch =
      `if [ "$CORAL_PROJECT_IGNORE_STATUS" -eq ${PROJECT_IGNORE_LOCK_UNAVAILABLE_EXIT_CODE} ] || ` +
      '[ "$CORAL_PROJECT_IGNORE_STATUS" -eq 126 ] || [ "$CORAL_PROJECT_IGNORE_STATUS" -eq 127 ]; then';
    const noOutputBranch = 'if [ "$CORAL_PROJECT_IGNORE_STATUS" -ne 0 ] && [ -z "$CORAL_PROJECT_IGNORE_RESULT" ]; then';

    expect(initProject).toContain(conflictBranch);
    expect(initProject).toContain(unavailableBranch);
    expect(initProject.indexOf(conflictBranch)).toBeLessThan(initProject.indexOf(noOutputBranch));
    expect(initProject.indexOf(unavailableBranch)).toBeLessThan(initProject.indexOf(noOutputBranch));
    expect(initProject.slice(initProject.indexOf(noOutputBranch))).toContain('CORAL_PROJECT_IGNORE_OUTCOME=no-output');
    expect(initProject).not.toContain('CORAL_PROJECT_IGNORE_STDERR_FILE');
    expect(initProject).not.toContain('CORAL_PROJECT_IGNORE_STDERR=');
    expect(sessionStart).toContain('[PROJECT_IGNORE_LOCK_UNAVAILABLE_EXIT_CODE, 126, 127].includes(result.status)');
  });

  it.each([
    {
      name: 'a lock conflict',
      status: 75,
      stdout: '',
      diagnostic: 'owner conflict diagnostic',
      outcome: 'CORAL_PROJECT_IGNORE_OUTCOME=maintenance-busy',
      remedy: 'Another Coral project-ignore maintainer owns the lock.',
      exitCode: 1,
    },
    ...[PROJECT_IGNORE_LOCK_UNAVAILABLE_EXIT_CODE, 126, 127].map((status) => ({
      name: `lock-wrapper status ${status}`,
      status,
      stdout: '',
      diagnostic: `owner status ${status} diagnostic`,
      outcome: 'CORAL_PROJECT_IGNORE_OUTCOME=maintenance-lock-unavailable',
      remedy: 'Ensure ~/.coral/staging is writable and flock is executable, then retry.',
      exitCode: 1,
    })),
    {
      name: 'a generic empty failure',
      status: 2,
      stdout: '',
      diagnostic: 'owner generic diagnostic',
      outcome: 'CORAL_PROJECT_IGNORE_OUTCOME=no-output',
      remedy: 'report a recurring failure as a Coral defect',
      exitCode: 1,
    },
    {
      name: 'a successful result',
      status: 0,
      stdout: '{"status":"complete"}',
      diagnostic: '',
      outcome: null,
      remedy: null,
      exitCode: 0,
    },
  ])('executes the init-project apply block for $name without a working-tree file', (scenario) => {
    const binDir = join(fixtureRoot, `bin-${scenario.status}`);
    const workingDir = join(fixtureRoot, `working-${scenario.status}`);
    mkdirSync(binDir);
    mkdirSync(workingDir);
    const nodeStub = join(binDir, 'node');
    const ownerStub = join(binDir, 'project-ignore-owner');
    const validatorStub = join(binDir, 'project-ignore-validator');
    writeFileSync(nodeStub, '#!/bin/sh\nexec "$@"\n');
    writeFileSync(
      ownerStub,
      [
        '#!/bin/sh',
        'if [ -n "$(find "$PWD" -mindepth 1 -print -quit)" ]; then',
        '  echo "STUB_OWNER_OBSERVED_WORKING_FILE=1" >&2',
        'fi',
        'if [ -n "$STUB_OWNER_STDERR" ]; then printf \'%s\\n\' "$STUB_OWNER_STDERR" >&2; fi',
        'if [ -n "$STUB_OWNER_STDOUT" ]; then printf \'%s\\n\' "$STUB_OWNER_STDOUT"; fi',
        'exit "$STUB_OWNER_STATUS"',
        '',
      ].join('\n'),
    );
    writeFileSync(validatorStub, '#!/bin/sh\ncat >/dev/null\nexit 0\n');
    for (const path of [nodeStub, ownerStub, validatorStub]) chmodSync(path, 0o700);

    const child = spawnSync('sh', ['-c', initProjectApplyBlock()], {
      cwd: workingDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        TMPDIR: workingDir,
        STUB_OWNER_STATUS: String(scenario.status),
        STUB_OWNER_STDOUT: scenario.stdout,
        STUB_OWNER_STDERR: scenario.diagnostic,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(child.status).toBe(scenario.exitCode);
    expect(child.stderr).not.toContain('STUB_OWNER_OBSERVED_WORKING_FILE');
    expect(readdirSync(workingDir)).toEqual([]);
    if (scenario.outcome) {
      expect(child.stderr).toContain(scenario.outcome);
      expect(child.stderr).toContain(scenario.remedy);
      expect(child.stderr.indexOf(scenario.diagnostic)).toBeLessThan(child.stderr.indexOf(scenario.outcome));
    } else {
      expect(child.stderr).not.toContain('CORAL_PROJECT_IGNORE_OUTCOME=');
      expect(child.stderr).toBe('');
    }
  });
});
