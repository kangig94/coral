import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import {
  coralProjectDir,
  coralStateRoot,
  prepareProjectIgnoreStagingDir,
  PROJECT_IGNORE_ARENA_SWEEP_BUDGET_MS,
  PROJECT_IGNORE_ARENA_SWEEP_MAX_RUNS,
  PROJECT_IGNORE_STAGING_ARENA_MAX_AGE_MS,
} from './hook-utils.mjs';

const MAX_GITIGNORE_BYTES = 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW;
const TEMP_WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const CORAL_IGNORE_ENTRY = 'coral';
const LEGACY_CORAL_IGNORE_ENTRY = '.claude/coral';

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function safeUnlink(path) {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

function readRegularSnapshot(path, { allowMissing = false } = {}) {
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > MAX_GITIGNORE_BYTES) {
      return { ok: false };
    }
  } catch (error) {
    if (allowMissing && isMissing(error)) {
      return { ok: true, exists: false, content: Buffer.alloc(0), mode: 0o666 };
    }
    return { ok: false };
  }

  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch {
    return { ok: false };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_GITIGNORE_BYTES) return { ok: false };
    const content = readFileSync(fd);
    if (content.length > MAX_GITIGNORE_BYTES) return { ok: false };
    return {
      ok: true,
      exists: true,
      content,
      mode: stat.mode & 0o777,
    };
  } catch {
    return { ok: false };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // best-effort descriptor cleanup
    }
  }
}

function lineSegments(content) {
  const segments = [];
  let cursor = 0;
  while (cursor < content.length) {
    let lineEnd = cursor;
    while (lineEnd < content.length && content[lineEnd] !== 0x0a && content[lineEnd] !== 0x0d) {
      lineEnd += 1;
    }
    let segmentEnd = lineEnd;
    if (segmentEnd < content.length) {
      segmentEnd += content[segmentEnd] === 0x0d && content[segmentEnd + 1] === 0x0a ? 2 : 1;
    }
    segments.push({
      line: content.subarray(cursor, lineEnd),
      segment: content.subarray(cursor, segmentEnd),
    });
    cursor = segmentEnd;
  }
  return segments;
}

function hasExactLine(content, entry) {
  const expected = Buffer.from(entry);
  return lineSegments(content).some(({ line }) => line.equals(expected));
}

function removeExactLines(content, entry) {
  const expected = Buffer.from(entry);
  const retained = [];
  let changed = false;
  for (const { line, segment } of lineSegments(content)) {
    if (line.equals(expected)) {
      changed = true;
    } else {
      retained.push(segment);
    }
  }
  return changed ? Buffer.concat(retained) : content;
}

function preferredNewline(content) {
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0d) {
      return content[index + 1] === 0x0a ? Buffer.from('\r\n') : Buffer.from('\r');
    }
    if (content[index] === 0x0a) return Buffer.from('\n');
  }
  return Buffer.from('\n');
}

function appendExactLine(content, entry) {
  if (hasExactLine(content, entry)) return content;
  const newline = preferredNewline(content);
  const needsBoundary =
    content.length > 0 && content[content.length - 1] !== 0x0a && content[content.length - 1] !== 0x0d;
  return Buffer.concat([content, ...(needsBoundary ? [newline] : []), Buffer.from(entry), newline]);
}

function snapshotUnchanged(path, snapshot) {
  const current = readRegularSnapshot(path, { allowMissing: true });
  return current.ok && current.exists === snapshot.exists && current.content.equals(snapshot.content);
}

