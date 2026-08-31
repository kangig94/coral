// The correction is scoped to links Coral itself placed. A link an operator pointed somewhere of their own is
// left alone: recognising our own artifact is not licence to overwrite someone else's.

import type * as NodeChildProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type * as NodeFs from 'node:fs';
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `coralStateRoot` has no cached module-level state (it reads `homedir()` fresh on every call), so a static
// import is safe to use across the module reloads `maintain()` triggers below via `vi.resetModules()`.
import {
  coralStateRoot,
  PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS,
  PROJECT_IGNORE_SPAWN_TIMEOUT_MS,
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
} from '../../../clients/hooks/lib/hook-utils.mjs';
import {
  PROJECT_IGNORE_REASON_NOTICES,
  projectIgnoreOutcomeNotice,
  renderProjectIgnoreResultNotices,
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
} from '../../../clients/hooks/lib/project-ignore-notices.mjs';

const manifest = vi.hoisted(() => ({ flavor: 'prod' as 'prod' | 'dev' }));
const fixture = vi.hoisted(() => ({
  home: '',
  gitDir: '',
  gitRoot: '',
  gitRepository: true,
  gitIdentities: [] as string[],
  failSymlinkTarget: null as string | null,
  failRenameTo: null as string | null,
  failQuarantineRename: false,
  failChmodPath: null as string | null,
  failLinkTo: null as string | null,
  failUnlinkPath: null as string | null,
  failReplacementUnlink: false,
  failSymlinkTempUnlink: false,
  failMkdirPath: null as string | null,
  failRmPath: null as string | null,
  failRmUnder: null as string | null,
  rmPaths: [] as string[],
  failReaddirPath: null as string | null,
  failLstatPath: null as string | null,
  failLstatAfter: null as null | { path: string; successesRemaining: number },
  failReadlinkPath: null as string | null,
  failDurabilityStagingUnlink: false,
  failMarkerObservation: null as null | {
    phase: 'lstat' | 'open' | 'fstat' | 'read';
    path: string;
    code: string;
    successesRemaining?: number;
  },
  failDirectoryFsyncPath: null as string | null,
  failDirectoryFsyncCode: null as string | null,
  directoryFsyncFailures: new Map<string, string>(),
  failDurabilityMarkerFsync: false,
  failDurabilityMarkerFsyncFor: null as string | null,
  directoryFds: new Map<number, string>(),
  openPaths: new Map<number, string>(),
  fsyncedDirectoryPaths: [] as string[],
  observeSymlinkPublicationPath: null as string | null,
  durabilityEvents: [] as string[],
  gitReadDurationsMs: [] as number[],
  monotonicNs: 0n,
  lstatPaths: [] as string[],
  realpathPaths: [] as string[],
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return { ...actual, homedir: () => fixture.home };
});

function consumeObservationFailure(phase: 'lstat' | 'open' | 'fstat' | 'read', path: string): string | null {
  const failure = fixture.failMarkerObservation;
  if (failure?.phase !== phase || path !== failure.path) return null;
  if ((failure.successesRemaining ?? 0) > 0) {
    failure.successesRemaining = (failure.successesRemaining ?? 0) - 1;
    return null;
  }
  fixture.failMarkerObservation = null;
  return failure.code;
}

// The flavor has to arrive the way the lib actually reads it — from the build manifest — because
// `coralProjectDir` calls `buildFlavor()` inside its own module, where a mocked export does not reach. Only
// that one file is answered from the fixture; every other read here is real, and this module does many.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    chmodSync: (path: unknown, mode: unknown) => {
      if (fixture.failChmodPath !== null && String(path) === fixture.failChmodPath) {
        throw Object.assign(new Error('simulated chmod failure'), { code: 'EACCES' });
      }
      return (actual.chmodSync as (p: unknown, m: unknown) => void)(path, mode);
    },
    realpathSync: (path: unknown, options?: unknown) => {
      fixture.realpathPaths.push(String(path));
      return (actual.realpathSync as (p: unknown, o?: unknown) => string | Buffer)(path, options);
    },
    mkdirSync: (path: unknown, options?: unknown) => {
      if (fixture.failMkdirPath !== null && String(path) === fixture.failMkdirPath) {
        throw Object.assign(new Error('simulated mkdir failure'), { code: 'ENOSPC' });
      }
      return (actual.mkdirSync as (p: unknown, o?: unknown) => unknown)(path, options);
    },
    lstatSync: (path: unknown) => {
      fixture.lstatPaths.push(String(path));
      const delayedFailure = fixture.failLstatAfter;
      if (delayedFailure && String(path) === delayedFailure.path) {
        if (delayedFailure.successesRemaining === 0) {
          fixture.failLstatAfter = null;
          throw Object.assign(new Error('simulated delayed lstat failure'), { code: 'EIO' });
        }
        delayedFailure.successesRemaining -= 1;
      }
      if (String(path) === fixture.failLstatPath) {
        fixture.failLstatPath = null;
        throw Object.assign(new Error('simulated lstat failure'), { code: 'EIO' });
      }
      const failureCode = consumeObservationFailure('lstat', String(path));
      if (failureCode) {
        throw Object.assign(new Error('simulated lstat failure'), { code: failureCode });
      }
      return actual.lstatSync(path as NodeFs.PathLike);
    },
    readlinkSync: (path: unknown, options?: unknown) => {
      if (String(path) === fixture.failReadlinkPath) {
        fixture.failReadlinkPath = null;
        throw Object.assign(new Error('simulated readlink failure'), { code: 'EIO' });
      }
      return (actual.readlinkSync as (p: unknown, o?: unknown) => string | Buffer)(path, options);
    },
    readFileSync: (path: unknown, encoding?: unknown) => {
      if (String(path).endsWith('manifest.json')) return JSON.stringify({ flavor: manifest.flavor });
      const failureCode =
        typeof path === 'number' ? consumeObservationFailure('read', fixture.openPaths.get(path) ?? '') : null;
      if (failureCode) {
        throw Object.assign(new Error('simulated read failure'), { code: failureCode });
      }
      return (actual.readFileSync as (p: unknown, e?: unknown) => string | Buffer)(path, encoding);
    },
    // Drives the atomicity guarantee with a real failure at the write step, rather than asserting call order:
    // matched on `target` (where the link should point), not the destination path, so it fails the write
    // regardless of whether the implementation symlinks straight to `link` or through a temp file first.
    symlinkSync: (target: unknown, path: unknown, type: unknown) => {
      if (String(path) === fixture.observeSymlinkPublicationPath) {
        fixture.durabilityEvents.push('publish');
      }
      if (fixture.failSymlinkTarget !== null && String(target) === fixture.failSymlinkTarget) {
        throw Object.assign(new Error('simulated symlink failure'), { code: 'EIO' });
      }
      return (actual.symlinkSync as (t: unknown, p: unknown, ty: unknown) => void)(target, path, type);
    },
    // Only the final symlink path triggers this fixture; ignore-file publication must keep using the real rename.
    renameSync: (oldPath: unknown, newPath: unknown) => {
      if (String(newPath) === fixture.observeSymlinkPublicationPath) {
        fixture.durabilityEvents.push('publish');
      } else if (String(newPath).startsWith(`${durabilityArena()}/.durability-`)) {
        fixture.durabilityEvents.push('marker-rename');
      }
      if (
        (fixture.failRenameTo !== null && String(newPath) === fixture.failRenameTo) ||
        (fixture.failQuarantineRename && String(newPath).includes('/quarantine/'))
      ) {
        throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
      }
      return (actual.renameSync as (o: unknown, n: unknown) => void)(oldPath, newPath);
    },
    linkSync: (oldPath: unknown, newPath: unknown) => {
      if (fixture.failLinkTo !== null && String(newPath) === fixture.failLinkTo) {
        throw Object.assign(new Error('simulated link failure'), { code: 'EIO' });
      }
      return (actual.linkSync as (o: unknown, n: unknown) => void)(oldPath, newPath);
    },
    unlinkSync: (path: unknown) => {
      if (
        (fixture.failUnlinkPath !== null && String(path) === fixture.failUnlinkPath) ||
        (fixture.failReplacementUnlink && String(path).endsWith('/replacement.tmp')) ||
        (fixture.failSymlinkTempUnlink && String(path).endsWith('/coral-test-token.tmp')) ||
        (fixture.failDurabilityStagingUnlink &&
          dirname(String(path)) !== durabilityArena() &&
          String(path).startsWith(`${durabilityArena()}/`) &&
          basename(String(path)).startsWith('.durability-'))
      ) {
        throw Object.assign(new Error('simulated unlink failure'), { code: 'EACCES' });
      }
      return (actual.unlinkSync as (p: unknown) => void)(path);
    },
    rmSync: (path: unknown, options: unknown) => {
      fixture.rmPaths.push(String(path));
      if (
        String(path) === fixture.failRmPath ||
        (fixture.failRmUnder !== null && String(path).startsWith(fixture.failRmUnder))
      ) {
        throw Object.assign(new Error('simulated removal failure'), { code: 'EACCES' });
      }
      return (actual.rmSync as (p: unknown, o: unknown) => void)(path, options);
    },
    readdirSync: (path: unknown, options?: unknown) => {
      if (String(path) === fixture.failReaddirPath) {
        throw Object.assign(new Error('simulated directory enumeration failure'), { code: 'EIO' });
      }
      return (actual.readdirSync as (p: unknown, o?: unknown) => unknown)(path, options);
    },
    openSync: (path: unknown, flags: unknown, mode: unknown) => {
      const failureCode = consumeObservationFailure('open', String(path));
      if (failureCode) {
        throw Object.assign(new Error('simulated open failure'), { code: failureCode });
      }
      const fd = (actual.openSync as (p: unknown, f: unknown, m: unknown) => number)(path, flags, mode);
      fixture.openPaths.set(fd, String(path));
      if ((Number(flags) & actual.constants.O_DIRECTORY) !== 0) {
        fixture.directoryFds.set(fd, String(path));
      }
      return fd;
    },
    fstatSync: (fd: number) => {
      const failureCode = consumeObservationFailure('fstat', fixture.openPaths.get(fd) ?? '');
      if (failureCode) {
        throw Object.assign(new Error('simulated fstat failure'), { code: failureCode });
      }
      return actual.fstatSync(fd);
    },
    fsyncSync: (fd: number) => {
      const path = fixture.directoryFds.get(fd);
      if (path) {
        fixture.fsyncedDirectoryPaths.push(path);
        if (path === durabilityArena()) fixture.durabilityEvents.push('marker-parent-fsync');
        const mappedFailure = fixture.directoryFsyncFailures.get(path);
        if (mappedFailure) {
          throw Object.assign(new Error('simulated directory fsync failure'), { code: mappedFailure });
        }
        if (path === fixture.failDirectoryFsyncPath && fixture.failDirectoryFsyncCode) {
          throw Object.assign(new Error('simulated directory fsync failure'), {
            code: fixture.failDirectoryFsyncCode,
          });
        }
      }
      const openPath = fixture.openPaths.get(fd);
      if (
        (fixture.failDurabilityMarkerFsync ||
          basename(openPath ?? '') === basename(fixture.failDurabilityMarkerFsyncFor ?? '')) &&
        openPath?.includes('/.coral/staging/project-ignore/') &&
        openPath.split('/').at(-1)?.startsWith('.durability-')
      ) {
        fixture.failDurabilityMarkerFsync = false;
        fixture.failDurabilityMarkerFsyncFor = null;
        throw Object.assign(new Error('simulated marker fsync failure'), { code: 'EIO' });
      }
      return actual.fsyncSync(fd);
    },
    closeSync: (fd: number) => {
      try {
        return actual.closeSync(fd);
      } finally {
        fixture.directoryFds.delete(fd);
        fixture.openPaths.delete(fd);
      }
    },
  };
});

