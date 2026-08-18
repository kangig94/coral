// `<projectDir>/.claude/coral` is Coral's own convenience link into the project's data directory, and
// `ensureCoralSymlink` returned on "a symlink is there" without ever asking where it went.
//
// That was invisible until `coralProjectDir` learned the build flavor. On a dev install that had already run
// the hook once, the link kept pointing into `~/.coral/projects/` while `CORAL_PROJECT` moved to
// `~/.coral/projects-dev/` — the same two-directory split the flavor fix was closing, reopened one path over,
// and reported as `ok: true` because a symlink did exist.
//
// The correction is scoped to links Coral itself placed. A link an operator pointed somewhere of their own is
// left alone: recognising our own artifact is not licence to overwrite someone else's.

import type * as NodeFs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as NodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const manifest = vi.hoisted(() => ({ flavor: 'prod' as 'prod' | 'dev' }));
const fixture = vi.hoisted(() => ({ home: '', failSymlinkTarget: null as string | null }));

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
  };
});

// `execSync` is a spy, not a bare stub: it is the fork `coralProjectDir` pays to resolve the project source, and
// several tests below measure how many times a single `maintain()` call pays it — F3 is specifically about not
// paying it on paths that never need to know the target.
const execSyncMock = vi.hoisted(() => vi.fn(() => 'https://github.com/owner/repo.git\n'));
vi.mock('node:child_process', () => ({
  // `git remote get-url origin` for the project source, and `git rev-parse` for the ignore root. Answered
  // rather than stubbed away, because the slug under test is derived from the first.
  execSync: execSyncMock,
  execFileSync: () => {
    throw Object.assign(new Error('no git'), { code: 'ENOENT' });
  },
}));

let root: string;
let projectDir: string;

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'coral-symlink-'));
  fixture.home = join(root, 'home');
  fixture.failSymlinkTarget = null;
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(join(projectDir, '.gitignore'), '', 'utf-8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

async function maintain(
  flavor: 'prod' | 'dev',
): Promise<{ ok: boolean; symlinkCreated: boolean; symlinkRepointed: boolean }> {
  manifest.flavor = flavor;
  // Re-imported per call: both the flavor and the project source are cached module-level on first read.
  vi.resetModules();
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
  const { maintainProjectIgnore } = await import('../../../clients/hooks/lib/project-ignore.mjs');
  return maintainProjectIgnore({ projectDir, createSymlink: true, token: 'test-token' });
}

const link = (): string => join(projectDir, '.claude', 'coral');

describe('ensureCoralSymlink keeps its own link pointing at the current flavor', () => {
  it('creates it on first run', async () => {
    const result = await maintain('prod');

    expect(result.ok).toBe(true);
    expect(result.symlinkCreated).toBe(true);
    expect(result.symlinkRepointed, 'a first-time creation is not a repoint').toBe(false);
    expect(readlinkSync(link())).toBe(join(fixture.home, '.coral', 'projects', 'owner-repo'));
  });

  it('repoints a link left behind by the other flavor', async () => {
    await maintain('prod');
    const stale = readlinkSync(link());

    const result = await maintain('dev');

    expect(result.ok).toBe(true);
    expect(result.symlinkCreated, 'a repoint of an existing link is not a first-time creation').toBe(false);
    expect(result.symlinkRepointed, 'replacing a stale-flavor link must be reported as a repoint').toBe(true);
    expect(readlinkSync(link()), 'the link follows CORAL_PROJECT, which moved').toBe(
      join(fixture.home, '.coral', 'projects-dev', 'owner-repo'),
    );
    expect(readlinkSync(link())).not.toBe(stale);
  });

  it('leaves it alone when it already points where it should', async () => {
    await maintain('prod');

    const result = await maintain('prod');

    expect(result.symlinkCreated, 'nothing to do is not a re-creation').toBe(false);
    expect(result.symlinkRepointed, 'nothing to do is not a repoint').toBe(false);
    expect(readlinkSync(link())).toBe(join(fixture.home, '.coral', 'projects', 'owner-repo'));
  });

  it('does not touch a link pointing somewhere an operator chose', async () => {
    const elsewhere = join(root, 'somewhere-of-my-own');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, link());

    const result = await maintain('dev');

    expect(result.ok, 'a link that is not ours is still a working link').toBe(true);
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

      expect(result.ok).toBe(true);
      expect(result.symlinkRepointed, 'a look-alike prefix is not one of the two legitimate roots').toBe(false);
      expect(readlinkSync(link()), 'character overlap with "projects" is not membership in it').toBe(elsewhere);
    },
  );

  it('refuses when the path is a real directory rather than a link', async () => {
    mkdirSync(link(), { recursive: true });
    execSyncMock.mockClear();

    const result = await maintain('prod');

    expect(result.ok, 'replacing a directory is a deletion nobody asked for').toBe(false);
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

  it('leaves the working link in place when writing its replacement fails', async () => {
    await maintain('prod');
    const original = readlinkSync(link());
    fixture.failSymlinkTarget = join(fixture.home, '.coral', 'projects-dev', 'owner-repo');

    const result = await maintain('dev');

    expect(result.ok, 'a failed write is reported as a failure, not swallowed').toBe(false);
    expect(
      readlinkSync(link()),
      'unlink-then-symlink would have deleted the working link before the write failed; the fix must not',
    ).toBe(original);
  });

  it('leaves no temp file behind after a successful repoint', async () => {
    await maintain('prod');

    await maintain('dev');

    expect(
      existsSync(`${link()}.coral-test-token.tmp`),
      'the temp file used for the atomic rename must not survive a successful replacement',
    ).toBe(false);
  });
});
