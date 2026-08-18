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
const fixture = vi.hoisted(() => ({ home: '' }));

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
  };
});

vi.mock('node:child_process', () => ({
  // `git remote get-url origin` for the project source, and `git rev-parse` for the ignore root. Answered
  // rather than stubbed away, because the slug under test is derived from the first.
  execSync: () => 'https://github.com/owner/repo.git\n',
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
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(join(projectDir, '.gitignore'), '', 'utf-8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

async function maintain(flavor: 'prod' | 'dev'): Promise<{ ok: boolean; symlinkCreated: boolean }> {
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
    expect(readlinkSync(link())).toBe(join(fixture.home, '.coral', 'projects', 'owner-repo'));
  });

  it('repoints a link left behind by the other flavor', async () => {
    await maintain('prod');
    const stale = readlinkSync(link());

    const result = await maintain('dev');

    expect(result.ok).toBe(true);
    expect(readlinkSync(link()), 'the link follows CORAL_PROJECT, which moved').toBe(
      join(fixture.home, '.coral', 'projects-dev', 'owner-repo'),
    );
    expect(readlinkSync(link())).not.toBe(stale);
  });

  it('leaves it alone when it already points where it should', async () => {
    await maintain('prod');

    const result = await maintain('prod');

    expect(result.symlinkCreated, 'nothing to do is not a re-creation').toBe(false);
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

  it('refuses when the path is a real directory rather than a link', async () => {
    mkdirSync(link(), { recursive: true });

    const result = await maintain('prod');

    expect(result.ok, 'replacing a directory is a deletion nobody asked for').toBe(false);
    expect(existsSync(link())).toBe(true);
  });
});
