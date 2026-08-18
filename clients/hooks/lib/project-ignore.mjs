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
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { coralProjectDir, coralStateRoot } from './hook-utils.mjs';

const MAX_GITIGNORE_BYTES = 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW;
const TEMP_WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const CORAL_IGNORE_ENTRY = 'coral';
// `ensureCoralSymlink` swaps the link in via `renameSync` over a temp name so a kill between the write and the
// swap never leaves `.claude/coral` missing — but a kill before the swap leaves the temp name itself behind,
// and its `.coral-<pid>-<ts>.tmp` suffix means the exact-match `coral` line above does not cover it.
const CORAL_IGNORE_TEMP_ENTRY = 'coral.coral-*.tmp';
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

function atomicTransform(path, transform, token) {
  const snapshot = readRegularSnapshot(path, { allowMissing: true });
  if (!snapshot.ok) return { ok: false, changed: false };

  const next = transform(snapshot.content);
  if (next.equals(snapshot.content)) return { ok: true, changed: false };
  if (next.length > MAX_GITIGNORE_BYTES) return { ok: false, changed: false };

  const tempPath = `${path}.coral-${token}.tmp`;
  let fd;
  try {
    fd = openSync(tempPath, TEMP_WRITE_FLAGS, snapshot.mode);
    writeFileSync(fd, next);
    if (snapshot.exists) fchmodSync(fd, snapshot.mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    if (!snapshotUnchanged(path, snapshot)) return { ok: false, changed: false };
    if (snapshot.exists) {
      renameSync(tempPath, path);
    } else {
      linkSync(tempPath, path);
      unlinkSync(tempPath);
    }
    fsyncParent(path);
    return { ok: true, changed: true };
  } catch {
    return { ok: false, changed: false };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
    safeUnlink(tempPath);
  }
}

function ensureRealDirectory(path) {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch (error) {
    if (!isMissing(error)) return false;
  }

  try {
    mkdirSync(path, { recursive: true });
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch {
    return false;
  }
}

// This fork is paid by every call to `resolveProjectContext` below, no-op or not — finding the ignore-scoped
// git root is not something the symlink logic can skip past. On the common path where `.claude/coral` already
// exists, `ensureCoralSymlink` pays a second fork of its own (`coralProjectDir`'s 2000ms bound in
// `hook-utils.mjs`, to confirm the link is not outgrown), so the worst case here is 1500 + 2000 = 3500ms —
// exactly `session-start.mjs`'s `spawnSync` timeout for this whole script, with no margin left for this
// process's own Node startup on top. Both totals are measured, not assumed.
function findGitRoot(projectDir) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1500,
    }).trim();
    return realpathSync(root);
  } catch {
    return projectDir;
  }
}

function resolveProjectContext(projectDir) {
  let realProjectDir;
  try {
    realProjectDir = realpathSync(projectDir);
  } catch {
    return null;
  }
  const gitRoot = findGitRoot(realProjectDir);
  const projectRelative = relative(gitRoot, realProjectDir);
  if (isAbsolute(projectRelative) || projectRelative === '..' || projectRelative.startsWith(`..${sep}`)) {
    return null;
  }
  const gitignorePrefix = projectRelative.replaceAll('\\', '/');
  return {
    projectDir: realProjectDir,
    gitRoot,
    rootGitignore: join(gitRoot, '.gitignore'),
    legacyEntry: gitignorePrefix ? `${gitignorePrefix}/${LEGACY_CORAL_IGNORE_ENTRY}` : LEGACY_CORAL_IGNORE_ENTRY,
  };
}

function ensureScopedIgnore(projectDir, token) {
  const claudeDir = join(projectDir, '.claude');
  if (!ensureRealDirectory(claudeDir)) return { ok: false, changed: false };
  return atomicTransform(
    join(claudeDir, '.gitignore'),
    (content) => appendExactLine(appendExactLine(content, CORAL_IGNORE_ENTRY), CORAL_IGNORE_TEMP_ENTRY),
    token,
  );
}