// `execSync` is a spy, not a bare stub: it is the fork `coralProjectDir` pays to resolve the project source, and
// several tests below measure how many times a single `maintain()` call pays it — F3 is specifically about not
// paying it on paths that never need to know the target. `execFileSync` resolves the project and Git metadata
// context; it is a spy for the same reason, and the combined subprocess budget is what F3 pins.
const execSyncMock = vi.hoisted(() => vi.fn(() => 'https://github.com/owner/repo.git\n'));
const execFileSyncMock = vi.hoisted(() =>
  vi.fn((command: unknown, args: unknown, options: unknown) => {
    if (command !== 'git' || !Array.isArray(args)) {
      throw Object.assign(new Error('unexpected execFileSync command'), { code: 'ENOENT' });
    }
    if (!fixture.gitRepository) {
      throw Object.assign(new Error('no git repository'), {
        status: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      });
    }

    const cwd = String((options as { cwd?: unknown }).cwd);
    const configuredTimeout = Number((options as { timeout?: unknown }).timeout);
    const timeout = Number.isFinite(configuredTimeout) ? configuredTimeout : Number.MAX_SAFE_INTEGER;
    const duration = fixture.gitReadDurationsMs.shift() ?? 0;
    const elapsed = Math.min(duration, timeout);
    fixture.monotonicNs += BigInt(elapsed) * 1_000_000n;
    if (duration > timeout) {
      throw Object.assign(new Error('simulated git context timeout'), { code: 'ETIMEDOUT' });
    }
    const query = args.join('\0');
    if (query === 'rev-parse\0--absolute-git-dir') {
      return `${fixture.gitIdentities.shift() ?? fixture.gitDir}\n`;
    }
    if (query === 'rev-parse\0--show-toplevel') {
      return `${fixture.gitRoot || cwd}\n`;
    }
    throw Object.assign(new Error('unexpected git context field'), { code: 'ENOENT' });
  }),
);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, execSync: execSyncMock, execFileSync: execFileSyncMock };
});

let root: string;
let projectDir: string;

type ProjectIgnoreContext = {
  projectDir: string;
  gitDir: string | null;
  gitRoot: string;
  commonGitDir: string | null;
  excludePath: string | null;
  rootGitignore: string;
  legacyEntry: string;
  excludeEntry: string | null;
  refusalReason: 'project-path-unrepresentable' | null;
};

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), 'coral-symlink-'));
  fixture.home = join(root, 'home');
  fixture.gitDir = join(root, 'git-common');
  fixture.gitRepository = true;
  fixture.gitIdentities.length = 0;
  fixture.failSymlinkTarget = null;
  fixture.failRenameTo = null;
  fixture.failQuarantineRename = false;
  fixture.failChmodPath = null;
  fixture.failLinkTo = null;
  fixture.failUnlinkPath = null;
  fixture.failReplacementUnlink = false;
  fixture.failSymlinkTempUnlink = false;
  fixture.failMkdirPath = null;
  fixture.failRmPath = null;
  fixture.failRmUnder = null;
  fixture.rmPaths.length = 0;
  fixture.failReaddirPath = null;
  fixture.failLstatPath = null;
  fixture.failLstatAfter = null;
  fixture.failReadlinkPath = null;
  fixture.failDurabilityStagingUnlink = false;
  fixture.failMarkerObservation = null;
  fixture.failDirectoryFsyncPath = null;
  fixture.failDirectoryFsyncCode = null;
  fixture.directoryFsyncFailures.clear();
  fixture.failDurabilityMarkerFsync = false;
  fixture.failDurabilityMarkerFsyncFor = null;
  fixture.directoryFds.clear();
  fixture.openPaths.clear();
  fixture.fsyncedDirectoryPaths.length = 0;
  fixture.observeSymlinkPublicationPath = null;
  fixture.durabilityEvents.length = 0;
  fixture.gitReadDurationsMs.length = 0;
  fixture.monotonicNs = 0n;
  fixture.lstatPaths.length = 0;
  fixture.realpathPaths.length = 0;
  mkdirSync(fixture.home, { recursive: true });
  mkdirSync(join(fixture.gitDir, 'info'), { recursive: true });
  projectDir = join(root, 'project');
  fixture.gitRoot = projectDir;
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(join(projectDir, '.gitignore'), '', 'utf-8');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

// A restrictive umask strips owner read from anything created under it, and a directory without it
// cannot be listed — so the tree has to be reopened top-down before it can be removed.
function restoreOwnerAccess(dir: string): void {
  try {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
      const entry = join(dir, name);
      if (lstatSync(entry).isDirectory()) restoreOwnerAccess(entry);
      else chmodSync(entry, 0o600);
    }
  } catch {
    // best effort: cleanup removes whatever it can reach
  }
}

