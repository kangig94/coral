// The correction is scoped to links Coral itself placed. A link an operator pointed somewhere of their own is
// left alone: recognising our own artifact is not licence to overwrite someone else's.

import type * as NodeFs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `coralStateRoot` has no cached module-level state (it reads `homedir()` fresh on every call), so a static
// import is safe to use across the module reloads `maintain()` triggers below via `vi.resetModules()`.
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { coralStateRoot } from '../../../clients/hooks/lib/hook-utils.mjs';

const manifest = vi.hoisted(() => ({ flavor: 'prod' as 'prod' | 'dev' }));
const fixture = vi.hoisted(() => ({
  home: '',
  gitDir: '',
  gitRepository: true,
  failSymlinkTarget: null as string | null,
  failRenameTo: null as string | null,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fixture.home };
});

// The flavor has to arrive the way the lib actually reads it — from the build manifest — because
// `coralProjectDir` calls `buildFlavor()` inside its own module, where a mocked export does not reach. Only
// that one file is answered from the fixture; every other read here is real, and this module does many.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    readFileSync: (path: unknown, encoding: unknown) =>
      String(path).endsWith('manifest.json')
        ? JSON.stringify({ flavor: manifest.flavor })
        : (actual.readFileSync as (p: unknown, e: unknown) => string)(path, encoding),
    // Drives the atomicity guarantee with a real failure at the write step, rather than asserting call order:
    // matched on `target` (where the link should point), not the destination path, so it fails the write
    // regardless of whether the implementation symlinks straight to `link` or through a temp file first.
    symlinkSync: (target: unknown, path: unknown, type: unknown) => {
      if (fixture.failSymlinkTarget !== null && String(target) === fixture.failSymlinkTarget) {
        throw Object.assign(new Error('simulated symlink failure'), { code: 'EIO' });
      }
      return (actual.symlinkSync as (t: unknown, p: unknown, ty: unknown) => void)(target, path, type);
    },
    // Only the final symlink path triggers this fixture; ignore-file publication must keep using the real rename.
    renameSync: (oldPath: unknown, newPath: unknown) => {
      if (fixture.failRenameTo !== null && String(newPath) === fixture.failRenameTo) {
        throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
      }
      return (actual.renameSync as (o: unknown, n: unknown) => void)(oldPath, newPath);
    },
  };
});

// `execSync` is a spy, not a bare stub: it is the fork `coralProjectDir` pays to resolve the project source, and
// several tests below measure how many times a single `maintain()` call pays it — F3 is specifically about not
// paying it on paths that never need to know the target. `execFileSync` resolves the project and Git metadata
// context; it is a spy for the same reason, and the combined child-process budget is what F3 pins.
const execSyncMock = vi.hoisted(() => vi.fn(() => 'https://github.com/owner/repo.git\n'));
const execFileSyncMock = vi.hoisted(() =>
  vi.fn((command: unknown, args: unknown, options: unknown) => {
    const isGitContextQuery =
      command === 'git' &&
      Array.isArray(args) &&
      args.join('\0') === 'rev-parse\0--show-toplevel\0--git-common-dir\0--git-path\0info/exclude';
    if (!isGitContextQuery) {
      throw Object.assign(new Error('unexpected execFileSync command'), { code: 'ENOENT' });
    }
    if (!fixture.gitRepository) {
      throw Object.assign(new Error('no git repository'), {
        status: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      });
    }

    const cwd = String((options as { cwd?: unknown }).cwd);
    return `${cwd}\n${fixture.gitDir}\n${fixture.gitDir}/info/exclude\n`;
  }),
);
vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
  execFileSync: execFileSyncMock,
}));