/**
 * Whether an existing `.claude/coral` link is one Coral placed and has since outgrown.
 *
 * Only a link pointing into `~/.coral/projects*` qualifies. Anything else — a link an operator made to a
 * directory of their own — is left exactly where it is; correcting our own artifact is not licence to
 * overwrite someone's.
 *
 * This exists because the flavor fix in `coralProjectDir` moved the target on dev builds, and this function
 * returned on "a symlink is there" without asking where it went. That left a link into the prod tree on every
 * dev install that already had one, while `CORAL_PROJECT` moved to `projects-dev` — the two-directory split
 * the flavor fix was closing, reopened one path over.
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

function ensureCoralSymlink(projectDir, token) {
  const link = join(projectDir, '.claude', 'coral');
  let target;
  let repointed = false;
  try {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) return { ok: false, created: false, repointed: false };
    // Computed here, not before the lstat: only the two branches that don't reach this point — not a symlink,
    // or an lstat error below — have no need to know the target at all, so only they are fork-free. The
    // ordinary case, an existing symlink that turns out to already be correct, still pays this fork:
    // confirming "already correct" is impossible without a target to compare against (see `findGitRoot`'s
    // comment above for the combined budget this adds up to).
    target = coralProjectDir(projectDir);
    if (!isOutgrownCoralLink(link, target)) return { ok: true, created: false, repointed: false };
    repointed = true;
  } catch (error) {
    if (!isMissing(error)) return { ok: false, created: false, repointed: false };
  }

  target ??= coralProjectDir(projectDir);
  // symlinkSync into a fresh temp name, then rename over `link` — never unlink-then-symlink. This hook runs
  // under a hard kill budget (session-start.mjs's spawnSync timeout); an unlink with no symlink to follow it
  // yet is a window where a SIGTERM leaves `.claude/coral` gone rather than merely stale.
  const tempLink = `${link}.coral-${token}.tmp`;
  try {
    mkdirSync(target, { recursive: true });
    symlinkSync(target, tempLink);
    renameSync(tempLink, link);
    return { ok: true, created: !repointed, repointed };
  } catch {
    return { ok: false, created: false, repointed: false };
  } finally {
    safeUnlink(tempLink);
  }
}

export function maintainProjectIgnore({ projectDir, createSymlink = false, token = `${process.pid}-${Date.now()}` }) {
  const context = resolveProjectContext(projectDir);
  if (!context) {
    return { ok: false, migrated: false, scopedIgnoreUpdated: false, symlinkCreated: false, symlinkRepointed: false };
  }

  const rootSnapshot = readRegularSnapshot(context.rootGitignore, { allowMissing: true });
  if (!rootSnapshot.ok) {
    return { ok: false, migrated: false, scopedIgnoreUpdated: false, symlinkCreated: false, symlinkRepointed: false };
  }
  const hasLegacyEntry = rootSnapshot.exists && hasExactLine(rootSnapshot.content, context.legacyEntry);
  let scopedIgnoreUpdated = false;

  if (hasLegacyEntry || createSymlink) {
    const scoped = ensureScopedIgnore(context.projectDir, token);
    if (!scoped.ok) {
      return { ok: false, migrated: false, scopedIgnoreUpdated: false, symlinkCreated: false, symlinkRepointed: false };
    }
    scopedIgnoreUpdated = scoped.changed;
  }

  let migrated = false;
  if (hasLegacyEntry) {
    const migration = atomicTransform(
      context.rootGitignore,
      (content) => removeExactLines(content, context.legacyEntry),
      token,
    );
    if (!migration.ok) {
      return { ok: false, migrated: false, scopedIgnoreUpdated, symlinkCreated: false, symlinkRepointed: false };
    }
    migrated = migration.changed;
  }

  let symlinkCreated = false;
  let symlinkRepointed = false;
  if (createSymlink) {
    const symlink = ensureCoralSymlink(context.projectDir, token);
    if (!symlink.ok) {
      return { ok: false, migrated, scopedIgnoreUpdated, symlinkCreated: false, symlinkRepointed: false };
    }
    symlinkCreated = symlink.created;
    symlinkRepointed = symlink.repointed;
  }

  return { ok: true, migrated, scopedIgnoreUpdated, symlinkCreated, symlinkRepointed };
}