async function maintain(
  flavor: 'prod' | 'dev',
  createSymlink = true,
  suppliedContext?: ProjectIgnoreContext,
): Promise<{
  status: 'complete' | 'refused' | 'partial';
  artifacts: {
    arenaSweep: {
      state: 'unchanged' | 'cleaned' | 'refused' | 'skipped';
      reason?: string;
    };
    durabilityReconciliation: { state: 'reconciled' } | { state: 'refused'; reasons: string[] };
    symlink: {
      state: 'not-requested' | 'unchanged' | 'created' | 'repointed' | 'refused' | 'skipped';
      reason?: string;
      residue?: 'none' | 'owned-staging';
      durability?: {
        state: 'synced' | 'unsupported' | 'failed';
        reasons: string[];
      };
    };
    exclude: {
      state: 'not-needed' | 'unchanged' | 'published' | 'refused' | 'skipped';
      reason?: string;
      residue: 'none' | 'owned-staging';
      durability?: {
        state: 'synced' | 'unsupported' | 'failed';
        reasons: string[];
      };
    };
    legacySweep: {
      state: 'unchanged' | 'cleaned' | 'refused' | 'skipped';
      reason?: string;
      path?: string;
      count?: number;
    };
    scopedIgnoreRetraction: {
      state: 'not-needed' | 'unchanged' | 'published' | 'refused' | 'skipped';
      reason?: string;
      residue: 'none' | 'owned-staging';
      durability?: {
        state: 'synced' | 'unsupported' | 'failed';
        reasons: string[];
      };
    };
    rootIgnoreRetraction: {
      state: 'not-needed' | 'unchanged' | 'published' | 'refused' | 'skipped';
      reason?: string;
      residue: 'none' | 'owned-staging';
      durability?: {
        state: 'synced' | 'unsupported' | 'failed';
        reasons: string[];
      };
    };
  };
}> {
  manifest.flavor = flavor;
  // Re-imported per call: both the flavor and the project source are cached module-level on first read.
  vi.resetModules();
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
  const projectIgnore = await import('../../../clients/hooks/lib/project-ignore.mjs');
  const contextProbeDeadlineNs = process.hrtime.bigint() + BigInt(PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS) * 1_000_000n;
  const context = suppliedContext ?? projectIgnore.resolveProjectContext(projectDir, contextProbeDeadlineNs);
  const result = projectIgnore.maintainProjectIgnore({
    projectDir,
    createSymlink,
    token: 'test-token',
    context,
    contextProbeDeadlineNs,
  });
  const validator = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'clients',
    'hooks',
    'project-ignore.mjs',
  );
  const validation = spawnSync(process.execPath, [validator, '--validate-result'], {
    encoding: 'utf-8',
    input: JSON.stringify(result),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  expect(validation.status).toBe(0);
  return result;
}

async function resolveContext(): Promise<ProjectIgnoreContext> {
  vi.resetModules();
  // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
  const { resolveProjectContext } = await import('../../../clients/hooks/lib/project-ignore.mjs');
  const context = resolveProjectContext(projectDir) as ProjectIgnoreContext | null;
  expect(context).not.toBeNull();
  return context as ProjectIgnoreContext;
}

const link = (): string => join(projectDir, '.claude', 'coral');
const repositoryArena = (): string => join(fixture.gitDir, 'coral', 'staging', 'project-ignore');
const durabilityArena = (): string => join(fixture.home, '.coral', 'staging', 'project-ignore');
const durabilityMarkers = (): string[] =>
  readdirSync(durabilityArena()).filter((name) => name.startsWith('.durability-'));
const durabilityMarker = (target: string): string =>
  join(durabilityArena(), `.durability-${createHash('sha256').update(target).digest('hex')}.pending`);
const quarantineDir = (): string => join(durabilityArena(), 'quarantine');
const ARTIFACT_UNREADABLE_NOTICE =
  'An affected ignore file is not a readable regular file, the existing .git/info path is a symlink or not a directory, or its real directory lacks owner access. Remedy: make the project .gitignore files and .git/info/exclude readable regular files, replace a symlink or non-directory .git/info with a real directory, and give an existing .git/info directory owner read, write, and execute access. This also applies if a prior Coral run was interrupted after creating that directory.';

describe('project-ignore symlink maintenance', () => {
  it('refuses a regular file at the fallback arena and reports unavailable durability evidence', async () => {
    const arena = durabilityArena();
    mkdirSync(dirname(arena), { recursive: true });
    writeFileSync(arena, 'not a directory');
    vi.resetModules();
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { prepareProjectIgnoreStagingDir } = await import('../../../clients/hooks/lib/hook-utils.mjs');
    fixture.realpathPaths.length = 0;

    expect(prepareProjectIgnoreStagingDir()).toBeNull();
    expect(fixture.realpathPaths).not.toContain(arena);

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-unavailable'],
    });
    expect(existsSync(join(fixture.gitDir, 'info', 'exclude'))).toBe(false);
    expect(existsSync(link())).toBe(false);
    expect(readFileSync(arena, 'utf-8')).toBe('not a directory');
  });

  it('refuses a symlink at the fallback arena before canonicalizing it', async () => {
    const arena = durabilityArena();
    const outside = join(root, 'outside-arena');
    mkdirSync(dirname(arena), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, arena);
    vi.resetModules();
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { prepareProjectIgnoreStagingDir } = await import('../../../clients/hooks/lib/hook-utils.mjs');
    fixture.realpathPaths.length = 0;

    expect(prepareProjectIgnoreStagingDir()).toBeNull();
    expect(fixture.realpathPaths).not.toContain(arena);
  });

  it('refuses a fallback arena whose mode cannot be normalized', async () => {
    const arena = durabilityArena();
    mkdirSync(arena, { recursive: true });
    fixture.failChmodPath = arena;
    vi.resetModules();
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { prepareProjectIgnoreStagingDir } = await import('../../../clients/hooks/lib/hook-utils.mjs');
    fixture.realpathPaths.length = 0;

    expect(prepareProjectIgnoreStagingDir()).toBeNull();
    expect(fixture.realpathPaths).not.toContain(arena);
  });

  it.each([
    ['root wildcard characters', '*?[]\\', '\\*\\?\\[\\]\\\\'],
    ['nested wildcard characters', 'nested/*?[]\\/.claude/coral', 'nested/\\*\\?\\[\\]\\\\/.claude/coral'],
  ])('literal-escapes %s for gitignore syntax', async (_name, input, expected) => {
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { escapeGitignoreLiteralPath } = await import('../../../clients/hooks/lib/project-ignore.mjs');

    expect(escapeGitignoreLiteralPath(input)).toBe(expected);
  });

  it.each([
    ['root line feed', 'ev\nil'],
    ['root carriage return', 'ev\ril'],
    ['nested line feed', 'nested/ev\nil/.claude/coral'],
    ['nested carriage return', 'nested/ev\ril/.claude/coral'],
  ])('rejects an unrepresentable %s instead of returning a multiline pattern', async (_name, input) => {
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { escapeGitignoreLiteralPath } = await import('../../../clients/hooks/lib/project-ignore.mjs');

    expect(escapeGitignoreLiteralPath(input)).toBeNull();
  });

  it.each([
    ['line feed', '\n'],
    ['carriage return', '\r'],
  ])('refuses a nested project path containing a %s before creating staging or artifacts', async (_name, separator) => {
    const repositoryRoot = projectDir;
    projectDir = join(repositoryRoot, `ev${separator}il`);
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(join(projectDir, '.gitignore'), '', 'utf-8');

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'project-path-unrepresentable',
      residue: 'none',
    });
    expect(existsSync(join(fixture.home, '.coral'))).toBe(false);
    expect(existsSync(join(fixture.gitDir, 'coral'))).toBe(false);
    expect(existsSync(join(fixture.gitDir, 'info', 'exclude'))).toBe(false);
    expect(existsSync(link())).toBe(false);
  });

  it('refuses a repository identity change before mutating any artifact', async () => {
    const repointedGitDir = join(projectDir, '.metadata');
    mkdirSync(join(repointedGitDir, 'info'), { recursive: true });
    writeFileSync(join(projectDir, '.gitignore'), '.claude/coral\n');
    writeFileSync(join(projectDir, '.claude', '.gitignore'), 'coral\n');
    writeFileSync(join(fixture.gitDir, 'info', 'exclude'), 'external-before\n');
    writeFileSync(join(repointedGitDir, 'info', 'exclude'), 'in-tree-before\n');
    fixture.gitIdentities.push(fixture.gitDir, repointedGitDir);

    const result = await maintain('prod', false);

    expect(result.status).toBe('refused');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'project-context-unresolvable',
    });
    expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe('.claude/coral\n');
    expect(readFileSync(join(projectDir, '.claude', '.gitignore'), 'utf-8')).toBe('coral\n');
    expect(readFileSync(join(fixture.gitDir, 'info', 'exclude'), 'utf-8')).toBe('external-before\n');
    expect(readFileSync(join(repointedGitDir, 'info', 'exclude'), 'utf-8')).toBe('in-tree-before\n');
    expect(existsSync(join(fixture.home, '.coral'))).toBe(false);
    expect(existsSync(link())).toBe(false);
  });

  it('refuses a stale common Git directory before preparing or sweeping an arena', async () => {
    const staleCommonGitDir = join(root, 'common-before');
    const currentCommonGitDir = join(root, 'common-after');
    mkdirSync(join(staleCommonGitDir, 'info'), { recursive: true });
    mkdirSync(join(currentCommonGitDir, 'info'), { recursive: true });
    writeFileSync(join(fixture.gitDir, 'commondir'), '../common-before\n');
    writeFileSync(join(staleCommonGitDir, 'info', 'exclude'), 'stale-before\n');
    writeFileSync(join(currentCommonGitDir, 'info', 'exclude'), 'current-before\n');
    writeFileSync(join(projectDir, '.gitignore'), '.claude/coral\n');
    writeFileSync(join(projectDir, '.claude', '.gitignore'), 'coral\n');
    const context = await resolveContext();
    expect(context.gitDir).toBe(realpathSync(fixture.gitDir));
    expect(context.commonGitDir).toBe(realpathSync(staleCommonGitDir));
    const staleRun = join(staleCommonGitDir, 'coral', 'staging', 'project-ignore', '0-1');
    mkdirSync(staleRun, { recursive: true });

    writeFileSync(join(fixture.gitDir, 'commondir'), '../common-after\n');
    const result = await maintain('prod', false, context);

    expect(result.status).toBe('refused');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'project-context-unresolvable',
    });
    expect(existsSync(staleRun)).toBe(true);
    expect(existsSync(join(currentCommonGitDir, 'coral'))).toBe(false);
    expect(existsSync(join(fixture.home, '.coral'))).toBe(false);
    expect(readFileSync(join(staleCommonGitDir, 'info', 'exclude'), 'utf-8')).toBe('stale-before\n');
    expect(readFileSync(join(currentCommonGitDir, 'info', 'exclude'), 'utf-8')).toBe('current-before\n');
    expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe('.claude/coral\n');
    expect(readFileSync(join(projectDir, '.claude', '.gitignore'), 'utf-8')).toBe('coral\n');
    expect(existsSync(link())).toBe(false);
  });

  it('refuses a stale Git root before preparing or sweeping an arena', async () => {
    writeFileSync(join(fixture.gitDir, 'info', 'exclude'), 'exclude-before\n');
    writeFileSync(join(projectDir, '.gitignore'), '.claude/coral\n');
    writeFileSync(join(projectDir, '.claude', '.gitignore'), 'coral\n');
    writeFileSync(join(root, '.gitignore'), 'parent-before\n');
    const context = await resolveContext();
    expect(context.gitDir).toBe(realpathSync(fixture.gitDir));
    expect(context.gitRoot).toBe(realpathSync(projectDir));
    const staleRun = join(repositoryArena(), '0-1');
    mkdirSync(staleRun, { recursive: true });

    fixture.gitRoot = root;
    const result = await maintain('prod', false, context);

    expect(result.status).toBe('refused');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'project-context-unresolvable',
    });
    expect(existsSync(staleRun)).toBe(true);
    expect(existsSync(join(fixture.home, '.coral'))).toBe(false);
    expect(readFileSync(join(fixture.gitDir, 'info', 'exclude'), 'utf-8')).toBe('exclude-before\n');
    expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe('.claude/coral\n');
    expect(readFileSync(join(projectDir, '.claude', '.gitignore'), 'utf-8')).toBe('coral\n');
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe('parent-before\n');
    expect(existsSync(link())).toBe(false);
  });

  it('keeps retractions residue-free and leaves both project leaves absent when no symlink is requested', async () => {
    rmSync(join(projectDir, '.claude'), { recursive: true });
    rmSync(join(projectDir, '.gitignore'));
    fixture.failDirectoryFsyncPath = projectDir;
    fixture.failDirectoryFsyncCode = 'EINVAL';

    const first = await maintain('prod', false);
    fixture.fsyncedDirectoryPaths.length = 0;
    const second = await maintain('prod', false);
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');

    for (const result of [first, second]) {
      expect(result.status).toBe('complete');
      expect(result.artifacts.exclude).toEqual({ state: 'not-needed', residue: 'none' });
      expect(result.artifacts.symlink).toEqual({ state: 'not-requested' });
      expect(result.artifacts.scopedIgnoreRetraction).toEqual({ state: 'not-needed', residue: 'none' });
      expect(result.artifacts.rootIgnoreRetraction).toEqual({ state: 'not-needed', residue: 'none' });
      expect(isProjectIgnoreResult(result)).toBe(true);
    }
    expect(fixture.fsyncedDirectoryPaths).not.toContain(projectDir);
    expect(existsSync(join(projectDir, '.gitignore'))).toBe(false);
    expect(existsSync(join(projectDir, '.claude'))).toBe(false);
    expect(existsSync(join(fixture.home, '.coral', 'projects', 'owner-repo'))).toBe(false);
    expect(existsSync(join(fixture.home, '.coral', 'projects-dev', 'owner-repo'))).toBe(false);
  });

  it('creates it on first run', async () => {
    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(result.artifacts.symlink.state).toBe('created');
    expect(readlinkSync(link())).toBe(join(fixture.home, '.coral', 'projects', 'owner-repo'));
    expect(readFileSync(join(fixture.gitDir, 'info', 'exclude'), 'utf-8')).toBe('/.claude/coral\n');
  });

  it('refuses a symlinked projects root without creating the project leaf outside it', async () => {
    const outside = join(root, 'outside-projects');
    const projectsRoot = join(fixture.home, '.coral', 'projects');
    mkdirSync(join(fixture.home, '.coral'));
    mkdirSync(outside);
    symlinkSync(outside, projectsRoot);

    const result = await maintain('prod');
    const notices = renderProjectIgnoreResultNotices(result);

    expect(result.status).toBe('refused');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'symlink-target-unavailable',
    });
    expect(notices).toEqual([
      'The Coral symlink target has a structural conflict. Remedy: replace the symlink or non-directory component at the selected ~/.coral/projects or ~/.coral/projects-dev root, or at its project leaf, with a directory owned and writable by the current user.',
    ]);
    expect(notices[0]).not.toContain('It is attempted again at the next session start.');
    expect(existsSync(join(outside, 'owner-repo'))).toBe(false);
    expect(existsSync(link())).toBe(false);
  });

  it('reports an operational target mkdir failure as retryable', async () => {
    fixture.failMkdirPath = join(fixture.home, '.coral', 'projects', 'owner-repo');

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.symlink).toEqual({ state: 'refused', reason: 'publish-failed' });
    expect(renderProjectIgnoreResultNotices(result)).toEqual([
      'The filesystem refused an artifact update. Remedy: check permissions and free space for the affected Coral state, project, and Git metadata paths. It is attempted again at the next session start.',
    ]);
    expect(existsSync(link())).toBe(false);
  });

  // A conflict at ~/.coral itself never reaches the symlink target check: the arena this run needs
  // lives under the same component, so preparing it refuses first.
  it('refuses through the arena when the state root itself is a symlink', async () => {
    const outside = join(root, 'outside-coral-state');
    mkdirSync(outside);
    symlinkSync(outside, join(fixture.home, '.coral'));

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-unavailable'],
    });
    expect(result.artifacts.symlink).toEqual({ state: 'skipped', reason: 'upstream-refusal' });
    expect(existsSync(join(outside, 'projects'))).toBe(false);
    expect(existsSync(link())).toBe(false);
  });

  it('refuses an unavailable symlink target before publishing the exclude entry', async () => {
    const outside = join(root, 'outside-projects');
    const projectsRoot = join(fixture.home, '.coral', 'projects');
    const excludePath = join(fixture.gitDir, 'info', 'exclude');
    mkdirSync(join(fixture.home, '.coral'));
    mkdirSync(outside);
    symlinkSync(outside, projectsRoot);
    writeFileSync(excludePath, 'before\n');

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.exclude).toEqual({
      state: 'skipped',
      reason: 'upstream-refusal',
      residue: 'none',
    });
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'symlink-target-unavailable',
    });
    expect(readFileSync(excludePath, 'utf-8')).toBe('before\n');
  });

  it('refuses an unchanged link whose target root became unavailable', async () => {
    const outside = join(root, 'outside-projects');
    const projectsRoot = join(fixture.home, '.coral', 'projects');
    const target = join(projectsRoot, 'owner-repo');
    const excludePath = join(fixture.gitDir, 'info', 'exclude');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link());
    writeFileSync(excludePath, '/.claude/coral\n');
    rmSync(projectsRoot, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, projectsRoot);

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.exclude).toEqual({
      state: 'skipped',
      reason: 'upstream-refusal',
      residue: 'none',
    });
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'symlink-target-unavailable',
    });
    expect(renderProjectIgnoreResultNotices(result)).toEqual([
      'The Coral symlink target has a structural conflict. Remedy: replace the symlink or non-directory component at the selected ~/.coral/projects or ~/.coral/projects-dev root, or at its project leaf, with a directory owned and writable by the current user.',
    ]);
    expect(readFileSync(excludePath, 'utf-8')).toBe('/.claude/coral\n');
    expect(readlinkSync(link())).toBe(target);
  });

  it('installs and syncs the symlink marker before the final repoint rename', async () => {
    mkdirSync(durabilityArena(), { recursive: true });
    writeFileSync(join(fixture.gitDir, 'info', 'exclude'), '/.claude/coral\n');
    symlinkSync(join(fixture.home, '.coral', 'projects', 'owner-repo'), link());
    fixture.observeSymlinkPublicationPath = link();

    const result = await maintain('dev');

    expect(result.artifacts.symlink.state).toBe('repointed');
    expect(fixture.durabilityEvents).toEqual(['marker-rename', 'marker-parent-fsync', 'publish']);
  });

  it('removes the durability marker when symlink creation is refused', async () => {
    fixture.failSymlinkTarget = join(fixture.home, '.coral', 'projects', 'owner-repo');
    const marker = durabilityMarker(link());

    const result = await maintain('prod');

    expect(result.artifacts.symlink).toEqual({ state: 'refused', reason: 'publish-failed' });
    expect(existsSync(marker)).toBe(false);
  });

  it('reports retained durability evidence on the refused publication that created it', async () => {
    const excludePath = join(fixture.gitDir, 'info', 'exclude');
    const marker = durabilityMarker(excludePath);
    fixture.failLinkTo = excludePath;
    fixture.failUnlinkPath = marker;

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'publish-failed',
      residue: 'none',
      durability: { state: 'failed', reasons: ['durability-evidence-cleanup-failed'] },
    });
    expect(readFileSync(marker, 'utf-8')).toBe(excludePath);
    expect(renderProjectIgnoreResultNotices(result)).toContain(
      'Coral could not dispose of a pending durability record. Remedy: make the authorized project-ignore staging arena writable and repair any filesystem error blocking its removal or quarantine, then retry the maintenance. It is attempted again at the next session start.',
    );
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(isProjectIgnoreResult(result)).toBe(true);
    for (const reasons of [
      [],
      ['durability-sync-unsupported', 'durability-sync-failed'],
      ['durability-sync-failed', 'durability-sync-failed'],
      ['artifact-unreadable'],
    ]) {
      expect(
        isProjectIgnoreResult({
          ...result,
          artifacts: {
            ...result.artifacts,
            exclude: {
              ...result.artifacts.exclude,
              durability: { state: 'failed', reasons },
            },
          },
        }),
      ).toBe(false);
    }
  });

  it('reports retained durability evidence on a refused symlink creation', async () => {
    const marker = durabilityMarker(link());
    fixture.failSymlinkTarget = join(fixture.home, '.coral', 'projects', 'owner-repo');
    fixture.failUnlinkPath = marker;

    const result = await maintain('prod');

    expect(result.status).toBe('partial');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'publish-failed',
      durability: { state: 'failed', reasons: ['durability-evidence-cleanup-failed'] },
    });
    expect(readFileSync(marker, 'utf-8')).toBe(link());
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(isProjectIgnoreResult(result)).toBe(true);
  });

  it('reports retained durability evidence on a refused symlink repoint', async () => {
    await maintain('prod');
    const marker = durabilityMarker(link());
    fixture.failRenameTo = link();
    fixture.failUnlinkPath = marker;

    const result = await maintain('dev');

    expect(result.status).toBe('refused');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'publish-failed',
      residue: 'none',
      durability: { state: 'failed', reasons: ['durability-evidence-cleanup-failed'] },
    });
    expect(readFileSync(marker, 'utf-8')).toBe(link());
  });

  it('reports retained durability evidence when exclude-directory creation is refused', async () => {
    const infoDir = join(fixture.gitDir, 'info');
    const marker = durabilityMarker(infoDir);
    rmSync(infoDir, { recursive: true });
    fixture.failMkdirPath = infoDir;
    fixture.failUnlinkPath = marker;

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'publish-failed',
      residue: 'none',
      durability: { state: 'failed', reasons: ['durability-evidence-cleanup-failed'] },
    });
    expect(readFileSync(marker, 'utf-8')).toBe(infoDir);
  });

  it('does not claim a successful directory sync for an exclude publication that was refused', async () => {
    const infoDir = join(fixture.gitDir, 'info');
    const excludePath = join(infoDir, 'exclude');
    rmSync(infoDir, { recursive: true });
    fixture.failLinkTo = excludePath;

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'publish-failed',
      residue: 'none',
    });
    expect(durabilityMarkers()).toEqual([]);
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(
      isProjectIgnoreResult({
        ...result,
        artifacts: {
          ...result.artifacts,
          exclude: {
            ...result.artifacts.exclude,
            durability: { state: 'synced', reasons: [] },
          },
        },
      }),
    ).toBe(false);
  });

  it('reconciles an interrupted symlink creation when a later run does not request the link', async () => {
    fixture.failDirectoryFsyncPath = join(projectDir, '.claude');
    fixture.failDirectoryFsyncCode = 'EIO';

    const published = await maintain('prod');
    const marker = durabilityMarker(link());

    expect(published.status).toBe('partial');
    expect(published.artifacts.symlink).toEqual({
      state: 'created',
      durability: { state: 'failed', reasons: ['durability-sync-failed'] },
    });
    expect(readFileSync(marker, 'utf-8')).toBe(link());

    fixture.failDirectoryFsyncPath = null;
    fixture.failDirectoryFsyncCode = null;
    fixture.fsyncedDirectoryPaths.length = 0;
    const reconciled = await maintain('prod', false);

    expect(reconciled.status).toBe('complete');
    expect(reconciled.artifacts.symlink).toEqual({ state: 'not-requested' });
    expect(fixture.fsyncedDirectoryPaths).toContain(join(projectDir, '.claude'));
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a regular repository arena component non-retryably and names its replacement', async () => {
    const coralArenaComponent = join(fixture.gitDir, 'coral');
    writeFileSync(coralArenaComponent, 'not a directory');

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'repository-arena-conflict',
      residue: 'none',
    });
    expect(renderProjectIgnoreResultNotices(result)).toEqual([
      "The common Git directory's coral staging component is a symlink or non-directory. Remedy: replace <commonGitDir>/coral with a real directory before Coral maintenance runs again.",
    ]);
    expect(existsSync(link())).toBe(false);
    expect(existsSync(join(fixture.gitDir, 'info', 'exclude'))).toBe(false);
    expect(readFileSync(coralArenaComponent, 'utf-8')).toBe('not a directory');
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
    fixture.fsyncedDirectoryPaths.length = 0;

    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(result.artifacts.exclude).toEqual({ state: 'unchanged', residue: 'none' });
    expect(result.artifacts.symlink).toEqual({ state: 'unchanged' });
    expect(result.artifacts.scopedIgnoreRetraction).toEqual({ state: 'not-needed', residue: 'none' });
    expect(result.artifacts.rootIgnoreRetraction).toEqual({ state: 'not-needed', residue: 'none' });
    expect(fixture.fsyncedDirectoryPaths).toEqual([]);
    expect(readlinkSync(link())).toBe(join(fixture.home, '.coral', 'projects', 'owner-repo'));
  });

  it('does not sync or report partial for an unchanged symlink when directory sync is unsupported', async () => {
    await maintain('prod');
    fixture.failDirectoryFsyncPath = join(projectDir, '.claude');
    fixture.failDirectoryFsyncCode = 'EINVAL';
    fixture.fsyncedDirectoryPaths.length = 0;

    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(result.artifacts.symlink).toEqual({ state: 'unchanged' });
    expect(fixture.fsyncedDirectoryPaths).toEqual([]);
  });

  it('reconciles an interrupted symlink repoint on a later run', async () => {
    await maintain('prod');
    fixture.failDirectoryFsyncPath = join(projectDir, '.claude');
    fixture.failDirectoryFsyncCode = 'EIO';

    const published = await maintain('dev');
    const marker = durabilityMarker(link());

    expect(published.status).toBe('partial');
    expect(published.artifacts.symlink).toEqual({
      state: 'repointed',
      residue: 'none',
      durability: { state: 'failed', reasons: ['durability-sync-failed'] },
    });
    expect(readFileSync(marker, 'utf-8')).toBe(link());

    fixture.failDirectoryFsyncPath = null;
    fixture.failDirectoryFsyncCode = null;
    fixture.fsyncedDirectoryPaths.length = 0;
    const reconciled = await maintain('dev', false);

    expect(reconciled.status).toBe('complete');
    expect(reconciled.artifacts.symlink).toEqual({ state: 'not-requested' });
    expect(fixture.fsyncedDirectoryPaths).toContain(join(projectDir, '.claude'));
    expect(existsSync(marker)).toBe(false);
  });

  it('reconciles an interrupted publication when that artifact is not planned later', async () => {
    fixture.failDirectoryFsyncPath = join(fixture.gitDir, 'info');
    fixture.failDirectoryFsyncCode = 'EIO';

    const published = await maintain('prod');
    const excludePath = join(fixture.gitDir, 'info', 'exclude');

    expect(published.status).toBe('partial');
    expect(published.artifacts.exclude).toEqual({
      state: 'published',
      residue: 'none',
      durability: { state: 'failed', reasons: ['durability-sync-failed'] },
    });
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(isProjectIgnoreResult(published)).toBe(true);
    expect(readFileSync(excludePath, 'utf-8')).toBe('/.claude/coral\n');
    expect(durabilityMarkers()).toHaveLength(1);
    expect(readFileSync(join(durabilityArena(), durabilityMarkers()[0]), 'utf-8')).toBe(excludePath);
    expect(readdirSync(repositoryArena()).filter((name) => name.startsWith('.durability-'))).toEqual([]);

    rmSync(link());
    fixture.failDirectoryFsyncPath = null;
    fixture.failDirectoryFsyncCode = null;
    fixture.fsyncedDirectoryPaths.length = 0;
    const durable = await maintain('prod', false);

    expect(durable.status).toBe('complete');
    expect(durable.artifacts.exclude).toEqual({ state: 'not-needed', residue: 'none' });
    expect(durable.artifacts.symlink).toEqual({ state: 'not-requested' });
    expect(fixture.fsyncedDirectoryPaths).toContain(join(fixture.gitDir, 'info'));
    expect(durabilityMarkers()).toEqual([]);
    expect(isProjectIgnoreResult(durable)).toBe(true);
  });

  it('reconciles an interrupted publication after the repository identity changes', async () => {
    const commonBefore = join(root, 'common-before');
    const commonAfter = join(root, 'common-after');
    mkdirSync(join(commonBefore, 'info'), { recursive: true });
    mkdirSync(join(commonAfter, 'info'), { recursive: true });
    writeFileSync(join(fixture.gitDir, 'commondir'), `${commonBefore}\n`);
    fixture.failDirectoryFsyncPath = join(commonBefore, 'info');
    fixture.failDirectoryFsyncCode = 'EIO';

    const published = await maintain('prod');
    const oldExcludePath = join(commonBefore, 'info', 'exclude');
    const oldMarker = durabilityMarker(oldExcludePath);

    expect(published.status).toBe('partial');
    expect(readFileSync(oldMarker, 'utf-8')).toBe(oldExcludePath);
    expect(existsSync(join(commonBefore, 'coral', 'staging', 'project-ignore'))).toBe(true);
    rmSync(link());
    writeFileSync(join(fixture.gitDir, 'commondir'), `${commonAfter}\n`);
    fixture.failDirectoryFsyncPath = null;
    fixture.failDirectoryFsyncCode = null;
    fixture.fsyncedDirectoryPaths.length = 0;

    const durable = await maintain('prod', false);

    expect(durable.status).toBe('complete');
    expect(durable.artifacts.exclude).toEqual({ state: 'not-needed', residue: 'none' });
    expect(fixture.fsyncedDirectoryPaths).toContain(join(commonBefore, 'info'));
    expect(durabilityMarker(join(commonAfter, 'info', 'exclude'))).not.toBe(oldMarker);
    expect(existsSync(join(commonAfter, 'coral', 'staging', 'project-ignore'))).toBe(true);
    expect(existsSync(oldMarker)).toBe(false);
    expect(durabilityMarkers()).toEqual([]);
  });

  it('retains a marker and refuses planning when reconciliation cannot sync its parent', async () => {
    const excludePath = join(fixture.gitDir, 'info', 'exclude');
    fixture.failDirectoryFsyncPath = join(fixture.gitDir, 'info');
    fixture.failDirectoryFsyncCode = 'EIO';

    const published = await maintain('prod');
    const marker = durabilityMarker(excludePath);
    rmSync(link());
    fixture.fsyncedDirectoryPaths.length = 0;

    const refused = await maintain('prod', false);

    expect(published.status).toBe('partial');
    expect(refused.status).toBe('refused');
    expect(refused.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
    expect(refused.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-sync-failed'],
    });
    expect(refused.artifacts.exclude).toEqual({
      state: 'skipped',
      reason: 'upstream-refusal',
      residue: 'none',
    });
    expect(fixture.fsyncedDirectoryPaths).toContain(join(fixture.gitDir, 'info'));
    expect(readFileSync(marker, 'utf-8')).toBe(excludePath);
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(isProjectIgnoreResult(refused)).toBe(true);
  });

  it('discharges every later marker after an earlier reconciliation failure', async () => {
    await maintain('prod');
    const obligations = ['first', 'second', 'third']
      .map((name) => {
        const parent = join(root, `${name}-parent`);
        const target = join(parent, 'artifact');
        return { parent, target, marker: durabilityMarker(target) };
      })
      .sort((left, right) => (left.marker < right.marker ? -1 : left.marker > right.marker ? 1 : 0));
    const failed = obligations[0];
    const invalid = obligations[1];
    const unsupported = obligations[2];
    for (const obligation of obligations) mkdirSync(obligation.parent);
    writeFileSync(failed.marker, failed.target);
    const failedMarker = failed.marker;
    const invalidMarker = invalid.marker;
    const unsupportedMarker = unsupported.marker;
    writeFileSync(invalidMarker, 'not-an-absolute-path');
    writeFileSync(unsupportedMarker, unsupported.target);
    fixture.directoryFsyncFailures.set(failed.parent, 'EIO');
    fixture.directoryFsyncFailures.set(unsupported.parent, 'EINVAL');

    const result = await maintain('prod', false);

    expect(result.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
    expect(result.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-quarantined', 'durability-sync-failed', 'durability-sync-unsupported-discharged'],
    });
    expect(existsSync(failedMarker)).toBe(true);
    expect(existsSync(invalidMarker)).toBe(false);
    expect(existsSync(unsupportedMarker)).toBe(false);
    expect(readdirSync(quarantineDir())).toContain(basename(invalidMarker));
  });

  it('reports a discharged earlier marker and retained later markers independently', async () => {
    await maintain('prod');
    const obligations = ['earlier', 'later-one', 'later-two']
      .map((name) => {
        const parent = join(root, `${name}-parent`);
        const target = join(parent, 'artifact');
        return { parent, target, marker: durabilityMarker(target) };
      })
      .sort((left, right) => (left.marker < right.marker ? -1 : left.marker > right.marker ? 1 : 0));
    const discharged = obligations[0];
    const retained = obligations.slice(1);
    mkdirSync(discharged.parent);
    writeFileSync(discharged.marker, 'not-an-absolute-path');
    for (const obligation of retained) {
      mkdirSync(obligation.parent);
      writeFileSync(obligation.marker, obligation.target);
      fixture.directoryFsyncFailures.set(obligation.parent, 'EIO');
    }

    const result = await maintain('prod', false);

    expect(result.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-quarantined', 'durability-sync-failed'],
    });
    expect(existsSync(discharged.marker)).toBe(false);
    expect(readdirSync(quarantineDir())).toContain(basename(discharged.marker));
    for (const obligation of retained) {
      expect(readFileSync(obligation.marker, 'utf-8')).toBe(obligation.target);
    }
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(isProjectIgnoreResult(result)).toBe(true);
    for (const reasons of [
      [],
      ['durability-sync-failed', 'durability-evidence-quarantined'],
      ['durability-sync-failed', 'durability-sync-failed'],
      ['artifact-unreadable'],
    ]) {
      expect(
        isProjectIgnoreResult({
          ...result,
          artifacts: {
            ...result.artifacts,
            durabilityReconciliation: { state: 'refused', reasons },
          },
        }),
      ).toBe(false);
    }
  });

  it('reconciles a complete marker by reading the absolute obligation it names', async () => {
    await maintain('prod');
    const excludePath = join(fixture.gitDir, 'info', 'exclude');
    const marker = durabilityMarker(excludePath);
    writeFileSync(marker, excludePath);
    fixture.fsyncedDirectoryPaths.length = 0;

    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(result.artifacts.exclude).toEqual({ state: 'unchanged', residue: 'none' });
    expect(fixture.fsyncedDirectoryPaths).toContain(join(fixture.gitDir, 'info'));
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ['lstat', 'ENOENT', 'complete', 'reconciled'],
    ['open', 'ENOENT', 'complete', 'reconciled'],
    ['open', 'EACCES', 'refused', 'refused'],
    ['fstat', 'ENOENT', 'refused', 'refused'],
    ['read', 'ENOENT', 'refused', 'refused'],
  ] as const)(
    'classifies a %s marker observation failure with code %s without losing the marker',
    async (phase, code, expectedStatus, expectedReconciliation) => {
      await maintain('prod');
      const target = join(fixture.gitDir, 'info', 'exclude');
      const marker = durabilityMarker(target);
      writeFileSync(marker, target);
      fixture.failMarkerObservation = { phase, path: marker, code };

      const result = await maintain('prod', false);

      expect(result.status).toBe(expectedStatus);
      expect(result.artifacts.durabilityReconciliation).toEqual(
        expectedReconciliation === 'reconciled'
          ? { state: 'reconciled' }
          : { state: 'refused', reasons: ['durability-evidence-unreadable'] },
      );
      expect(readFileSync(marker, 'utf-8')).toBe(target);
    },
  );

  it('reports unreadable existing evidence separately from an evidence-recording failure', async () => {
    await maintain('prod');
    const target = join(fixture.gitDir, 'info', 'exclude');
    const marker = durabilityMarker(target);
    writeFileSync(marker, target);
    fixture.failMarkerObservation = { phase: 'read', path: marker, code: 'EIO' };

    const unavailable = await maintain('prod', false);

    expect(unavailable.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
    expect(unavailable.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-unreadable'],
    });
    expect(unavailable.artifacts.durabilityReconciliation).not.toEqual({
      state: 'refused',
      reasons: ['durability-evidence-unavailable'],
    });
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(quarantineDir())).toBe(false);

    const reconciled = await maintain('prod', false);

    expect(reconciled.status).toBe('complete');
    expect(existsSync(marker)).toBe(false);
  });

  it('reports a durability arena enumeration failure as unreadable evidence', async () => {
    await maintain('prod');
    fixture.failReaddirPath = durabilityArena();

    const result = await maintain('prod', false);

    expect(result.status).toBe('refused');
    expect(result.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-unreadable'],
    });
    expect(result.artifacts.durabilityReconciliation).not.toEqual({
      state: 'refused',
      reasons: ['durability-evidence-unavailable'],
    });
    // One unreadable arena refuses two independent things, and both name their own exit.
    expect(renderProjectIgnoreResultNotices(result)).toEqual([
      "Coral could not inspect or clean one of its staging arenas. Remedy: ensure ~/.coral/staging/project-ignore and the common Git directory's coral/staging/project-ignore path are writable real directories. It is attempted again at the next session start.",
      'Coral could not inspect pending durability evidence. Remedy: make the authorized project-ignore staging arena and its markers readable and owned by the current user, or repair the filesystem or storage device reporting the failure. It is attempted again at the next session start.',
    ]);
  });

  it('quarantines an undecodable marker once and leaves the next run clean', async () => {
    await maintain('prod');
    const marker = durabilityMarker(join(fixture.gitDir, 'info', 'exclude'));
    const undecodable = Buffer.concat([Buffer.from('/tmp/'), Buffer.from([0xff, 0xfe])]);
    writeFileSync(marker, undecodable);
    fixture.fsyncedDirectoryPaths.length = 0;

    const quarantined = await maintain('prod');

    expect(quarantined.status).toBe('refused');
    expect(quarantined.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
    expect(quarantined.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-quarantined'],
    });
    expect(existsSync(marker)).toBe(false);
    const quarantinedNames = readdirSync(quarantineDir());
    expect(quarantinedNames).toHaveLength(1);
    expect(readFileSync(join(quarantineDir(), quarantinedNames[0]))).toEqual(undecodable);
    expect(fixture.fsyncedDirectoryPaths).not.toContain('/tmp');
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(isProjectIgnoreResult(quarantined)).toBe(true);

    const clean = await maintain('prod');

    expect(clean.status).toBe('complete');
    expect(clean.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
    expect(clean.artifacts.durabilityReconciliation).toEqual({ state: 'reconciled' });
    expect(readdirSync(quarantineDir())).toEqual(quarantinedNames);
  });

  it('quarantines a marker that does not name an absolute target', async () => {
    await maintain('prod');
    const marker = durabilityMarker(join(fixture.gitDir, 'info', 'exclude'));
    writeFileSync(marker, 'not-an-absolute-path');

    const result = await maintain('prod');

    expect(result.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
    expect(result.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-quarantined'],
    });
    expect(existsSync(marker)).toBe(false);
    const quarantinedNames = readdirSync(quarantineDir());
    expect(quarantinedNames).toHaveLength(1);
    expect(readFileSync(join(quarantineDir(), quarantinedNames[0]), 'utf-8')).toBe('not-an-absolute-path');
  });

  it('quarantines a marker whose valid target does not match its filename', async () => {
    await maintain('prod');
    const boundTarget = join(root, 'bound-parent', 'artifact');
    const namedParent = join(root, 'named-parent');
    const namedTarget = join(namedParent, 'artifact');
    mkdirSync(join(root, 'bound-parent'));
    mkdirSync(namedParent);
    const marker = durabilityMarker(boundTarget);
    writeFileSync(marker, namedTarget);
    fixture.fsyncedDirectoryPaths.length = 0;

    const result = await maintain('prod', false);

    expect(result.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-quarantined'],
    });
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(quarantineDir(), basename(marker)), 'utf-8')).toBe(namedTarget);
    expect(fixture.fsyncedDirectoryPaths).not.toContain(namedParent);
  });

  it('uses a numeric suffix when the quarantine destination is occupied', async () => {
    await maintain('prod');
    const marker = durabilityMarker(join(fixture.gitDir, 'info', 'exclude'));
    writeFileSync(marker, 'not-an-absolute-path');
    mkdirSync(quarantineDir());
    const occupied = join(quarantineDir(), basename(marker));
    writeFileSync(occupied, 'existing evidence');

    const result = await maintain('prod');

    expect(result.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
    expect(result.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-quarantined'],
    });
    expect(readFileSync(occupied, 'utf-8')).toBe('existing evidence');
    expect(readFileSync(`${occupied}.1`, 'utf-8')).toBe('not-an-absolute-path');
  });

  it('rolls a quarantine move back when its parent sync fails', async () => {
    await maintain('prod');
    const marker = durabilityMarker(join(fixture.gitDir, 'info', 'exclude'));
    writeFileSync(marker, 'not-an-absolute-path');
    mkdirSync(quarantineDir());
    fixture.failDirectoryFsyncPath = quarantineDir();
    fixture.failDirectoryFsyncCode = 'EIO';
    fixture.fsyncedDirectoryPaths.length = 0;

    const result = await maintain('prod');

    expect(result.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
    expect(result.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-cleanup-failed'],
    });
    expect(fixture.fsyncedDirectoryPaths).toContain(quarantineDir());
    expect(fixture.fsyncedDirectoryPaths).toContain(durabilityArena());
    expect(readFileSync(marker, 'utf-8')).toBe('not-an-absolute-path');
    expect(readdirSync(quarantineDir())).toEqual([]);
  });

  it('retains an undecodable marker when its quarantine move fails', async () => {
    await maintain('prod');
    const marker = durabilityMarker(join(fixture.gitDir, 'info', 'exclude'));
    writeFileSync(marker, Buffer.from([0xc3, 0x28]));
    fixture.failQuarantineRename = true;

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
    expect(result.artifacts.durabilityReconciliation).toEqual({
      state: 'refused',
      reasons: ['durability-evidence-cleanup-failed'],
    });
    expect(renderProjectIgnoreResultNotices(result)).toContain(
      'Coral could not dispose of a pending durability record. Remedy: make the authorized project-ignore staging arena writable and repair any filesystem error blocking its removal or quarantine, then retry the maintenance. It is attempted again at the next session start.',
    );
    expect(existsSync(marker)).toBe(true);
  });

  it('removes a marker whose named parent no longer exists', async () => {
    await maintain('prod');
    const target = join(root, 'removed-parent', 'artifact');
    const marker = durabilityMarker(target);
    writeFileSync(marker, target);

    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(existsSync(marker)).toBe(false);
  });

  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])(
    'discharges a reconciliation record for unsupported directory sync code %s',
    async (unsupportedCode) => {
      await maintain('prod');
      const excludePath = join(fixture.gitDir, 'info', 'exclude');
      const marker = durabilityMarker(excludePath);
      writeFileSync(marker, excludePath);
      fixture.failDirectoryFsyncPath = join(fixture.gitDir, 'info');
      fixture.failDirectoryFsyncCode = unsupportedCode;

      const discharged = await maintain('prod');

      expect(discharged.status).toBe('refused');
      expect(discharged.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
      expect(discharged.artifacts.durabilityReconciliation).toEqual({
        state: 'refused',
        reasons: ['durability-sync-unsupported-discharged'],
      });
      expect(renderProjectIgnoreResultNotices(discharged)).toEqual([
        'The platform does not support syncing the parent named by a pending durability record, so Coral discharged that record and will not retry it.',
      ]);
      expect(existsSync(marker)).toBe(false);

      fixture.fsyncedDirectoryPaths.length = 0;
      const clean = await maintain('prod');

      expect(clean.status).toBe('complete');
      expect(clean.artifacts.arenaSweep).toEqual({ state: 'unchanged' });
      expect(clean.artifacts.durabilityReconciliation).toEqual({ state: 'reconciled' });
      expect(fixture.fsyncedDirectoryPaths).toEqual([]);
    },
  );

  it('refuses to sync a regular-file parent and reconciles it as unreachable', async () => {
    await maintain('prod');
    const parent = join(root, 'former-parent');
    const target = join(parent, 'artifact');
    writeFileSync(parent, 'not a directory');
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { fsyncParent } = await import('../../../clients/hooks/lib/project-ignore.mjs');

    expect(fsyncParent(target)).toEqual({
      state: 'failed',
      reasons: ['durability-sync-failed'],
    });
    expect(fixture.fsyncedDirectoryPaths).not.toContain(parent);

    const marker = durabilityMarker(target);
    writeFileSync(marker, target);
    const reconciled = await maintain('prod');

    expect(reconciled.status).toBe('complete');
    expect(existsSync(marker)).toBe(false);
    expect(fixture.fsyncedDirectoryPaths).not.toContain(parent);
  });

  it('leaves no final evidence when marker installation is interrupted', async () => {
    const excludePath = join(fixture.gitDir, 'info', 'exclude');
    const marker = durabilityMarker(excludePath);
    fixture.failDurabilityMarkerFsync = true;

    const interrupted = await maintain('prod');

    expect(interrupted.status).toBe('refused');
    expect(interrupted.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'durability-evidence-unavailable',
      residue: 'none',
    });
    expect(existsSync(marker)).toBe(false);
    expect(durabilityMarkers()).toEqual([]);

    fixture.fsyncedDirectoryPaths.length = 0;
    const later = await maintain('prod', false);

    expect(later.status).toBe('complete');
    expect(later.artifacts.exclude).toEqual({ state: 'not-needed', residue: 'none' });
    expect(fixture.fsyncedDirectoryPaths).not.toContain(join(fixture.gitDir, 'info'));
    expect(durabilityMarkers()).toEqual([]);
  });

  it('makes a marker readable across runs despite an owner-read-masking umask', async () => {
    await maintain('prod');
    const marker = durabilityMarker(link());
    const previousUmask = process.umask(0o400);
    try {
      fixture.failDirectoryFsyncPath = join(projectDir, '.claude');
      fixture.failDirectoryFsyncCode = 'EIO';

      const published = await maintain('dev');

      expect(published.status).toBe('partial');
      expect(existsSync(marker)).toBe(true);
      expect(statSync(marker).mode & 0o777).toBe(0o600);

      fixture.failDirectoryFsyncPath = null;
      fixture.failDirectoryFsyncCode = null;
      const reconciled = await maintain('dev', false);

      expect(reconciled.status).toBe('complete');
      expect(reconciled.artifacts.durabilityReconciliation).toEqual({ state: 'reconciled' });
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.umask(previousUmask);
      restoreOwnerAccess(root);
    }
  });

  it('adds owner access to a new ignore artifact without overriding the umask for anyone else', async () => {
    const excludePath = join(fixture.gitDir, 'info', 'exclude');
    const target = join(fixture.home, '.coral', 'projects', 'owner-repo');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link());
    const previousUmask = process.umask(0o427);
    try {
      const result = await maintain('prod', false);

      expect(result.status).toBe('complete');
      expect(readFileSync(excludePath, 'utf-8')).toContain('/.claude/coral');
      expect(statSync(excludePath).mode & 0o777).toBe(0o640);
      expect(statSync(excludePath).mode & 0o077).toBe(0o040);
    } finally {
      process.umask(previousUmask);
      restoreOwnerAccess(root);
    }
  });

  it('adds owner access to a new Git info directory without overriding the umask for anyone else', async () => {
    const infoDir = join(fixture.gitDir, 'info');
    const excludePath = join(infoDir, 'exclude');
    rmSync(infoDir, { recursive: true });
    const previousUmask = process.umask(0o727);
    try {
      const result = await maintain('prod');

      expect(result.status).toBe('complete');
      expect(result.artifacts.exclude.state).toBe('published');
      expect(result.artifacts.symlink.state).toBe('created');
      expect(readFileSync(excludePath, 'utf-8')).toContain('/.claude/coral');
      expect(statSync(infoDir).mode & 0o777).toBe(0o750);
    } finally {
      process.umask(previousUmask);
      restoreOwnerAccess(root);
    }
  });

  it('refuses an existing unusable Git info directory without changing its mode', async () => {
    const infoDir = join(fixture.gitDir, 'info');
    const excludePath = join(infoDir, 'exclude');
    chmodSync(infoDir, 0o077);
    try {
      const result = await maintain('prod');

      expect(result.status).toBe('refused');
      expect(result.artifacts.exclude).toEqual({
        state: 'refused',
        reason: 'artifact-unreadable',
        residue: 'none',
      });
      expect(result.artifacts.symlink).toEqual({ state: 'skipped', reason: 'upstream-refusal' });
      expect(existsSync(excludePath)).toBe(false);
      expect(existsSync(link())).toBe(false);
      expect(statSync(infoDir).mode & 0o777).toBe(0o077);
      expect(renderProjectIgnoreResultNotices(result)).toContain(ARTIFACT_UNREADABLE_NOTICE);
    } finally {
      restoreOwnerAccess(root);
    }
  });

  it.each(['symlink', 'regular file'] as const)(
    'refuses a %s at .git/info before publishing any artifact',
    async (shape) => {
      const infoDir = join(fixture.gitDir, 'info');
      const externalInfo = join(root, 'external-info');
      rmSync(infoDir, { recursive: true });
      if (shape === 'symlink') {
        mkdirSync(externalInfo);
        writeFileSync(join(externalInfo, 'operator-entry'), 'preserve me');
        symlinkSync(externalInfo, infoDir);
      } else {
        writeFileSync(infoDir, 'operator metadata');
      }
      fixture.lstatPaths.length = 0;

      const result = await maintain('prod');

      expect(result.status).toBe('refused');
      expect(result.artifacts.exclude).toEqual({
        state: 'refused',
        reason: 'artifact-unreadable',
        residue: 'none',
      });
      expect(result.artifacts.symlink).toEqual({ state: 'skipped', reason: 'upstream-refusal' });
      expect(result.artifacts.scopedIgnoreRetraction).toEqual({
        state: 'skipped',
        reason: 'upstream-refusal',
        residue: 'none',
      });
      expect(result.artifacts.rootIgnoreRetraction).toEqual({
        state: 'skipped',
        reason: 'upstream-refusal',
        residue: 'none',
      });
      expect(renderProjectIgnoreResultNotices(result)).toContain(ARTIFACT_UNREADABLE_NOTICE);
      expect(renderProjectIgnoreResultNotices(result)[0]).not.toContain(
        'It is attempted again at the next session start.',
      );
      expect(fixture.lstatPaths).toContain(infoDir);
      expect(fixture.lstatPaths).not.toContain(join(infoDir, 'exclude'));
      expect(existsSync(join(infoDir, 'exclude'))).toBe(false);
      expect(existsSync(link())).toBe(false);
      expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe('');
      expect(durabilityMarkers()).toEqual([]);
      expect(fixture.durabilityEvents).toEqual([]);
      if (shape === 'symlink') {
        expect(lstatSync(infoDir).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(externalInfo, 'operator-entry'), 'utf-8')).toBe('preserve me');
        expect(readdirSync(externalInfo)).toEqual(['operator-entry']);
      } else {
        expect(lstatSync(infoDir).isFile()).toBe(true);
        expect(readFileSync(infoDir, 'utf-8')).toBe('operator metadata');
      }
    },
  );

  it.each([
    ['EACCES', 'artifact-unreadable', false],
    ['EIO', 'artifact-observation-failed', true],
  ] as const)(
    'classifies a non-missing .git/info %s failure before observing or publishing the exclude',
    async (code, reason, retryable) => {
      const infoDir = join(fixture.gitDir, 'info');
      const excludePath = join(infoDir, 'exclude');
      fixture.failMarkerObservation = { phase: 'lstat', path: infoDir, code };
      fixture.lstatPaths.length = 0;

      const result = await maintain('prod');

      expect(result.status).toBe('refused');
      expect(result.artifacts.exclude).toEqual({
        state: 'refused',
        reason,
        residue: 'none',
      });
      expect(result.artifacts.symlink).toEqual({ state: 'skipped', reason: 'upstream-refusal' });
      expect(renderProjectIgnoreResultNotices(result)[0].includes('next session start')).toBe(retryable);
      expect(fixture.lstatPaths).toContain(infoDir);
      expect(fixture.lstatPaths).not.toContain(excludePath);
      expect(existsSync(excludePath)).toBe(false);
      expect(existsSync(link())).toBe(false);
      expect(durabilityMarkers()).toEqual([]);
      expect(fixture.durabilityEvents).toEqual([]);
    },
  );

  it('reports a retained marker when exclude publication cannot record durable evidence', async () => {
    const excludePath = join(fixture.gitDir, 'info', 'exclude');
    const marker = durabilityMarker(excludePath);
    fixture.failDirectoryFsyncPath = durabilityArena();
    fixture.failDirectoryFsyncCode = 'EIO';
    fixture.failUnlinkPath = marker;

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'durability-evidence-unavailable',
      residue: 'none',
      durability: { state: 'failed', reasons: ['durability-evidence-cleanup-failed'] },
    });
    expect(existsSync(excludePath)).toBe(false);
    expect(existsSync(link())).toBe(false);
    expect(readFileSync(marker, 'utf-8')).toBe(excludePath);
  });

  it('reports a retained marker when symlink creation cannot record durable evidence', async () => {
    const excludePath = join(fixture.gitDir, 'info', 'exclude');
    const marker = durabilityMarker(link());
    writeFileSync(excludePath, '/.claude/coral\n');
    fixture.failDirectoryFsyncPath = durabilityArena();
    fixture.failDirectoryFsyncCode = 'EIO';
    fixture.failUnlinkPath = marker;

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'durability-evidence-unavailable',
      durability: { state: 'failed', reasons: ['durability-evidence-cleanup-failed'] },
    });
    expect(existsSync(link())).toBe(false);
    expect(readFileSync(marker, 'utf-8')).toBe(link());
  });

  it('reports a retained marker when symlink repoint cannot record durable evidence', async () => {
    await maintain('prod');
    const original = readlinkSync(link());
    const marker = durabilityMarker(link());
    fixture.failDirectoryFsyncPath = durabilityArena();
    fixture.failDirectoryFsyncCode = 'EIO';
    fixture.failUnlinkPath = marker;

    const result = await maintain('dev');

    expect(result.status).toBe('refused');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'durability-evidence-unavailable',
      residue: 'none',
      durability: { state: 'failed', reasons: ['durability-evidence-cleanup-failed'] },
    });
    expect(readlinkSync(link())).toBe(original);
    expect(readFileSync(marker, 'utf-8')).toBe(link());
  });

  it('reports a narrowly unsupported directory sync separately from an I/O failure', async () => {
    fixture.failDirectoryFsyncPath = join(fixture.gitDir, 'info');
    fixture.failDirectoryFsyncCode = 'EINVAL';

    const result = await maintain('prod');

    expect(result.status).toBe('partial');
    expect(result.artifacts.exclude).toEqual({
      state: 'published',
      residue: 'none',
      durability: { state: 'unsupported', reasons: ['durability-sync-unsupported'] },
    });
    expect(renderProjectIgnoreResultNotices(result)).toEqual([
      'The platform does not support syncing an affected parent directory, so Coral retained the publication marker for reconciliation. It is attempted again at the next session start.',
    ]);
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(isProjectIgnoreResult(result)).toBe(true);
  });

  it('keeps every distinct durability reason on one exclude artifact', async () => {
    const infoDir = join(fixture.gitDir, 'info');
    rmSync(infoDir, { recursive: true });
    fixture.directoryFsyncFailures.set(fixture.gitDir, 'EINVAL');
    fixture.directoryFsyncFailures.set(infoDir, 'EIO');

    const result = await maintain('prod');

    expect(result.status).toBe('partial');
    expect(result.artifacts.exclude).toEqual({
      state: 'published',
      residue: 'none',
      durability: {
        state: 'failed',
        reasons: ['durability-sync-failed', 'durability-sync-unsupported'],
      },
    });
    expect(renderProjectIgnoreResultNotices(result)).toEqual([
      'Coral could not sync the parent named by a retained durability record. Remedy: check the filesystem and storage device; the next run will reconcile that record before planning project artifacts. It is attempted again at the next session start.',
      'The platform does not support syncing an affected parent directory, so Coral retained the publication marker for reconciliation. It is attempted again at the next session start.',
    ]);
    expect(durabilityMarkers()).toHaveLength(2);
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(isProjectIgnoreResult(result)).toBe(true);
  });

  it('syncs the Git directory after creating info and before syncing the published exclude file', async () => {
    rmSync(join(fixture.gitDir, 'info'), { recursive: true });
    fixture.fsyncedDirectoryPaths.length = 0;

    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    const gitDirectorySync = fixture.fsyncedDirectoryPaths.indexOf(fixture.gitDir);
    const infoDirectorySync = fixture.fsyncedDirectoryPaths.indexOf(join(fixture.gitDir, 'info'));
    expect(gitDirectorySync).toBeGreaterThanOrEqual(0);
    expect(infoDirectorySync).toBeGreaterThan(gitDirectorySync);
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

  it('refuses retryably when an existing link target cannot be observed', async () => {
    const target = join(fixture.home, '.coral', 'projects', 'owner-repo');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link());
    fixture.failReadlinkPath = link();

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'symlink-observation-failed',
    });
    expect(renderProjectIgnoreResultNotices(result)).toEqual([
      'Coral could not inspect the project .claude/coral path. Remedy: make .claude and .claude/coral observable by the current user, including owner search access on .claude, and repair any filesystem error blocking inspection. It is attempted again at the next session start.',
    ]);
    expect(readlinkSync(link())).toBe(target);
    expect(existsSync(join(fixture.gitDir, 'info', 'exclude'))).toBe(false);
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(isProjectIgnoreResult(result)).toBe(true);
  });

  it('refuses retryably when the link path itself cannot be observed', async () => {
    fixture.failLstatPath = link();

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'symlink-observation-failed',
    });
    expect(existsSync(link())).toBe(false);
    expect(existsSync(join(fixture.gitDir, 'info', 'exclude'))).toBe(false);
  });

  it('retries a failed .claude observation and succeeds once the directory is observable', async () => {
    fixture.failLstatPath = join(projectDir, '.claude');

    const refused = await maintain('prod');
    const completed = await maintain('prod');

    // The legacy scan reaches .claude before the link does, so the one unobservable directory is
    // reported once and everything downstream of it is skipped rather than diagnosed again.
    expect(refused.status).toBe('refused');
    expect(refused.artifacts.legacySweep).toEqual({
      state: 'refused',
      reason: 'legacy-sweep-observation-failed',
      path: '.claude',
      count: 0,
    });
    expect(refused.artifacts.symlink).toEqual({ state: 'skipped', reason: 'upstream-refusal' });
    expect(completed.status).toBe('complete');
    expect(completed.artifacts.symlink.state).toBe('created');
  });

  it('refuses retryably when the exact second preflight .claude observation fails', async () => {
    const claudeDir = join(projectDir, '.claude');
    const scopedIgnore = join(claudeDir, '.gitignore');
    writeFileSync(scopedIgnore, 'coral\n');
    fixture.failLstatAfter = { path: claudeDir, successesRemaining: 3 };

    const result = await maintain('prod', false);

    expect(result.status).toBe('refused');
    expect(result.artifacts.scopedIgnoreRetraction).toEqual({
      state: 'refused',
      reason: 'artifact-observation-failed',
      residue: 'none',
    });
    expect(renderProjectIgnoreResultNotices(result)).toEqual([
      'Coral could not inspect or re-read an affected ignore file. Remedy: make the file and its parent directories observable by the current user, or repair the filesystem error blocking inspection. It is attempted again at the next session start.',
    ]);
    expect(readFileSync(scopedIgnore, 'utf-8')).toBe('coral\n');
  });

  it('retracts the Git-root legacy line through a non-directory .claude when creation is off', async () => {
    const claudeDir = join(projectDir, '.claude');
    rmSync(claudeDir, { recursive: true });
    writeFileSync(claudeDir, 'not a directory');
    writeFileSync(join(projectDir, '.gitignore'), '.claude/coral\nkeep-me\n');

    const result = await maintain('prod', false);

    expect(result.status).toBe('complete');
    expect(result.artifacts.symlink).toEqual({ state: 'not-requested' });
    expect(result.artifacts.scopedIgnoreRetraction).toEqual({
      state: 'not-needed',
      residue: 'none',
    });
    expect(result.artifacts.rootIgnoreRetraction).toEqual({
      state: 'published',
      residue: 'none',
      durability: { state: 'synced', reasons: [] },
    });
    expect(readFileSync(join(projectDir, '.gitignore'), 'utf-8')).toBe('keep-me\n');
    expect(readFileSync(claudeDir, 'utf-8')).toBe('not a directory');
  });

  it('refuses retryably without reporting a conflict when .claude hides the link path', async () => {
    chmodSync(join(projectDir, '.claude'), 0o000);
    try {
      const result = await maintain('prod');
      const notices = renderProjectIgnoreResultNotices(result);

      expect(result.status).toBe('refused');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('observable by the current user');
      expect(notices[0]).toContain('It is attempted again at the next session start.');
      expect(JSON.stringify(result)).not.toContain('symlink-conflict');
    } finally {
      chmodSync(join(projectDir, '.claude'), 0o700);
    }
    expect(existsSync(link())).toBe(false);
    expect(existsSync(join(fixture.gitDir, 'info', 'exclude'))).toBe(false);
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

  it('bounds every context read by the aggregate allowance remaining for the owner chain', async () => {
    await maintain('prod');
    execFileSyncMock.mockClear();
    execSyncMock.mockClear();

    await maintain('prod');

    expect(
      execFileSyncMock,
      'both Git-directory and repository-root resolutions around the lock',
    ).toHaveBeenCalledTimes(4);
    expect(
      execSyncMock,
      'git remote get-url origin, to confirm the existing link is not outgrown',
    ).toHaveBeenCalledTimes(1);
    const contextTimeouts = (execFileSyncMock.mock.calls as unknown[][]).map(
      (call) => (call[2] as { timeout?: number } | undefined)?.timeout ?? 0,
    );
    const remoteProbeTimeout = ((execSyncMock.mock.calls as unknown[][])[0]?.[1] as { timeout?: number } | undefined)
      ?.timeout;
    expect(contextTimeouts.every((timeout) => timeout > 0)).toBe(true);
    expect(contextTimeouts.every((timeout) => timeout <= PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS)).toBe(true);
    for (let index = 1; index < contextTimeouts.length; index += 1) {
      expect(contextTimeouts[index]).toBeLessThanOrEqual(contextTimeouts[index - 1]);
    }
    expect(PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS + (remoteProbeTimeout ?? 0)).toBe(3500);
  });

  it('gives the owner chain more time than its aggregate bounded-subprocess allowance', async () => {
    await maintain('prod');
    execFileSyncMock.mockClear();
    execSyncMock.mockClear();

    await maintain('prod');

    const remoteProbeTimeout =
      ((execSyncMock.mock.calls as unknown[][])[0]?.[1] as { timeout?: number } | undefined)?.timeout ?? 0;
    const childBound = PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS + remoteProbeTimeout;

    expect(
      PROJECT_IGNORE_SPAWN_TIMEOUT_MS,
      "the parent's spawnSync timeout must leave margin beyond the chain's aggregate subprocess bound",
    ).toBeGreaterThan(childBound);
  });

  it('allows one 400 ms context read to use time donated by faster reads', async () => {
    const clock = vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => fixture.monotonicNs);
    fixture.gitReadDurationsMs.push(400, 0, 0, 0);
    execFileSyncMock.mockClear();

    try {
      const result = await maintain('prod');
      const timeouts = (execFileSyncMock.mock.calls as unknown[][]).map(
        (call) => (call[2] as { timeout?: number } | undefined)?.timeout,
      );

      expect(result.status).toBe('complete');
      expect(timeouts).toEqual([1500, 1100, 1100, 1100]);
    } finally {
      clock.mockRestore();
    }
  });

  it('refuses context reads whose combined time exhausts the aggregate allowance', async () => {
    const clock = vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => fixture.monotonicNs);
    fixture.gitReadDurationsMs.push(400, 400, 400, 400);
    execFileSyncMock.mockClear();

    try {
      const result = await maintain('prod');
      const timeouts = (execFileSyncMock.mock.calls as unknown[][]).map(
        (call) => (call[2] as { timeout?: number } | undefined)?.timeout,
      );

      expect(result.status).toBe('refused');
      expect(result.artifacts.symlink).toEqual({
        state: 'refused',
        reason: 'project-context-unresolvable',
      });
      expect(timeouts).toEqual([1500, 1100, 700, 300]);
    } finally {
      clock.mockRestore();
    }
  });

  it('renders every non-success maintenance outcome exercised through SessionStart', () => {
    for (const outcome of [
      'killed',
      'maintenance-busy',
      'maintenance-lock-unavailable',
      'no-output',
      'unparseable-output',
      'partial',
      'failed',
    ]) {
      expect(projectIgnoreOutcomeNotice(outcome)).not.toBeNull();
    }
  });

  it('accepts exactly the explicit artifact and refusal-reason matrix', async () => {
    const { isProjectIgnoreResult, PROJECT_IGNORE_REASONS } = await import(
      // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
      '../../../clients/hooks/lib/project-ignore-result.mjs'
    );

    expect(new Set(Object.keys(PROJECT_IGNORE_REASON_NOTICES))).toEqual(new Set(PROJECT_IGNORE_REASONS));
    const expectedMatrix = {
      arenaSweep: ['arena-sweep-failed', 'arena-structural-conflict'],
      durabilityReconciliation: [
        'durability-evidence-unavailable',
        'durability-evidence-unreadable',
        'durability-evidence-quarantined',
        'durability-evidence-cleanup-failed',
        'durability-sync-unsupported-discharged',
        'durability-sync-failed',
      ],
      legacySweep: ['legacy-sweep-failed', 'legacy-sweep-observation-failed'],
      exclude: [
        'project-path-unrepresentable',
        'exclude-path-unresolvable',
        'repository-arena-unavailable',
        'repository-arena-conflict',
        'artifact-unreadable',
        'artifact-too-large',
        'artifact-changed',
        'artifact-observation-failed',
        'staging-device-mismatch',
        'publish-cross-device',
        'publish-failed',
        'durability-evidence-unavailable',
      ],
      symlink: [
        'project-context-unresolvable',
        'claude-directory-missing',
        'claude-directory-invalid',
        'staging-device-mismatch',
        'publish-cross-device',
        'publish-failed',
        'symlink-target-unavailable',
        'symlink-observation-failed',
        'durability-evidence-unavailable',
        'symlink-conflict',
      ],
      scopedIgnoreRetraction: [
        'artifact-unreadable',
        'artifact-too-large',
        'artifact-changed',
        'artifact-observation-failed',
        'staging-device-mismatch',
        'publish-cross-device',
        'publish-failed',
        'durability-evidence-unavailable',
      ],
      rootIgnoreRetraction: [
        'artifact-unreadable',
        'artifact-too-large',
        'artifact-changed',
        'artifact-observation-failed',
        'staging-device-mismatch',
        'publish-cross-device',
        'publish-failed',
        'durability-evidence-unavailable',
      ],
    } as const;

    const baseArtifacts = {
      arenaSweep: { state: 'unchanged' },
      durabilityReconciliation: { state: 'reconciled' },
      legacySweep: { state: 'unchanged' },
      exclude: { state: 'not-needed', residue: 'none' },
      symlink: { state: 'not-requested' },
      scopedIgnoreRetraction: { state: 'not-needed', residue: 'none' },
      rootIgnoreRetraction: { state: 'not-needed', residue: 'none' },
    };
    const allRefusalReasons = [...new Set(Object.values(expectedMatrix).flat())];
    const nonRefusalReasons = ['durability-sync-unsupported', 'staging-cleanup-failed', 'upstream-refusal'];
    const allReasons = [...allRefusalReasons, ...nonRefusalReasons];
    expect(new Set(PROJECT_IGNORE_REASONS)).toEqual(new Set(allReasons));
    for (const [artifact, allowedReasons] of Object.entries(expectedMatrix)) {
      const expectedReasons = new Set<string>(allowedReasons);
      for (const reason of allReasons) {
        const refusedArtifact =
          artifact === 'durabilityReconciliation'
            ? { state: 'refused', reasons: [reason] }
            : artifact === 'legacySweep'
              ? {
                  state: 'refused',
                  reason,
                  path: reason === 'legacy-sweep-observation-failed' ? '.claude' : '.gitignore.coral-1-2.tmp',
                  count: 0,
                }
              : artifact === 'arenaSweep' || artifact === 'symlink'
                ? { state: 'refused', reason }
                : { state: 'refused', reason, residue: 'none' };
        const accepted = isProjectIgnoreResult({
          status: artifact === 'arenaSweep' ? 'complete' : 'refused',
          artifacts: { ...baseArtifacts, [artifact]: refusedArtifact },
        });

        expect(accepted, `${artifact}/${reason}`).toBe(expectedReasons.has(reason));
      }
    }
  });

  it('renders every distinct project-ignore reason once in deterministic order', () => {
    const result = {
      artifacts: {
        first: {
          state: 'refused',
          reasons: ['durability-sync-failed', 'artifact-too-large', 'durability-sync-failed'],
        },
        second: { state: 'refused', reason: 'durability-evidence-cleanup-failed' },
        third: {
          state: 'published',
          durability: { reasons: ['durability-sync-failed'] },
        },
      },
    };

    expect(renderProjectIgnoreResultNotices(result)).toEqual([
      "An affected ignore file exceeds Coral's 1 MiB safety limit. Remedy: reduce that file below 1 MiB before maintenance runs again.",
      'Coral could not dispose of a pending durability record. Remedy: make the authorized project-ignore staging arena writable and repair any filesystem error blocking its removal or quarantine, then retry the maintenance. It is attempted again at the next session start.',
      'Coral could not sync the parent named by a retained durability record. Remedy: check the filesystem and storage device; the next run will reconcile that record before planning project artifacts. It is attempted again at the next session start.',
    ]);
  });

  it('leaves the working link in place when writing its replacement fails', async () => {
    await maintain('prod');
    const original = readlinkSync(link());
    fixture.failSymlinkTarget = join(fixture.home, '.coral', 'projects-dev', 'owner-repo');
    const marker = durabilityMarker(link());

    const result = await maintain('dev');

    expect(result.status, 'a failed write is reported as a failure, not swallowed').toBe('refused');
    expect(result.artifacts.symlink).toEqual({ state: 'refused', reason: 'publish-failed', residue: 'none' });
    expect(
      readlinkSync(link()),
      'unlink-then-symlink would have deleted the working link before the write failed; the fix must not',
    ).toBe(original);
    expect(existsSync(marker)).toBe(false);
  });

  // Complements the test above: that one fails `symlinkSync` (the write of the temp file) and shows the
  // working link survives. This fails `renameSync` (the swap of the temp file onto the real link) instead —
  // pinning `renameSync` as the actual swap mechanism, not just ruling out unlink-then-symlink.
  it('leaves the working link in place when the rename that swaps it in fails', async () => {
    await maintain('prod');
    const original = readlinkSync(link());
    const marker = durabilityMarker(link());
    fixture.failRenameTo = link();

    const result = await maintain('dev');

    expect(result.status, 'a failed rename is reported as a failure, not swallowed').toBe('refused');
    expect(result.artifacts.symlink).toEqual({ state: 'refused', reason: 'publish-failed', residue: 'none' });
    expect(
      readlinkSync(link()),
      'the swap is renameSync onto the real link path; failing exactly that call must leave the working link untouched',
    ).toBe(original);
    expect(
      readdirSync(repositoryArena()),
      'a failed repoint must not retain its run directory or staging symlink in the repository-owned arena',
    ).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it('leaves no repository-arena residue after a successful repoint', async () => {
    await maintain('prod');

    await maintain('dev');

    expect(
      readdirSync(repositoryArena()),
      'a successful repoint must not retain its run directory or staging symlink in the repository-owned arena',
    ).toEqual([]);
  });

  it('continues and completes when run-directory cleanup removes a staging file left by inline cleanup', async () => {
    fixture.failReplacementUnlink = true;

    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(result.artifacts.exclude).toEqual({
      state: 'published',
      residue: 'none',
      durability: { state: 'synced', reasons: [] },
    });
    expect(result.artifacts.symlink.state).toBe('created');
    expect(readdirSync(repositoryArena())).toEqual([]);
  });

  it('classifies a transient initial snapshot read failure as retryable', async () => {
    const rootIgnore = join(projectDir, '.gitignore');
    writeFileSync(rootIgnore, '.claude/coral\n');
    fixture.failMarkerObservation = { phase: 'open', path: rootIgnore, code: 'EIO' };

    const result = await maintain('prod', false);

    expect(result.status).toBe('refused');
    expect(result.artifacts.rootIgnoreRetraction).toEqual({
      state: 'refused',
      reason: 'artifact-observation-failed',
      residue: 'none',
    });
    expect(renderProjectIgnoreResultNotices(result)[0]).toContain('It is attempted again at the next session start.');
    expect(readFileSync(rootIgnore, 'utf-8')).toBe('.claude/coral\n');
  });

  it('classifies an observed non-regular initial snapshot as non-retryable', async () => {
    const rootIgnore = join(projectDir, '.gitignore');
    rmSync(rootIgnore);
    mkdirSync(rootIgnore);

    const result = await maintain('prod', false);

    expect(result.status).toBe('refused');
    expect(result.artifacts.rootIgnoreRetraction).toEqual({
      state: 'refused',
      reason: 'artifact-unreadable',
      residue: 'none',
    });
    expect(renderProjectIgnoreResultNotices(result)).toContain(ARTIFACT_UNREADABLE_NOTICE);
    expect(renderProjectIgnoreResultNotices(result)[0]).not.toContain(
      'It is attempted again at the next session start.',
    );
    expect(lstatSync(rootIgnore).isDirectory()).toBe(true);
  });

  it('reports a failed snapshot re-read without blaming a concurrent writer', async () => {
    const rootIgnore = join(projectDir, '.gitignore');
    writeFileSync(rootIgnore, '.claude/coral\n');
    fixture.failLstatAfter = { path: rootIgnore, successesRemaining: 1 };

    const result = await maintain('prod', false);

    expect(result.status).toBe('refused');
    expect(result.artifacts.rootIgnoreRetraction).toEqual({
      state: 'refused',
      reason: 'artifact-observation-failed',
      residue: 'none',
    });
    expect(JSON.stringify(result)).not.toContain('artifact-changed');
    expect(renderProjectIgnoreResultNotices(result)).toEqual([
      'Coral could not inspect or re-read an affected ignore file. Remedy: make the file and its parent directories observable by the current user, or repair the filesystem error blocking inspection. It is attempted again at the next session start.',
    ]);
  });

  it('reports a target that disappears between comparison lstat and open as changed', async () => {
    const rootIgnore = join(projectDir, '.gitignore');
    writeFileSync(rootIgnore, '.claude/coral\n');
    fixture.failMarkerObservation = {
      phase: 'open',
      path: rootIgnore,
      code: 'ENOENT',
      successesRemaining: 1,
    };

    const result = await maintain('prod', false);

    expect(result.status).toBe('refused');
    expect(result.artifacts.rootIgnoreRetraction).toEqual({
      state: 'refused',
      reason: 'artifact-changed',
      residue: 'none',
    });
    expect(JSON.stringify(result)).not.toContain('artifact-observation-failed');
  });

  it('reports a marker staging file when both of its cleanup attempts fail', async () => {
    rmSync(join(fixture.gitDir, 'info'), { recursive: true });
    fixture.failDurabilityMarkerFsync = true;
    fixture.failDurabilityStagingUnlink = true;
    fixture.failRmUnder = durabilityArena();

    const result = await maintain('prod');

    expect(result.status).toBe('partial');
    expect(result.artifacts.arenaSweep).toEqual({
      state: 'refused',
      reason: 'arena-sweep-failed',
    });
    expect(result.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'durability-evidence-unavailable',
      residue: 'owned-staging',
    });
    const retainedRuns = readdirSync(durabilityArena()).filter((name) => /^\d+-\d+$/u.test(name));
    expect(retainedRuns).toHaveLength(1);
    expect(readdirSync(join(durabilityArena(), retainedRuns[0]))).toHaveLength(1);
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
    expect(isProjectIgnoreResult(result)).toBe(true);
  });

  it.each([
    ['create', 'prod'],
    ['repoint', 'dev'],
  ] as const)('retains symlink marker staging from the %s path on its symlink artifact', async (action, flavor) => {
    if (action === 'repoint') await maintain('prod');
    fixture.failDurabilityMarkerFsyncFor = durabilityMarker(link());
    fixture.failDurabilityStagingUnlink = true;
    fixture.failRmUnder = durabilityArena();

    const result = await maintain(flavor);

    expect(result.status).toBe('partial');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'durability-evidence-unavailable',
      residue: 'owned-staging',
    });
    expect(result.artifacts.arenaSweep).toEqual({
      state: 'refused',
      reason: 'arena-sweep-failed',
    });
  });

  it('keeps an empty current run-directory removal failure out of aggregate status', async () => {
    fixture.failRmUnder = repositoryArena();

    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(result.artifacts.arenaSweep).toEqual({
      state: 'refused',
      reason: 'arena-sweep-failed',
    });
    expect(renderProjectIgnoreResultNotices(result)).toContain(
      "Coral could not inspect or clean one of its staging arenas. Remedy: ensure ~/.coral/staging/project-ignore and the common Git directory's coral/staging/project-ignore path are writable real directories. It is attempted again at the next session start.",
    );
    expect(readdirSync(repositoryArena())).toHaveLength(1);
    expect(fixture.rmPaths.some((path) => dirname(path) === durabilityArena())).toBe(true);
    expect(readdirSync(durabilityArena()).filter((name) => /^\d+-\d+$/u.test(name))).toEqual([]);
  });

  it('keeps a foreign arena cleanup failure out of an otherwise clean result', async () => {
    await maintain('prod');
    const foreignRun = join(repositoryArena(), '1-999999');
    mkdirSync(foreignRun);
    writeFileSync(join(foreignRun, 'retained'), 'foreign staging');
    fixture.failRmPath = foreignRun;

    const result = await maintain('prod');

    expect(result.status).toBe('complete');
    expect(result.artifacts.arenaSweep).toEqual({
      state: 'refused',
      reason: 'arena-sweep-failed',
    });
    expect(existsSync(foreignRun)).toBe(true);
  });

  it('reports symlink staging residue when repoint publication and both cleanup attempts fail', async () => {
    await maintain('prod');
    fixture.failRenameTo = link();
    fixture.failSymlinkTempUnlink = true;
    fixture.failRmUnder = repositoryArena();

    const result = await maintain('dev');

    expect(result.status).toBe('partial');
    expect(result.artifacts.symlink).toEqual({
      state: 'refused',
      reason: 'publish-failed',
      residue: 'owned-staging',
    });
    expect(readdirSync(repositoryArena())).toHaveLength(1);
  });

  it('retains the publication refusal and reports residue when every staging cleanup fails', async () => {
    fixture.failLinkTo = join(fixture.gitDir, 'info', 'exclude');
    fixture.failReplacementUnlink = true;
    fixture.failRmUnder = repositoryArena();

    const result = await maintain('prod');

    expect(result.status).toBe('partial');
    expect(result.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'publish-failed',
      residue: 'owned-staging',
    });
    expect(readdirSync(repositoryArena())).toHaveLength(1);
  });

  it('keeps the completed deletion count when a later legacy staging deletion refuses', async () => {
    const removed = join(projectDir, '.gitignore.coral-1-1.tmp');
    const refused = join(projectDir, '.claude', '.gitignore.coral-1-2.tmp');
    writeFileSync(removed, 'staging');
    writeFileSync(refused, 'staging');
    utimesSync(removed, 0, 0);
    utimesSync(refused, 0, 0);
    fixture.failUnlinkPath = refused;

    const result = await maintain('prod');

    expect(result.status).toBe('partial');
    expect(result.artifacts.legacySweep).toEqual({
      state: 'refused',
      reason: 'legacy-sweep-failed',
      path: join('.claude', '.gitignore.coral-1-2.tmp'),
      count: 1,
    });
    const notices = renderProjectIgnoreResultNotices(result);
    expect(notices).toHaveLength(1);
    expect(notices.find((notice: string) => notice.includes('authorized legacy staging path'))).toContain(
      JSON.stringify(join('.claude', '.gitignore.coral-1-2.tmp')),
    );
    expect(existsSync(removed)).toBe(false);
    expect(existsSync(refused)).toBe(true);
  });

  it.each(['readdir', 'lstat', 'readlink'] as const)(
    'refuses a legacy %s observation failure after preserving completed deletions',
    async (phase) => {
      const removed = join(projectDir, '.gitignore.coral-1-1.tmp');
      const observed =
        phase === 'readlink'
          ? join(projectDir, '.claude', 'coral.coral-1-2.tmp')
          : join(projectDir, '.claude', '.gitignore.coral-1-2.tmp');
      writeFileSync(removed, 'staging');
      if (phase === 'readlink') {
        symlinkSync(join(fixture.home, '.coral', 'projects', 'owner-repo'), observed);
      } else {
        writeFileSync(observed, 'staging');
      }
      utimesSync(removed, 0, 0);
      if (phase === 'readlink') lutimesSync(observed, 0, 0);
      else utimesSync(observed, 0, 0);

      if (phase === 'readdir') fixture.failReaddirPath = join(projectDir, '.claude');
      if (phase === 'lstat') fixture.failLstatPath = observed;
      if (phase === 'readlink') fixture.failReadlinkPath = observed;

      const result = await maintain('prod');

      expect(result.status).toBe('partial');
      expect(result.artifacts.legacySweep).toEqual({
        state: 'refused',
        reason: 'legacy-sweep-observation-failed',
        path: phase === 'readdir' ? '.claude' : relative(projectDir, observed),
        count: 1,
      });
      expect(existsSync(removed)).toBe(false);
      expect(lstatSync(observed)).toBeDefined();
      expect(existsSync(link())).toBe(false);
      expect(existsSync(join(fixture.gitDir, 'info', 'exclude'))).toBe(false);
      // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
      const { isProjectIgnoreResult } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');
      expect(isProjectIgnoreResult(result)).toBe(true);
    },
  );
});