function fsyncParent(path) {
  let fd;
  try {
    fd = openSync(dirname(path), constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Some platforms do not support fsync on directories.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

export function atomicReplace({ target, snapshot, next, stagingDir }) {
  if (next.equals(snapshot.content)) return { state: 'unchanged', residue: 'none' };
  if (next.length > MAX_GITIGNORE_BYTES) {
    return { state: 'refused', reason: 'artifact-too-large', residue: 'none' };
  }

  try {
    if (lstatSync(dirname(target)).dev !== lstatSync(stagingDir).dev) {
      return { state: 'refused', reason: 'staging-device-mismatch', residue: 'none' };
    }
  } catch {
    return { state: 'refused', reason: 'publish-failed', residue: 'none' };
  }

  const tempPath = join(stagingDir, 'replacement.tmp');
  let fd;
  let published = false;
  try {
    fd = openSync(tempPath, TEMP_WRITE_FLAGS, snapshot.mode);
    writeFileSync(fd, next);
    if (snapshot.exists) fchmodSync(fd, snapshot.mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    if (!snapshotUnchanged(target, snapshot)) {
      return { state: 'refused', reason: 'artifact-changed', residue: 'none' };
    }

    try {
      if (snapshot.exists) {
        renameSync(tempPath, target);
      } else {
        linkSync(tempPath, target);
      }
      published = true;
    } catch (error) {
      return {
        state: 'refused',
        reason: error?.code === 'EXDEV' ? 'publish-cross-device' : 'publish-failed',
        residue: 'none',
      };
    }

    if (!snapshot.exists) {
      try {
        unlinkSync(tempPath);
      } catch {
        return {
          state: 'published',
          reason: 'staging-cleanup-failed',
          residue: 'owned-staging',
        };
      }
    }
    fsyncParent(target);
    return { state: 'published', residue: 'none' };
  } catch {
    return { state: 'refused', reason: 'publish-failed', residue: 'none' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
    if (!published) safeUnlink(tempPath);
  }
}

function isRealDirectory(path) {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

function hasGitMarker(projectDir) {
  let current = projectDir;
  while (true) {
    try {
      lstatSync(join(current, '.git'));
      return true;
    } catch (error) {
      if (!isMissing(error)) return true;
    }

    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function isNotGitRepository(error, projectDir) {
  return (
    error?.status === 128 &&
    String(error?.stderr ?? '').startsWith('fatal: not a git repository') &&
    !hasGitMarker(projectDir)
  );
}

function findGitContext(projectDir) {
  try {
    const output = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-path', 'info/exclude'],
      {
        cwd: projectDir,
        encoding: 'utf-8',
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 1500,
      },
    );
    const lines = output.replace(/\r?\n$/u, '').split(/\r?\n/u);
    if (lines.length !== 3 || lines.some((line) => line.length === 0)) return { state: 'unresolvable' };
    return {
      state: 'resolved',
      gitRoot: realpathSync(lines[0]),
      commonGitDir: realpathSync(resolve(projectDir, lines[1])),
      excludePath: resolve(projectDir, lines[2]),
    };
  } catch (error) {
    return { state: isNotGitRepository(error, projectDir) ? 'absent' : 'unresolvable' };
  }
}

export function repositoryProjectIgnoreStagingDir(commonGitDir) {
  return join(commonGitDir, 'coral', 'staging', 'project-ignore');
}

function ensureArenaComponent(path) {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch (error) {
    if (!isMissing(error)) return false;
  }

  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
  }

  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

export function prepareRepositoryProjectIgnoreStagingDir(commonGitDir) {
  try {
    const canonicalCommonGitDir = realpathSync(commonGitDir);
    const expectedArena = repositoryProjectIgnoreStagingDir(canonicalCommonGitDir);
    let current = canonicalCommonGitDir;
    for (const component of ['coral', 'staging', 'project-ignore']) {
      current = join(current, component);
      if (!ensureArenaComponent(current)) return null;
    }

    const canonicalArena = realpathSync(current);
    if (current !== expectedArena) return null;
    const containment = relative(canonicalCommonGitDir, canonicalArena);
    if (
      containment.length === 0 ||
      isAbsolute(containment) ||
      containment === '..' ||
      containment.startsWith(`..${sep}`)
    ) {
      return null;
    }
    return canonicalArena;
  } catch {
    return null;
  }
}

function parseArenaRun(name) {
  const match = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/u.exec(name);
  if (!match) return null;
  const startedAt = Number(match[1]);
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(pid) || startedAt < 1 || pid < 1) return null;
  return { startedAt, pid };
}

export function sweepProjectIgnoreArenas(
  arenaDirs,
  { now = Date.now(), monotonicNow = () => performance.now() } = {},
) {
  const sweepStartedAt = monotonicNow();
  const candidates = [];
  let failures = 0;

  for (const arenaDir of new Set(arenaDirs)) {
    try {
      for (const entry of readdirSync(arenaDir, { withFileTypes: true })) {
        const run = parseArenaRun(entry.name);
        if (!run || !entry.isDirectory() || entry.isSymbolicLink()) continue;
        candidates.push({ arenaDir, name: entry.name, ...run });
      }
    } catch {
      failures += 1;
    }
  }

  candidates.sort(
    (left, right) =>
      left.startedAt - right.startedAt || left.pid - right.pid || left.arenaDir.localeCompare(right.arenaDir),
  );

  let inspected = 0;
  let removed = 0;
  for (const candidate of candidates) {
    if (
      inspected >= PROJECT_IGNORE_ARENA_SWEEP_MAX_RUNS ||
      monotonicNow() - sweepStartedAt >= PROJECT_IGNORE_ARENA_SWEEP_BUDGET_MS
    ) {
      break;
    }
    inspected += 1;
    if (now - candidate.startedAt < PROJECT_IGNORE_STAGING_ARENA_MAX_AGE_MS) continue;

    const runDir = join(candidate.arenaDir, candidate.name);
    try {
      const stat = lstatSync(runDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      rmSync(runDir, { recursive: true });
      removed += 1;
    } catch {
      failures += 1;
    }
  }

  return { inspected, removed, failures };
}

export function projectIgnoreRunDir(arenaDir, startedAt, pid = process.pid) {
  return join(arenaDir, `${startedAt}-${pid}`);
}

function createProjectIgnoreRunDir(arenaDir, startedAt) {
  const runDir = projectIgnoreRunDir(arenaDir, startedAt);
  try {
    mkdirSync(runDir, { mode: 0o700 });
    const stat = lstatSync(runDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return runDir;
  } catch {
    return null;
  }
}

function removeProjectIgnoreRunDir(runDir) {
  try {
    const stat = lstatSync(runDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return;
    rmSync(runDir, { recursive: true });
  } catch {}
}

export function resolveProjectContext(projectDir) {
  let realProjectDir;
  try {
    realProjectDir = realpathSync(projectDir);
  } catch {
    return null;
  }
  const gitContext = findGitContext(realProjectDir);
  if (gitContext.state === 'unresolvable') return null;
  const repositoryContext = gitContext.state === 'resolved' ? gitContext : null;
  const gitRoot = repositoryContext?.gitRoot ?? realProjectDir;
  const projectRelative = relative(gitRoot, realProjectDir);
  if (isAbsolute(projectRelative) || projectRelative === '..' || projectRelative.startsWith(`..${sep}`)) {
    return null;
  }
  const gitignorePrefix = projectRelative.replaceAll('\\', '/');
  const canonicalPrefix = projectRelative.split(sep).join('/');
  const canonicalEntry = canonicalPrefix
    ? `${canonicalPrefix}/${LEGACY_CORAL_IGNORE_ENTRY}`
    : LEGACY_CORAL_IGNORE_ENTRY;
  return {
    projectDir: realProjectDir,
    gitRoot,
    commonGitDir: repositoryContext?.commonGitDir ?? null,
    excludePath: repositoryContext?.excludePath ?? null,
    rootGitignore: join(gitRoot, '.gitignore'),
    legacyEntry: gitignorePrefix ? `${gitignorePrefix}/${LEGACY_CORAL_IGNORE_ENTRY}` : LEGACY_CORAL_IGNORE_ENTRY,
    excludeEntry: `/${escapeGitignoreLiteralPath(canonicalEntry)}`,
  };
}

export function escapeGitignoreLiteralPath(path) {
  let escaped = '';
  for (const character of path) {
    escaped += ['\\', '*', '?', '[', ']'].includes(character) ? `\\${character}` : character;
  }
  return escaped;
}

/**
 * Whether an existing `.claude/coral` link is one Coral placed and has since outgrown.
 *
 * Only a link pointing into `~/.coral/projects*` qualifies. Anything else — a link an operator made to a
 * directory of their own — is left exactly where it is; correcting our own artifact is not licence to
 * overwrite someone's.
 */
function isOutgrownCoralLink(link, target) {
  let current;
  try {
    // `readlinkSync` returns the target text exactly as stored, with no normalization — `symlinkSync` does not
    // normalize on write either, so a target like `<root>/projects/../projects-mine/<slug>` reads back with the
    // `..` still in it. It textually starts with the `projects` root while semantically escaping it, and
    // `normalize()` is what tells those apart without resolving anything through the filesystem the way
    // `realpathSync` would (the link's target need not exist for this check).
    current = normalize(readlinkSync(link));
  } catch {
    return false;
  }
  if (current === target) return false;
  // Both legitimate roots are checked on purpose — a link left behind by the other flavor is still ours to
  // repoint. Each match needs its own separator boundary: `startsWith('…/projects')` alone also matches
  // `…/projects-mine`, `…/projects-old`, `…/projectsBackup` — an operator's own directory that merely shares
  // the prefix, not a link Coral placed.
  return ['projects', 'projects-dev'].some((name) => {
    const root = join(coralStateRoot(), name);
    return current === root || current.startsWith(root + sep);
  });
}

function claudeDirectoryRefusal(claudeDir) {
  if (isRealDirectory(claudeDir)) return null;
  try {
    lstatSync(claudeDir);
    return 'claude-directory-invalid';
  } catch (error) {
    return isMissing(error) ? 'claude-directory-missing' : 'claude-directory-invalid';
  }
}

function stagingDeviceRefusal(path, stagingDir) {
  try {
    return lstatSync(path).dev === lstatSync(stagingDir).dev ? null : 'staging-device-mismatch';
  } catch {
    return 'publish-failed';
  }
}

function prepareReplacement({ target, snapshot, next, devicePath, stagingDir }) {
  if (next.equals(snapshot.content)) return { ok: true, replacement: { target, snapshot, next } };
  if (next.length > MAX_GITIGNORE_BYTES) return { ok: false, reason: 'artifact-too-large' };
  const deviceRefusal = stagingDeviceRefusal(devicePath, stagingDir);
  if (deviceRefusal) return { ok: false, reason: deviceRefusal };
  return { ok: true, replacement: { target, snapshot, next } };
}

function excludeDevicePath(excludePath) {
  const excludeDir = dirname(excludePath);
  if (isRealDirectory(excludeDir)) return excludeDir;
  try {
    lstatSync(excludeDir);
    return null;
  } catch (error) {
    if (!isMissing(error)) return null;
  }
  const parent = dirname(excludeDir);
  return isRealDirectory(parent) ? parent : null;
}

function ensureExcludeDirectory(excludePath) {
  const excludeDir = dirname(excludePath);
  if (isRealDirectory(excludeDir)) return true;
  try {
    mkdirSync(excludeDir);
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
  }
  return isRealDirectory(excludeDir);
}

function prepareCoralSymlink(projectDir, createSymlink, stagingDir) {
  const claudeDir = join(projectDir, '.claude');
  const claudeRefusal = createSymlink ? claudeDirectoryRefusal(claudeDir) : null;
  if (claudeRefusal) return { ok: false, reason: claudeRefusal };

  const link = join(projectDir, '.claude', 'coral');
  let stat;
  try {
    stat = lstatSync(link);
  } catch (error) {
    if (!isMissing(error)) return { ok: false, reason: 'symlink-conflict' };
    let target = null;
    if (createSymlink) {
      try {
        target = coralProjectDir(projectDir);
      } catch {
        return { ok: false, reason: 'publish-failed' };
      }
    }
    return {
      ok: true,
      symlinkExists: false,
      action: createSymlink ? 'create' : 'not-requested',
      link,
      target,
    };
  }

  if (!stat.isSymbolicLink()) {
    return createSymlink
      ? { ok: false, reason: 'symlink-conflict' }
      : { ok: true, symlinkExists: false, action: 'not-requested', link, target: null };
  }
  if (!createSymlink) {
    return { ok: true, symlinkExists: true, action: 'not-requested', link, target: null };
  }

  let target;
  try {
    target = coralProjectDir(projectDir);
  } catch {
    return { ok: false, reason: 'publish-failed' };
  }
  if (!isOutgrownCoralLink(link, target)) {
    return { ok: true, symlinkExists: true, action: 'unchanged', link, target };
  }
  const deviceRefusal = stagingDeviceRefusal(projectDir, stagingDir);
  if (deviceRefusal) return { ok: false, reason: deviceRefusal };
  return { ok: true, symlinkExists: true, action: 'repoint', link, target };
}

function placeCoralSymlink(symlinkPlan, token, stagingDir) {
  if (symlinkPlan.action === 'not-requested' || symlinkPlan.action === 'unchanged') {
    return { ok: true, created: false, repointed: false };
  }

  const target = symlinkPlan.target;
  try {
    mkdirSync(target, { recursive: true });
    if (symlinkPlan.action === 'create') {
      symlinkSync(target, symlinkPlan.link);
      return { ok: true, created: true, repointed: false };
    }
  } catch (error) {
    return {
      ok: false,
      created: false,
      repointed: false,
      reason: error?.code === 'EEXIST' ? 'symlink-conflict' : 'publish-failed',
    };
  }

  // A repoint must not expose a missing final link if the hook is killed between syscalls.
  const tempLink = join(stagingDir, `coral-${token}.tmp`);
  try {
    symlinkSync(target, tempLink);
    renameSync(tempLink, symlinkPlan.link);
    return { ok: true, created: false, repointed: true };
  } catch (error) {
    return {
      ok: false,
      created: false,
      repointed: false,
      reason: error?.code === 'EXDEV' ? 'publish-cross-device' : 'publish-failed',
    };
  } finally {
    safeUnlink(tempLink);
  }
}

// Every refusal below answers `ok: false`, and a caller that only learns that cannot tell a project it could
// not resolve from a symlink it could not place. `reason` is a fixed token per refusal so a notice repeated
// every session says which one, without carrying a path or an errno to a surface that renders to a user.
const FAILED = {
  ok: false,
  migrated: false,
  excludeUpdated: false,
  scopedIgnoreRetracted: false,
  rootIgnoreRetracted: false,
  symlinkCreated: false,
  symlinkRepointed: false,
};

function preflightProjectIgnoreArtifacts({ context, createSymlink, stagingDir }) {
  const symlink = prepareCoralSymlink(context.projectDir, createSymlink, stagingDir);
  if (!symlink.ok) return symlink;

  const rootSnapshot = readRegularSnapshot(context.rootGitignore, { allowMissing: true });
  if (!rootSnapshot.ok) return { ok: false, reason: 'artifact-unreadable' };

  const claudeDir = join(context.projectDir, '.claude');
  let scopedSnapshot = null;
  if (isRealDirectory(claudeDir)) {
    scopedSnapshot = readRegularSnapshot(join(claudeDir, '.gitignore'), { allowMissing: true });
    if (!scopedSnapshot.ok) return { ok: false, reason: 'artifact-unreadable' };
  }

  const wantsExclude = symlink.symlinkExists || createSymlink;
  if (wantsExclude && context.commonGitDir && !context.excludePath) {
    return { ok: false, reason: 'exclude-path-unresolvable' };
  }
  const publishExclude = wantsExclude && context.excludePath !== null;
  let excludeSnapshot = null;
  let excludePathDevice = null;
  if (publishExclude) {
    excludeSnapshot = readRegularSnapshot(context.excludePath, { allowMissing: true });
    if (!excludeSnapshot.ok) return { ok: false, reason: 'artifact-unreadable' };
    excludePathDevice = excludeDevicePath(context.excludePath);
    if (!excludePathDevice) return { ok: false, reason: 'publish-failed' };
  }

  let exclude = null;
  if (publishExclude) {
    exclude = prepareReplacement({
      target: context.excludePath,
      snapshot: excludeSnapshot,
      next: appendExactLine(excludeSnapshot.content, context.excludeEntry),
      devicePath: excludePathDevice,
      stagingDir,
    });
  }
  let scopedIgnoreRetraction = null;
  if (scopedSnapshot) {
    scopedIgnoreRetraction = prepareReplacement({
      target: join(claudeDir, '.gitignore'),
      snapshot: scopedSnapshot,
      next: removeExactLines(scopedSnapshot.content, CORAL_IGNORE_ENTRY),
      devicePath: claudeDir,
      stagingDir,
    });
  }
  const rootIgnoreRetraction = prepareReplacement({
    target: context.rootGitignore,
    snapshot: rootSnapshot,
    next: removeExactLines(rootSnapshot.content, context.legacyEntry),
    devicePath: context.gitRoot,
    stagingDir,
  });

  const refused = [exclude, scopedIgnoreRetraction, rootIgnoreRetraction].find(
    (replacement) => replacement && !replacement.ok,
  );
  if (refused) return { ok: false, reason: refused.reason };

  return {
    ok: true,
    symlink,
    publishExclude,
    replacements: {
      exclude: exclude?.replacement ?? null,
      scopedIgnoreRetraction: scopedIgnoreRetraction?.replacement ?? null,
      rootIgnoreRetraction: rootIgnoreRetraction.replacement,
    },
  };
}

function maintainProjectIgnoreArtifacts({ context, createSymlink, token, stagingDir }) {
  const preflight = preflightProjectIgnoreArtifacts({ context, createSymlink, stagingDir });
  if (!preflight.ok) return { ...FAILED, reason: preflight.reason };

  const progress = { ...FAILED };
  if (preflight.publishExclude) {
    if (!ensureExcludeDirectory(context.excludePath)) return { ...progress, reason: 'publish-failed' };
    const exclude = atomicReplace({ ...preflight.replacements.exclude, stagingDir });
    progress.excludeUpdated = exclude.state === 'published';
    if (exclude.state === 'refused' || exclude.residue === 'owned-staging') {
      return { ...progress, reason: exclude.reason };
    }
  }

  const symlink = placeCoralSymlink(preflight.symlink, token, stagingDir);
  progress.symlinkCreated = symlink.created;
  progress.symlinkRepointed = symlink.repointed;
  if (!symlink.ok) return { ...progress, reason: symlink.reason };

  if (preflight.replacements.scopedIgnoreRetraction) {
    const scoped = atomicReplace({ ...preflight.replacements.scopedIgnoreRetraction, stagingDir });
    progress.scopedIgnoreRetracted = scoped.state === 'published';
    progress.migrated ||= progress.scopedIgnoreRetracted;
    if (scoped.state === 'refused' || scoped.residue === 'owned-staging') {
      return { ...progress, reason: scoped.reason };
    }
  }

  const root = atomicReplace({ ...preflight.replacements.rootIgnoreRetraction, stagingDir });
  progress.rootIgnoreRetracted = root.state === 'published';
  progress.migrated ||= progress.rootIgnoreRetracted;
  if (root.state === 'refused' || root.residue === 'owned-staging') {
    return { ...progress, reason: root.reason };
  }

  return { ...progress, ok: true };
}

export function maintainProjectIgnore({ projectDir, createSymlink = false, token = `${process.pid}-${Date.now()}` }) {
  const startedAt = Date.now();
  const context = resolveProjectContext(projectDir);
  if (!context) return { ...FAILED, reason: 'project-context-unresolvable' };

  const arena = context.commonGitDir
    ? prepareRepositoryProjectIgnoreStagingDir(context.commonGitDir)
    : prepareProjectIgnoreStagingDir();
  if (!arena) return { ...FAILED, reason: 'staging-arena-unavailable' };

  sweepProjectIgnoreArenas([arena]);

  const stagingDir = createProjectIgnoreRunDir(arena, startedAt);
  if (!stagingDir) return { ...FAILED, reason: 'staging-arena-unavailable' };

  try {
    return maintainProjectIgnoreArtifacts({ context, createSymlink, token, stagingDir });
  } finally {
    removeProjectIgnoreRunDir(stagingDir);
  }
}