let root: string;
let projectDir: string;

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'coral-symlink-'));
  fixture.home = join(root, 'home');
  fixture.gitDir = join(root, 'git-common');
  fixture.gitRepository = true;
  fixture.failSymlinkTarget = null;
  fixture.failRenameTo = null;
  mkdirSync(fixture.home, { recursive: true });
  mkdirSync(join(fixture.gitDir, 'info'), { recursive: true });
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(join(projectDir, '.gitignore'), '', 'utf-8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

async function maintain(flavor: 'prod' | 'dev'): Promise<{
  status: 'complete' | 'refused' | 'partial';
  artifacts: {
    symlink: {
      state: 'not-requested' | 'unchanged' | 'created' | 'repointed' | 'refused' | 'skipped';
      reason?: string;
    };
  };
}> {
  manifest.flavor = flavor;
  // Re-imported per call: both the flavor and the project source are cached module-level on first read.
  vi.resetModules();
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
  const { maintainProjectIgnore } = await import('../../../clients/hooks/lib/project-ignore.mjs');
  return maintainProjectIgnore({ projectDir, createSymlink: true, token: 'test-token' });
}

const link = (): string => join(projectDir, '.claude', 'coral');
const repositoryArena = (): string => join(fixture.gitDir, 'coral', 'staging', 'project-ignore');

describe('project-ignore symlink maintenance', () => {
  it('creates it on first run', async () => {
    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(result.artifacts.symlink.state).toBe('created');
    expect(readlinkSync(link())).toBe(join(fixture.home, '.coral', 'projects', 'owner-repo'));
    expect(readFileSync(join(fixture.gitDir, 'info', 'exclude'), 'utf-8')).toBe('/.claude/coral\n');
  });

  it('repoints a link left behind by the other flavor', async () => {
    await maintain('prod');
    const stale = readlinkSync(link());

    const result = await maintain('dev');

    expect(result.status).toBe('complete');
    expect(result.artifacts.symlink.state).toBe('repointed');
    expect(readlinkSync(link()), 'the link follows CORAL_PROJECT, which moved').toBe(
      join(fixture.home, '.coral', 'projects-dev', 'owner-repo'),
    );
    expect(readlinkSync(link())).not.toBe(stale);
  });

  // The mirror of the test above. `isOutgrownCoralLink` checks two anchors (`projects`, `projects-dev`)
  // because a link can be left behind by either flavor — the prod→dev direction above only ever exercises the
  // `projects` anchor (the flavor-'dev' target never starts with `.../projects-dev/` when read against a
  // `projects`-rooted link, so the `some()` short-circuits on the first entry). Going dev→prod is what forces
  // the second anchor to match.
  it('repoints a link left behind by the other flavor (dev → prod direction)', async () => {
    await maintain('dev');
    const stale = readlinkSync(link());

    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(result.artifacts.symlink.state).toBe('repointed');
    expect(readlinkSync(link())).toBe(join(fixture.home, '.coral', 'projects', 'owner-repo'));
    expect(readlinkSync(link())).not.toBe(stale);
  });

  it('leaves it alone when it already points where it should', async () => {
    await maintain('prod');

    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(result.artifacts.symlink.state).toBe('unchanged');
    expect(readlinkSync(link())).toBe(join(fixture.home, '.coral', 'projects', 'owner-repo'));
  });

  it('does not touch a link pointing somewhere an operator chose', async () => {
    const elsewhere = join(root, 'somewhere-of-my-own');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, link());

    const result = await maintain('dev');

    expect(result.status, 'a link that is not ours is still a working link').toBe('complete');
    expect(result.artifacts.symlink.state).toBe('unchanged');
    expect(readlinkSync(link()), 'recognising our own artifact is not licence to overwrite theirs').toBe(elsewhere);
  });

  // `~/.coral/projects*` covers two legitimate roots by design (prod and dev), but the character overlap that
  // buys that also matches an operator's own directory that merely starts with the same letters. Each of these
  // lives inside `~/.coral/` itself — the harder case than `does not touch a link pointing somewhere an
  // operator chose`, whose fixture points outside `~/.coral/` entirely and would not have caught an unanchored
  // prefix match.
  it.each(['projects-mine', 'projects-old', 'projectsBackup'])(
    'does not touch a link into a look-alike directory (%s) that only shares the prefix',
    async (lookAlike) => {
      const elsewhere = join(fixture.home, '.coral', lookAlike, 'owner-repo');
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, link());

      const result = await maintain('dev');

      expect(result.status).toBe('complete');
      expect(result.artifacts.symlink.state, 'a look-alike prefix is not one of the two legitimate roots').toBe(
        'unchanged',
      );
      expect(readlinkSync(link()), 'character overlap with "projects" is not membership in it').toBe(elsewhere);
    },
  );

  // `readlinkSync` returns the target exactly as written — `symlinkSync` does not normalize on write — so a
  // target built with a literal `..` segment reads back with the `..` still in it. It textually starts with
  // the `projects` root, and would wrongly match `startsWith(root + sep)` without `normalize()`; measured by
  // constructing the string directly rather than through `path.join`, which would have normalized it away
  // before the fixture ever got to `symlinkSync`.
  it('does not treat a target that only textually starts with the projects root as ours to repoint', async () => {
    const escapee = `${join(coralStateRoot(), 'projects')}/../projects-mine/owner-repo`;
    mkdirSync(join(fixture.home, '.coral', 'projects-mine', 'owner-repo'), { recursive: true });
    symlinkSync(escapee, link());

    const result = await maintain('dev');

    expect(result.status).toBe('complete');
    expect(
      result.artifacts.symlink.state,
      'normalizing the target moves it out of the projects root entirely, same as the other look-alikes',
    ).toBe('unchanged');
    expect(readlinkSync(link())).toBe(escapee);
  });

  it('refuses when the path is a real directory rather than a link', async () => {
    mkdirSync(link(), { recursive: true });
    execSyncMock.mockClear();

    const result = await maintain('prod');

    expect(result.status, 'replacing a directory is a deletion nobody asked for').toBe('refused');
    expect(result.artifacts.symlink).toEqual({ state: 'refused', reason: 'symlink-conflict' });
    expect(existsSync(link())).toBe(true);
    // Refusing because it is a directory needs no comparison against a target, so it must never fork git to
    // compute one — `coralProjectDir` moving above the `lstatSync` early-return once made every run pay this
    // fork regardless of which branch it took.
    expect(execSyncMock, 'a directory refusal needs no target and must not fork git to get one').not.toHaveBeenCalled();
  });

  it('forks git exactly once to recheck an existing link, not on every call site', async () => {
    await maintain('prod');
    execSyncMock.mockClear();

    await maintain('prod');

    // Confirming "already correct" can only be known by comparing against where the link should point, so this
    // one fork is the necessary floor — the defect F3 fixes was an *unconditional* fork paid even by branches
    // (a missing lstat permission, a real directory) that never reach this comparison at all.
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  // F3: the two forks this script makes — `git rev-parse` (`findGitContext`, always paid) and
  // `git remote get-url origin` (`coralProjectDir`, paid here because the recheck above needs a target) — sum
  // to 3500ms of child work before this process's own Node startup. `session-start.mjs` used to give the child
  // exactly that, so a child doing nothing wrong was killed while its own bounds were still running; its budget
  // is now 5000ms. This test pins the sum so that if either bound moves, the parent's number is re-derived
  // rather than left as a guess. Read from the two mocks'
  // own call options rather than restated as a literal, so a change to either bound is caught here rather than
  // only discovered against the outer timeout in production.
  it('spends the whole 3.5s hard-kill budget across its two git forks on the ordinary recheck path', async () => {
    await maintain('prod');
    execFileSyncMock.mockClear();
    execSyncMock.mockClear();

    await maintain('prod');

    expect(execFileSyncMock, 'git rev-parse, for the project and Git metadata context').toHaveBeenCalledTimes(1);
    expect(
      execSyncMock,
      'git remote get-url origin, to confirm the existing link is not outgrown',
    ).toHaveBeenCalledTimes(1);
    const findGitContextTimeout = (
      (execFileSyncMock.mock.calls as unknown[][])[0]?.[2] as { timeout?: number } | undefined
    )?.timeout;
    const coralProjectDirTimeout = (
      (execSyncMock.mock.calls as unknown[][])[0]?.[1] as { timeout?: number } | undefined
    )?.timeout;
    expect(
      (findGitContextTimeout ?? 0) + (coralProjectDirTimeout ?? 0),
      "session-start.mjs must give this child more than the work the child itself bounds; these two forks alone are the whole of it, before this process's own Node startup",
    ).toBe(3500);
  });

  // The test above pins the child's own bound; this one pins the other half of the same guarantee — that the
  // caller's budget actually exceeds it. Reverting `session-start.mjs`'s spawnSync timeout back to exactly this
  // sum reproduces the SIGTERM-before-its-own-bound defect with every other test here still green, so the
  // margin has to be checked directly rather than left to be noticed only against a slow mount in production.
  it("gives the child a budget strictly greater than the child's own two-fork sum", async () => {
    await maintain('prod');
    execFileSyncMock.mockClear();
    execSyncMock.mockClear();

    await maintain('prod');

    const findGitContextTimeout =
      ((execFileSyncMock.mock.calls as unknown[][])[0]?.[2] as { timeout?: number } | undefined)?.timeout ?? 0;
    const coralProjectDirTimeout =
      ((execSyncMock.mock.calls as unknown[][])[0]?.[1] as { timeout?: number } | undefined)?.timeout ?? 0;
    const childBoundSum = findGitContextTimeout + coralProjectDirTimeout;

    const hookUtilsSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'clients', 'hooks', 'lib', 'hook-utils.mjs'),
      'utf-8',
    );
    const parentBudget = Number(hookUtilsSource.match(/PROJECT_IGNORE_SPAWN_TIMEOUT_MS\s*=\s*(\d+)/)?.[1]);

    expect(parentBudget, 'hook-utils.mjs must define this shared constant as a plain number literal').toBeGreaterThan(
      0,
    );
    expect(
      parentBudget,
      "the parent's spawnSync timeout must leave margin beyond the child's own two forks",
    ).toBeGreaterThan(childBoundSum);
  });

  // `runProjectIgnoreMaintenance` tells a timeout kill, a failed launch, an empty result, an unreadable one, and
  // a maintenance pass that ran to completion but reported it could not finish apart, and that split buys
  // nothing unless the caller reads it — a maintenance pass that did not run leaves the ignore file and the
  // symlink exactly as a pass that had nothing to do would. Read from source rather than by import:
  // `session-start.mjs` is a script with a top-level `await readStdin()` that exits the process. Driving the
  // outcomes end-to-end is not available either — the child is spawned with `process.execPath` against a path
  // derived from `import.meta.url`, so no fixture can make it fail.
  it('renders every maintenance outcome it distinguishes, so none is split apart and then dropped', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'clients', 'hooks', 'session-start.mjs'),
      'utf-8',
    );

    const produced = new Set([...source.matchAll(/outcome:\s*'([^']+)'/gu)].map((match) => match[1]));
    const noticed = new Set(
      [
        ...(source.match(/const PROJECT_IGNORE_OUTCOME_NOTICES = \{[^}]*\}/su)?.[0] ?? '').matchAll(
          /^\s*'?([a-z-]+)'?:/gmu,
        ),
      ].map((match) => match[1]),
    );

    expect(produced.size, 'the outcome literals must be readable from source').toBeGreaterThan(3);
    expect(noticed.size, 'the notice table must be readable from source').toBeGreaterThan(0);
    expect(
      [...produced].filter((outcome) => outcome !== 'ok' && outcome !== 'no-project-dir' && !noticed.has(outcome)),
      'every outcome other than ok and no-project-dir must have a notice the session can read',
    ).toEqual([]);
    // Do not pin this assertion to notice variable names, order, or adjacency.
    const migrationDerivation = source.match(
      /const\s+(\w+)\s*=\s*\[([^\]]+)\]\.some\(\(artifact\)\s*=>\s*artifact\?\.state\s*===\s*'published'\)/su,
    );
    const migrationNotice = source.match(/const\s+(\w+)\s*=\s*\w+\s*\?\s*'Coral migration:/su)?.[1] ?? '';
    const ignoreNotice =
      source.match(/const\s+(\w+)\s*=\s*[^\n]+\n\s+\? `Coral project-ignore maintenance/u)?.[1] ?? '';
    // Matched on the composition that collects the notices, not on the separator it joins them with: the
    // separator is presentation and pinning it has already broken this assertion twice for reasons that
    // changed nothing about whether a notice reaches the payload.
    const renderedNotices = source.match(/\[([^\]]*Notice[^\]]*)\]\.filter\(Boolean\)/u)?.[1] ?? '';
    expect(migrationDerivation?.[2], 'migration progress must read both legacy retraction artifacts').toContain(
      'scopedIgnoreRetraction',
    );
    expect(migrationDerivation?.[2], 'migration progress must read both legacy retraction artifacts').toContain(
      'rootIgnoreRetraction',
    );
    expect(migrationNotice, 'the migration notice must be readable from source').not.toBe('');
    expect(ignoreNotice, 'the maintenance notice must be readable from source').not.toBe('');
    expect(renderedNotices, 'the rendered notices must be readable from source').not.toBe('');
    for (const notice of [migrationNotice, ignoreNotice]) {
      expect(renderedNotices, 'every maintenance notice must reach additionalContext').toContain(notice);
    }
  });

  it('leaves the working link in place when writing its replacement fails', async () => {
    await maintain('prod');
    const original = readlinkSync(link());
    fixture.failSymlinkTarget = join(fixture.home, '.coral', 'projects-dev', 'owner-repo');

    const result = await maintain('dev');

    expect(result.status, 'a failed write is reported as a failure, not swallowed').toBe('refused');
    expect(result.artifacts.symlink).toEqual({ state: 'refused', reason: 'publish-failed' });
    expect(
      readlinkSync(link()),
      'unlink-then-symlink would have deleted the working link before the write failed; the fix must not',
    ).toBe(original);
  });

  // Complements the test above: that one fails `symlinkSync` (the write of the temp file) and shows the
  // working link survives. This fails `renameSync` (the swap of the temp file onto the real link) instead —
  // pinning `renameSync` as the actual swap mechanism, not just ruling out unlink-then-symlink.
  it('leaves the working link in place when the rename that swaps it in fails', async () => {
    await maintain('prod');
    const original = readlinkSync(link());
    fixture.failRenameTo = link();

    const result = await maintain('dev');

    expect(result.status, 'a failed rename is reported as a failure, not swallowed').toBe('refused');
    expect(result.artifacts.symlink).toEqual({ state: 'refused', reason: 'publish-failed' });
    expect(
      readlinkSync(link()),
      'the swap is renameSync onto the real link path; failing exactly that call must leave the working link untouched',
    ).toBe(original);
    expect(
      readdirSync(repositoryArena()),
      'a failed repoint must not retain its run directory or staging symlink in the repository-owned arena',
    ).toEqual([]);
  });

  it('leaves no repository-arena residue after a successful repoint', async () => {
    await maintain('prod');

    await maintain('dev');

    expect(
      readdirSync(repositoryArena()),
      'a successful repoint must not retain its run directory or staging symlink in the repository-owned arena',
    ).toEqual([]);
  });
});
