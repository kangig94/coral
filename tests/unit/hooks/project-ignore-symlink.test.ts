// The correction is scoped to links Coral itself placed. A link an operator pointed somewhere of their own is
// left alone: recognising our own artifact is not licence to overwrite someone else's.

import { createHash } from 'node:crypto';
import type * as NodeFs from 'node:fs';
import {
  chmodSync,
  existsSync,
  lstatSync,
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
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `coralStateRoot` has no cached module-level state (it reads `homedir()` fresh on every call), so a static
// import is safe to use across the module reloads `maintain()` triggers below via `vi.resetModules()`.
// @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
import { coralStateRoot, PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS } from '../../../clients/hooks/lib/hook-utils.mjs';
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
  failLinkTo: null as string | null,
  failUnlinkPath: null as string | null,
  failReplacementUnlink: false,
  failSymlinkTempUnlink: false,
  failRmUnder: null as string | null,
  failReaddirPath: null as string | null,
  failMarkerObservation: null as null | {
    phase: 'lstat' | 'open' | 'fstat' | 'read';
    path: string;
    code: string;
  },
  failDirectoryFsyncPath: null as string | null,
  failDirectoryFsyncCode: null as string | null,
  directoryFsyncFailures: new Map<string, string>(),
  failDurabilityMarkerFsync: false,
  directoryFds: new Map<number, string>(),
  openPaths: new Map<number, string>(),
  fsyncedDirectoryPaths: [] as string[],
  observeSymlinkPublicationPath: null as string | null,
  durabilityEvents: [] as string[],
  gitReadDurationsMs: [] as number[],
  monotonicNs: 0n,
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
    lstatSync: (path: unknown) => {
      const failure = fixture.failMarkerObservation;
      if (failure?.phase === 'lstat' && String(path) === failure.path) {
        fixture.failMarkerObservation = null;
        throw Object.assign(new Error('simulated marker lstat failure'), { code: failure.code });
      }
      return actual.lstatSync(path as NodeFs.PathLike);
    },
    readFileSync: (path: unknown, encoding?: unknown) => {
      if (String(path).endsWith('manifest.json')) return JSON.stringify({ flavor: manifest.flavor });
      const failure = fixture.failMarkerObservation;
      if (failure?.phase === 'read' && typeof path === 'number' && fixture.openPaths.get(path) === failure.path) {
        fixture.failMarkerObservation = null;
        throw Object.assign(new Error('simulated marker read failure'), { code: failure.code });
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
        (fixture.failSymlinkTempUnlink && String(path).endsWith('/coral-test-token.tmp'))
      ) {
        throw Object.assign(new Error('simulated unlink failure'), { code: 'EACCES' });
      }
      return (actual.unlinkSync as (p: unknown) => void)(path);
    },
    rmSync: (path: unknown, options: unknown) => {
      if (fixture.failRmUnder !== null && String(path).startsWith(fixture.failRmUnder)) {
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
      const failure = fixture.failMarkerObservation;
      if (failure?.phase === 'open' && String(path) === failure.path) {
        fixture.failMarkerObservation = null;
        throw Object.assign(new Error('simulated marker open failure'), { code: failure.code });
      }
      const fd = (actual.openSync as (p: unknown, f: unknown, m: unknown) => number)(path, flags, mode);
      fixture.openPaths.set(fd, String(path));
      if ((Number(flags) & actual.constants.O_DIRECTORY) !== 0) {
        fixture.directoryFds.set(fd, String(path));
      }
      return fd;
    },
    fstatSync: (fd: number) => {
      const failure = fixture.failMarkerObservation;
      if (failure?.phase === 'fstat' && fixture.openPaths.get(fd) === failure.path) {
        fixture.failMarkerObservation = null;
        throw Object.assign(new Error('simulated marker fstat failure'), { code: failure.code });
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
        fixture.failDurabilityMarkerFsync &&
        openPath?.includes('/.coral/staging/project-ignore/') &&
        openPath.split('/').at(-1)?.startsWith('.durability-')
      ) {
        fixture.failDurabilityMarkerFsync = false;
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
vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
  execFileSync: execFileSyncMock,
}));

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
  fixture.failLinkTo = null;
  fixture.failUnlinkPath = null;
  fixture.failReplacementUnlink = false;
  fixture.failSymlinkTempUnlink = false;
  fixture.failRmUnder = null;
  fixture.failReaddirPath = null;
  fixture.failMarkerObservation = null;
  fixture.failDirectoryFsyncPath = null;
  fixture.failDirectoryFsyncCode = null;
  fixture.directoryFsyncFailures.clear();
  fixture.failDurabilityMarkerFsync = false;
  fixture.directoryFds.clear();
  fixture.openPaths.clear();
  fixture.fsyncedDirectoryPaths.length = 0;
  fixture.observeSymlinkPublicationPath = null;
  fixture.durabilityEvents.length = 0;
  fixture.gitReadDurationsMs.length = 0;
  fixture.monotonicNs = 0n;
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
        reason?: string;
      };
    };
    exclude: {
      state: 'not-needed' | 'unchanged' | 'published' | 'refused' | 'skipped';
      reason?: string;
      residue: 'none' | 'owned-staging';
      durability?: {
        state: 'synced' | 'unsupported' | 'failed';
        reason?: string;
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
        reason?: string;
      };
    };
    rootIgnoreRetraction: {
      state: 'not-needed' | 'unchanged' | 'published' | 'refused' | 'skipped';
      reason?: string;
      residue: 'none' | 'owned-staging';
      durability?: {
        state: 'synced' | 'unsupported' | 'failed';
        reason?: string;
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
  return projectIgnore.maintainProjectIgnore({
    projectDir,
    createSymlink,
    token: 'test-token',
    context,
    contextProbeDeadlineNs,
  });
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

describe('project-ignore symlink maintenance', () => {
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

  it('reports residue-free retractions as not needed on repeated fsync-less sessions', async () => {
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

    expect(result.status).toBe('partial');
    expect(result.artifacts.symlink).toEqual({ state: 'refused', reason: 'publish-failed' });
    expect(existsSync(join(outside, 'owner-repo'))).toBe(false);
    expect(existsSync(link())).toBe(false);
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

  it('reconciles an interrupted symlink creation when a later run does not request the link', async () => {
    fixture.failDirectoryFsyncPath = join(projectDir, '.claude');
    fixture.failDirectoryFsyncCode = 'EIO';

    const published = await maintain('prod');
    const marker = durabilityMarker(link());

    expect(published.status).toBe('partial');
    expect(published.artifacts.symlink).toEqual({
      state: 'created',
      durability: { state: 'failed', reason: 'durability-sync-failed' },
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

  it('refuses when the authorized repository arena cannot be prepared', async () => {
    writeFileSync(join(fixture.gitDir, 'coral'), 'not a directory');

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'repository-arena-unavailable',
      residue: 'none',
    });
    expect(existsSync(link())).toBe(false);
    expect(existsSync(join(fixture.gitDir, 'info', 'exclude'))).toBe(false);
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
      durability: { state: 'failed', reason: 'durability-sync-failed' },
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
      durability: { state: 'failed', reason: 'durability-sync-failed' },
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
      reasons: ['durability-evidence-quarantined', 'durability-sync-failed', 'durability-sync-unsupported'],
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
        reasons: ['durability-sync-unsupported'],
      });
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
      reason: 'durability-sync-failed',
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

  it('does not begin publication when syncing the installed marker rename fails', async () => {
    fixture.failDirectoryFsyncPath = durabilityArena();
    fixture.failDirectoryFsyncCode = 'EIO';

    const result = await maintain('prod');

    expect(result.status).toBe('refused');
    expect(result.artifacts.exclude).toEqual({
      state: 'refused',
      reason: 'durability-evidence-unavailable',
      residue: 'none',
    });
    expect(existsSync(join(fixture.gitDir, 'info', 'exclude'))).toBe(false);
    expect(existsSync(link())).toBe(false);
    expect(durabilityMarkers()).toEqual([]);
  });

  it('reports a narrowly unsupported directory sync separately from an I/O failure', async () => {
    fixture.failDirectoryFsyncPath = join(fixture.gitDir, 'info');
    fixture.failDirectoryFsyncCode = 'EINVAL';

    const result = await maintain('prod');

    expect(result.status).toBe('partial');
    expect(result.artifacts.exclude).toEqual({
      state: 'published',
      residue: 'none',
      durability: { state: 'unsupported', reason: 'durability-sync-unsupported' },
    });
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

  // The caller's budget must exceed the aggregate context allowance plus the remote probe's bound. Reverting
  // `session-start.mjs`'s spawnSync timeout to exactly that bound reproduces the SIGTERM-before-its-own-bound
  // defect, so the margin has to be checked directly rather than left to a slow mount in production.
  it('gives the owner chain more time than its aggregate bounded-subprocess allowance', async () => {
    await maintain('prod');
    execFileSyncMock.mockClear();
    execSyncMock.mockClear();

    await maintain('prod');

    const remoteProbeTimeout =
      ((execSyncMock.mock.calls as unknown[][])[0]?.[1] as { timeout?: number } | undefined)?.timeout ?? 0;
    const childBound = PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS + remoteProbeTimeout;

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

  it('renders every maintenance outcome it distinguishes, so none is split apart and then dropped', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'clients', 'hooks', 'session-start.mjs'),
      'utf-8',
    );

    const produced = new Set([...source.matchAll(/outcome:\s*'([^']+)'/gu)].map((match) => match[1]));

    expect(produced.size, 'the outcome literals must be readable from source').toBeGreaterThan(3);
    for (const outcome of produced) {
      if (outcome === 'ok' || outcome === 'no-project-dir') continue;
      expect(projectIgnoreOutcomeNotice(outcome)).not.toBeNull();
    }
    const migrationDerivation = source.match(
      /const\s+(\w+)\s*=\s*\[([^\]]+)\]\.some\(\(artifact\)\s*=>\s*artifact\?\.state\s*===\s*'published'\)/su,
    );
    const migrationNotice = source.match(/const\s+(\w+)\s*=\s*\w+\s*\?\s*'Coral migration:/su)?.[1] ?? '';
    const ignoreNotice =
      source.match(/const\s+(\w+)\s*=\s*[^\n]+\n\s+\? `Coral project-ignore maintenance/u)?.[1] ?? '';
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

  it('covers exactly every reason admitted by the result validator', async () => {
    // @ts-expect-error — hook libs are plain Node ESM (.mjs) with no type surface.
    const { PROJECT_IGNORE_REASONS } = await import('../../../clients/hooks/lib/project-ignore-result.mjs');

    expect(new Set(Object.keys(PROJECT_IGNORE_REASON_NOTICES))).toEqual(new Set(PROJECT_IGNORE_REASONS));
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
          durability: { reason: 'durability-sync-failed' },
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
      durability: { state: 'synced' },
    });
    expect(result.artifacts.symlink.state).toBe('created');
    expect(readdirSync(repositoryArena())).toEqual([]);
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
    const removed = join(projectDir, '.claude', '.gitignore.coral-1-1.tmp');
    const refused = join(projectDir, '.gitignore.coral-1-2.tmp');
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
      path: '.gitignore.coral-1-2.tmp',
      count: 1,
    });
    expect(existsSync(removed)).toBe(false);
    expect(existsSync(refused)).toBe(true);
  });
});
