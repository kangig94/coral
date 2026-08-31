import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import {
  coralProjectDir,
  coralStateRoot,
  prepareCoralProjectDir,
  prepareProjectIgnoreStagingDir,
  PROJECT_IGNORE_ARENA_SWEEP_BUDGET_MS,
  PROJECT_IGNORE_ARENA_SWEEP_MAX_RUNS,
  PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS,
  PROJECT_IGNORE_STAGING_ARENA_MAX_AGE_MS,
} from './hook-utils.mjs';
import { isLegacyWorkingTreeStagingPath, projectIgnoreResult } from './project-ignore-result.mjs';

const MAX_GITIGNORE_BYTES = 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | NO_FOLLOW;
const TEMP_WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const CORAL_IGNORE_ENTRY = 'coral';
const LEGACY_CORAL_IGNORE_ENTRY = '.claude/coral';
const LEGACY_WORKING_TREE_STAGING_MAX_AGE_MS = 30_000;
const DURABILITY_MARKER_NAME = /^\.durability-[0-9a-f]{64}\.pending$/u;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function safeUnlink(path) {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

function readRegularSnapshot(path, { allowMissing = false } = {}) {
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) return { ok: false, reason: 'artifact-unreadable' };
    if (pathStat.size > MAX_GITIGNORE_BYTES) return { ok: false, reason: 'artifact-too-large' };
  } catch (error) {
    if (allowMissing && isMissing(error)) {
      return { ok: true, exists: false, content: Buffer.alloc(0), mode: 0o666 };
    }
    return { ok: false, reason: 'artifact-unreadable' };
  }

  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch {
    return { ok: false, reason: 'artifact-unreadable' };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: 'artifact-unreadable' };
    if (stat.size > MAX_GITIGNORE_BYTES) return { ok: false, reason: 'artifact-too-large' };
    const content = readFileSync(fd);
    if (content.length > MAX_GITIGNORE_BYTES) return { ok: false, reason: 'artifact-too-large' };
    return {
      ok: true,
      exists: true,
      content,
      mode: stat.mode & 0o777,
    };
  } catch {
    return { ok: false, reason: 'artifact-unreadable' };
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

export function fsyncParent(path, { missingParentIsSynced = false } = {}) {
  let fd;
  try {
    fd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(fd);
    return { state: 'synced', reasons: [] };
  } catch (error) {
    if (missingParentIsSynced && (isMissing(error) || error?.code === 'ENOTDIR')) {
      return { state: 'synced', reasons: [] };
    }
    return UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)
      ? { state: 'unsupported', reasons: ['durability-sync-unsupported'] }
      : { state: 'failed', reasons: ['durability-sync-failed'] };
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

function combineDurability(...outcomes) {
  const durability = outcomes.filter(Boolean);
  if (durability.length === 0) return null;
  const state = durability.some((outcome) => outcome.state === 'failed')
    ? 'failed'
    : durability.some((outcome) => outcome.state === 'unsupported')
      ? 'unsupported'
      : 'synced';
  const reasons = [...new Set(durability.flatMap((outcome) => outcome.reasons))].sort();
  return { state, reasons };
}

function withDurability(artifact, ...outcomes) {
  const durability = combineDurability(artifact.durability, ...outcomes);
  if (!durability) return artifact;
  if (['published', 'unchanged'].includes(artifact.state)) return { ...artifact, durability };
  return artifact.state === 'refused' && durability.state !== 'synced'
    ? { ...artifact, durability }
    : artifact;
}

function cleanupFinalDurabilityMarker(marker) {
  return safeUnlink(marker.path)
    ? null
    : { state: 'failed', reasons: ['durability-evidence-cleanup-failed'] };
}

// Durability evidence must remain discoverable without the repository context or artifact demand that created it.
function durabilityMarkerPath(durabilityDir, target) {
  const digest = createHash('sha256').update(target).digest('hex');
  return join(durabilityDir, `.durability-${digest}.pending`);
}

function durabilityMarker(durabilityDir, durabilityRunDir, target) {
  if (!durabilityDir || !durabilityRunDir) return null;
  const path = durabilityMarkerPath(durabilityDir, target);
  return { path, stagingPath: join(durabilityRunDir, basename(path)), target };
}

function recordPendingDurability(marker) {
  let fd;
  let created = false;
  let result = { ok: false, created, residue: 'none' };
  try {
    fd = openSync(marker.stagingPath, TEMP_WRITE_FLAGS, 0o600);
    writeFileSync(fd, marker.target);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(marker.stagingPath, marker.path);
    created = true;
    if (fsyncParent(marker.path).state !== 'synced') {
      result = { ok: false, created, residue: 'none' };
    } else {
      result = { ok: true, created, residue: 'none' };
    }
  } catch {
    result = { ok: false, created, residue: 'none' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (!safeUnlink(marker.stagingPath)) result = { ...result, residue: 'owned-staging' };
  }
  return result;
}

function quarantineDurabilityMarker(durabilityDir, markerPath, markerName) {
  const quarantineDir = join(durabilityDir, 'quarantine');
  let quarantineCreated = false;
  try {
    mkdirSync(quarantineDir, { mode: 0o700 });
    quarantineCreated = true;
  } catch (error) {
    if (error?.code !== 'EEXIST' || !isRealDirectory(quarantineDir)) return false;
  }
  try {
    if (!isRealDirectory(quarantineDir)) return false;
    chmodSync(quarantineDir, 0o700);
  } catch {
    return false;
  }
  if (quarantineCreated && fsyncParent(quarantineDir).state === 'failed') return false;

  let quarantinePath = join(quarantineDir, markerName);
  for (let suffix = 1; ; suffix += 1) {
    try {
      lstatSync(quarantinePath);
      quarantinePath = join(quarantineDir, `${markerName}.${suffix}`);
    } catch (error) {
      if (!isMissing(error)) return false;
      break;
    }
  }

  try {
    renameSync(markerPath, quarantinePath);
  } catch {
    return false;
  }

  const quarantineDurability = fsyncParent(quarantinePath);
  const reconciliationDurability = fsyncParent(markerPath);
  if (quarantineDurability.state !== 'failed' && reconciliationDurability.state !== 'failed') {
    return true;
  }
  try {
    renameSync(quarantinePath, markerPath);
    return false;
  } catch {
    return true;
  }
}

function decodeDurabilityTarget(content) {
  let target;
  try {
    target = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
  return isAbsolute(target) && !target.includes('\0') ? target : null;
}

function readDurabilityMarker(path) {
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > MAX_GITIGNORE_BYTES) {
      return { state: 'invalid' };
    }
  } catch (error) {
    return { state: isMissing(error) ? 'absent' : 'unknown' };
  }

  let fd;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch (error) {
    return { state: isMissing(error) ? 'absent' : 'unknown' };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_GITIGNORE_BYTES) return { state: 'invalid' };
    const content = readFileSync(fd);
    if (content.length > MAX_GITIGNORE_BYTES) return { state: 'invalid' };
    const target = decodeDurabilityTarget(content);
    return target === null || durabilityMarkerPath(dirname(path), target) !== path
      ? { state: 'invalid' }
      : { state: 'valid', target };
  } catch {
    return { state: 'unknown' };
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

function reconcileDurabilityMarkers(durabilityDir) {
  if (!durabilityDir) {
    return { state: 'refused', reasons: ['durability-evidence-unavailable'] };
  }
  let markerNames;
  try {
    markerNames = readdirSync(durabilityDir, { withFileTypes: true })
      .filter((entry) => DURABILITY_MARKER_NAME.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { state: 'refused', reasons: ['durability-evidence-unreadable'] };
  }

  const reasons = new Set();
  for (const name of markerNames) {
    const markerPath = join(durabilityDir, name);
    const marker = readDurabilityMarker(markerPath);
    if (marker.state === 'absent') continue;
    if (marker.state === 'unknown') {
      reasons.add('durability-evidence-unreadable');
      continue;
    }
    if (marker.state === 'invalid') {
      const quarantined = quarantineDurabilityMarker(durabilityDir, markerPath, name);
      reasons.add(
        quarantined ? 'durability-evidence-quarantined' : 'durability-evidence-cleanup-failed',
      );
      continue;
    }
    const durability = fsyncParent(marker.target, { missingParentIsSynced: true });
    if (durability.state === 'failed') {
      for (const reason of durability.reasons) reasons.add(reason);
      continue;
    }
    if (durability.state === 'unsupported') {
      const removed = safeUnlink(markerPath);
      if (removed) {
        for (const reason of durability.reasons) reasons.add(reason);
      } else {
        reasons.add('durability-evidence-cleanup-failed');
      }
      continue;
    }
    if (!safeUnlink(markerPath)) reasons.add('durability-evidence-cleanup-failed');
  }
  return reasons.size > 0
    ? { state: 'refused', reasons: [...reasons].sort() }
    : { state: 'reconciled' };
}

function syncPendingPublication(target, marker) {
  const durability = fsyncParent(target);
  if (durability.state !== 'synced') return durability;
  return safeUnlink(marker.path)
    ? durability
    : { state: 'failed', reasons: ['durability-evidence-cleanup-failed'] };
}

export function atomicReplace({
  target,
  snapshot,
  next,
  stagingDir,
  durabilityMarker,
  stagingName = 'replacement.tmp',
}) {
  if (next.equals(snapshot.content)) {
    return { state: 'unchanged', residue: 'none' };
  }
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

  const tempPath = join(stagingDir, stagingName);
  let fd;
  let markerCreated = false;
  let result = { state: 'refused', reason: 'publish-failed', residue: 'none' };
  try {
    const recorded = recordPendingDurability(durabilityMarker);
    markerCreated = recorded.created;
    if (!recorded.ok) {
      result = {
        state: 'refused',
        reason: 'durability-evidence-unavailable',
        residue: recorded.residue,
      };
    } else {
      fd = openSync(tempPath, TEMP_WRITE_FLAGS, snapshot.mode);
      fchmodSync(fd, snapshot.exists ? snapshot.mode : (fstatSync(fd).mode & 0o777) | 0o600);
      writeFileSync(fd, next);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;

      if (!snapshotUnchanged(target, snapshot)) {
        result = { state: 'refused', reason: 'artifact-changed', residue: 'none' };
      } else {
        try {
          if (snapshot.exists) {
            renameSync(tempPath, target);
          } else {
            linkSync(tempPath, target);
          }
          result = {
            state: 'published',
            residue: 'none',
            durability: syncPendingPublication(target, durabilityMarker),
          };
        } catch (error) {
          result = {
            state: 'refused',
            reason: error?.code === 'EXDEV' ? 'publish-cross-device' : 'publish-failed',
            residue: 'none',
          };
        }
      }
    }
  } catch {
    result = { state: 'refused', reason: 'publish-failed', residue: 'none' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (!safeUnlink(tempPath)) {
      result =
        result.state === 'published'
          ? { ...result, reason: 'staging-cleanup-failed', residue: 'owned-staging' }
          : { ...result, residue: 'owned-staging' };
    }
    if (markerCreated && result.state !== 'published') {
      result = withDurability(result, cleanupFinalDurabilityMarker(durabilityMarker));
    }
  }
  return result;
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

function gitContextProbeDeadline() {
  return process.hrtime.bigint() + BigInt(PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS) * 1_000_000n;
}

function readGitPath(projectDir, args, probeDeadlineNs) {
  const remainingMs = Number((probeDeadlineNs - process.hrtime.bigint()) / 1_000_000n);
  if (remainingMs < 1) throw new Error('git context probe budget exhausted');
  const output = execFileSync('git', args, {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Math.min(remainingMs, PROJECT_IGNORE_CONTEXT_PROBE_BUDGET_MS),
  });
  if (!output.endsWith('\n')) throw new Error('unterminated git context field');
  return output.slice(0, -1);
}

function resolveCommonGitDirectory(gitDir) {
  try {
    const content = readFileSync(join(gitDir, 'commondir'), 'utf-8');
    const value = content.endsWith('\n') ? content.slice(0, -1) : content;
    if (!value || value.includes('\n') || value.includes('\0')) return null;
    return realpathSync(resolve(gitDir, value));
  } catch (error) {
    return isMissing(error) ? gitDir : null;
  }
}

function resolveGitDirectoryIdentity(projectDir, probeDeadlineNs) {
  return realpathSync(readGitPath(projectDir, ['rev-parse', '--absolute-git-dir'], probeDeadlineNs));
}

function findGitContext(projectDir, probeDeadlineNs) {
  try {
    const gitDir = resolveGitDirectoryIdentity(projectDir, probeDeadlineNs);
    const gitRoot = realpathSync(
      readGitPath(projectDir, ['rev-parse', '--show-toplevel'], probeDeadlineNs),
    );
    const commonGitDir = resolveCommonGitDirectory(gitDir);
    if (!gitRoot || !commonGitDir) return { state: 'unresolvable' };
    const excludePath = join(commonGitDir, 'info', 'exclude');
    if (relative(commonGitDir, excludePath) !== join('info', 'exclude')) {
      return { state: 'unresolvable' };
    }
    return {
      state: 'resolved',
      gitDir,
      gitRoot,
      commonGitDir,
      excludePath,
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
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    chmodSync(path, 0o700);
    return true;
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
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    chmodSync(path, 0o700);
    return true;
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

export function isRepositoryProjectIgnoreStagingAuthorized({ gitRoot, commonGitDir }) {
  try {
    const canonicalGitRoot = realpathSync(gitRoot);
    const canonicalCommonGitDir = realpathSync(commonGitDir);
    const containment = relative(canonicalGitRoot, canonicalCommonGitDir);
    const insideWorkingTree =
      containment.length === 0 ||
      (!isAbsolute(containment) && containment !== '..' && !containment.startsWith(`..${sep}`));
    if (!insideWorkingTree) return true;

    const dotGit = join(canonicalGitRoot, '.git');
    const dotGitStat = lstatSync(dotGit);
    return (
      !dotGitStat.isSymbolicLink() &&
      dotGitStat.isDirectory() &&
      realpathSync(dotGit) === canonicalCommonGitDir
    );
  } catch {
    return false;
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
      const arenaStat = lstatSync(arenaDir);
      if (arenaStat.isSymbolicLink() || !arenaStat.isDirectory()) {
        failures += 1;
        continue;
      }
      chmodSync(arenaDir, 0o700);
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
    const runDir = join(candidate.arenaDir, candidate.name);
    try {
      const stat = lstatSync(runDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      chmodSync(runDir, 0o700);
      if (now - candidate.startedAt < PROJECT_IGNORE_STAGING_ARENA_MAX_AGE_MS) continue;
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
    chmodSync(runDir, 0o700);
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
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    rmSync(runDir, { recursive: true });
  } catch (error) {
    return isMissing(error);
  }

  try {
    lstatSync(runDir);
    return false;
  } catch (error) {
    return isMissing(error);
  }
}

export function resolveProjectContext(projectDir, probeDeadlineNs = gitContextProbeDeadline()) {
  let realProjectDir;
  try {
    realProjectDir = realpathSync(projectDir);
  } catch {
    return null;
  }
  const gitContext = findGitContext(realProjectDir, probeDeadlineNs);
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
  const escapedCanonicalEntry = escapeGitignoreLiteralPath(canonicalEntry);
  return {
    projectDir: realProjectDir,
    gitDir: repositoryContext?.gitDir ?? null,
    gitRoot,
    commonGitDir: repositoryContext?.commonGitDir ?? null,
    excludePath: repositoryContext?.excludePath ?? null,
    rootGitignore: join(gitRoot, '.gitignore'),
    legacyEntry: gitignorePrefix ? `${gitignorePrefix}/${LEGACY_CORAL_IGNORE_ENTRY}` : LEGACY_CORAL_IGNORE_ENTRY,
    excludeEntry: escapedCanonicalEntry === null ? null : `/${escapedCanonicalEntry}`,
    refusalReason: escapedCanonicalEntry === null ? 'project-path-unrepresentable' : null,
  };
}

export function isProjectIgnoreContext(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = [
    'projectDir',
    'gitDir',
    'gitRoot',
    'commonGitDir',
    'excludePath',
    'rootGitignore',
    'legacyEntry',
    'excludeEntry',
    'refusalReason',
  ];
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return false;
  if (
    ![value.projectDir, value.gitRoot, value.rootGitignore, value.legacyEntry].every(
      (item) => typeof item === 'string',
    )
  ) {
    return false;
  }
  if (value.commonGitDir !== null && typeof value.commonGitDir !== 'string') return false;
  if (value.gitDir !== null && typeof value.gitDir !== 'string') return false;
  if (value.excludePath !== null && typeof value.excludePath !== 'string') return false;
  if (value.excludeEntry !== null && typeof value.excludeEntry !== 'string') return false;
  return value.refusalReason === null || value.refusalReason === 'project-path-unrepresentable';
}

function isCoralProjectsTarget(path) {
  return ['projects', 'projects-dev'].some((name) => {
    const root = join(coralStateRoot(), name);
    return path === root || path.startsWith(root + sep);
  });
}

function inspectLegacySymlinkAuthorship(path) {
  try {
    return {
      state: 'observed',
      authored: isCoralProjectsTarget(resolve(dirname(path), readlinkSync(path))),
    };
  } catch (error) {
    return { state: isMissing(error) ? 'missing' : 'observation-failed' };
  }
}

function legacyStagingCandidate(context, directory, entry, baseName, kind) {
  if (!entry.name.startsWith(`${baseName}.coral-`) || entry.isDirectory()) {
    return { state: 'not-candidate' };
  }
  const path = join(directory, entry.name);
  const reportPath = relative(context.gitRoot, path);
  if (!isLegacyWorkingTreeStagingPath(reportPath)) return { state: 'not-candidate' };

  try {
    const stat = lstatSync(path);
    if (kind === 'regular' && (stat.isSymbolicLink() || !stat.isFile())) {
      return { state: 'not-candidate' };
    }
    if (kind === 'symlink') {
      if (!stat.isSymbolicLink()) return { state: 'not-candidate' };
      const authorship = inspectLegacySymlinkAuthorship(path);
      if (authorship.state === 'observation-failed') {
        return { state: 'observation-failed', path: reportPath };
      }
      if (authorship.state !== 'observed' || !authorship.authored) {
        return { state: 'not-candidate' };
      }
    }
    return { state: 'candidate', candidate: { path, reportPath, mtimeMs: stat.mtimeMs, kind } };
  } catch (error) {
    return isMissing(error)
      ? { state: 'not-candidate' }
      : { state: 'observation-failed', path: reportPath };
  }
}

function legacyCandidateStillAuthorized(candidate, now) {
  try {
    const stat = lstatSync(candidate.path);
    const age = now - stat.mtimeMs;
    if (!Number.isFinite(age) || age < LEGACY_WORKING_TREE_STAGING_MAX_AGE_MS) {
      return { state: 'not-authorized' };
    }
    if (candidate.kind === 'regular') {
      return { state: !stat.isSymbolicLink() && stat.isFile() ? 'authorized' : 'not-authorized' };
    }
    if (!stat.isSymbolicLink()) return { state: 'not-authorized' };
    const authorship = inspectLegacySymlinkAuthorship(candidate.path);
    if (authorship.state === 'observation-failed') return authorship;
    return {
      state: authorship.state === 'observed' && authorship.authored ? 'authorized' : 'not-authorized',
    };
  } catch (error) {
    return { state: isMissing(error) ? 'not-authorized' : 'observation-failed' };
  }
}

function legacySweepRefusal(reason, path, count) {
  return { state: 'refused', reason, path, count };
}

/**
 * Only age-eligible regular files at exact legacy names and locations may be deleted without authorship evidence.
 * Symlinks without Coral-project target authorship must be retained.
 */
export function sweepLegacyWorkingTreeStaging(context, { now = Date.now() } = {}) {
  const locations = [
    { directory: context.gitRoot, baseName: '.gitignore', kind: 'regular' },
    { directory: join(context.projectDir, '.claude'), baseName: '.gitignore', kind: 'regular' },
    { directory: join(context.projectDir, '.claude'), baseName: 'coral', kind: 'symlink' },
  ];
  let count = 0;

  for (const location of locations) {
    let directoryStat;
    try {
      directoryStat = lstatSync(location.directory);
    } catch (error) {
      if (isMissing(error)) continue;
      return legacySweepRefusal(
        'legacy-sweep-observation-failed',
        relative(context.gitRoot, location.directory) || '.',
        count,
      );
    }
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;

    let entries;
    try {
      entries = readdirSync(location.directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      );
    } catch (error) {
      if (isMissing(error)) continue;
      return legacySweepRefusal(
        'legacy-sweep-observation-failed',
        relative(context.gitRoot, location.directory) || '.',
        count,
      );
    }

    for (const entry of entries) {
      const inspected = legacyStagingCandidate(
        context,
        location.directory,
        entry,
        location.baseName,
        location.kind,
      );
      if (inspected.state === 'observation-failed') {
        return legacySweepRefusal(
          'legacy-sweep-observation-failed',
          inspected.path,
          count,
        );
      }
      if (inspected.state !== 'candidate') continue;
      const candidate = inspected.candidate;
      const age = now - candidate.mtimeMs;
      if (!Number.isFinite(age) || age < LEGACY_WORKING_TREE_STAGING_MAX_AGE_MS) continue;

      const authorization = legacyCandidateStillAuthorized(candidate, now);
      if (authorization.state === 'observation-failed') {
        return legacySweepRefusal(
          'legacy-sweep-observation-failed',
          candidate.reportPath,
          count,
        );
      }
      if (authorization.state !== 'authorized') continue;
      try {
        unlinkSync(candidate.path);
        count = Math.min(count + 1, Number.MAX_SAFE_INTEGER);
      } catch {
        return legacySweepRefusal('legacy-sweep-failed', candidate.reportPath, count);
      }
    }
  }
  return count === 0 ? { state: 'unchanged' } : { state: 'cleaned', count };
}

export function escapeGitignoreLiteralPath(path) {
  if (/[\r\n]/u.test(path)) return null;
  let escaped = '';
  for (const character of path) {
    escaped += ['\\', '*', '?', '[', ']'].includes(character) ? `\\${character}` : character;
  }
  return escaped;
}

function inspectCoralLink(link) {
  try {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) return { state: 'non-link' };
  } catch (error) {
    return { state: isMissing(error) ? 'missing' : 'observation-failed' };
  }

  try {
    return { state: 'link', target: normalize(readlinkSync(link)) };
  } catch (error) {
    return { state: isMissing(error) ? 'missing' : 'observation-failed' };
  }
}

function isOutgrownCoralLink(current, target) {
  if (current === target) return false;
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

function prepareReplacement({
  target,
  snapshot,
  next,
  contentChangeNeeded,
  devicePath,
  stagingDir,
  durabilityDir,
  durabilityRunDir,
}) {
  if (!contentChangeNeeded) return { ok: true, replacement: null };
  if (next.length > MAX_GITIGNORE_BYTES) return { ok: false, reason: 'artifact-too-large' };
  if (!next.equals(snapshot.content)) {
    const deviceRefusal = stagingDeviceRefusal(devicePath, stagingDir);
    if (deviceRefusal) return { ok: false, reason: deviceRefusal };
  }
  const marker = durabilityMarker(durabilityDir, durabilityRunDir, target);
  if (!marker) return { ok: false, reason: 'durability-evidence-unavailable' };
  return { ok: true, replacement: { target, snapshot, next, durabilityMarker: marker } };
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

function isUsableExcludeDirectory(excludeDir) {
  try {
    const stat = lstatSync(excludeDir);
    return !stat.isSymbolicLink() && stat.isDirectory() && (stat.mode & 0o700) === 0o700;
  } catch {
    return false;
  }
}

function addOwnerAccessToCreatedExcludeDirectory(excludeDir) {
  try {
    const stat = lstatSync(excludeDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    chmodSync(excludeDir, (stat.mode & 0o777) | 0o700);
    return isUsableExcludeDirectory(excludeDir);
  } catch {
    return false;
  }
}

function ensureExcludeDirectory(excludePath, durabilityDir, durabilityRunDir) {
  const excludeDir = dirname(excludePath);
  if (isUsableExcludeDirectory(excludeDir)) return { ok: true };
  const marker = durabilityMarker(durabilityDir, durabilityRunDir, excludeDir);
  if (!marker) return { ok: false, reason: 'durability-evidence-unavailable' };
  const recorded = recordPendingDurability(marker);
  if (!recorded.ok) {
    const durability = recorded.created ? cleanupFinalDurabilityMarker(marker) : null;
    return {
      ok: false,
      reason: 'durability-evidence-unavailable',
      residue: recorded.residue,
      ...(durability ? { durability } : {}),
    };
  }
  let created = false;
  try {
    mkdirSync(excludeDir);
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      const durability = recorded.created ? cleanupFinalDurabilityMarker(marker) : null;
      return durability ? { ok: false, durability } : { ok: false };
    }
  }
  const usable = created
    ? addOwnerAccessToCreatedExcludeDirectory(excludeDir)
    : isUsableExcludeDirectory(excludeDir);
  if (!usable) {
    const durability = recorded.created ? cleanupFinalDurabilityMarker(marker) : null;
    return durability ? { ok: false, durability } : { ok: false };
  }
  return { ok: true, durability: syncPendingPublication(excludeDir, marker) };
}

function prepareCoralSymlink(projectDir, createSymlink, stagingDir) {
  const claudeDir = join(projectDir, '.claude');
  const claudeRefusal = createSymlink ? claudeDirectoryRefusal(claudeDir) : null;
  if (claudeRefusal) return { ok: false, reason: claudeRefusal };

  const link = join(projectDir, '.claude', 'coral');
  const inspection = inspectCoralLink(link);
  if (inspection.state === 'observation-failed') {
    return { ok: false, reason: 'symlink-observation-failed' };
  }
  if (inspection.state === 'missing') {
    let target = null;
    if (createSymlink) {
      try {
        target = coralProjectDir(projectDir);
      } catch {
        return { ok: false, reason: 'publish-failed' };
      }
      const targetPreparation = prepareCoralProjectDir(target);
      if (targetPreparation.kind !== 'prepared') {
        return {
          ok: false,
          reason:
            targetPreparation.kind === 'structural-conflict'
              ? 'symlink-target-unavailable'
              : 'publish-failed',
        };
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

  if (inspection.state === 'non-link') {
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
  const targetPreparation = prepareCoralProjectDir(target);
  if (targetPreparation.kind !== 'prepared') {
    return {
      ok: false,
      reason:
        targetPreparation.kind === 'structural-conflict' ? 'symlink-target-unavailable' : 'publish-failed',
    };
  }
  if (!isOutgrownCoralLink(inspection.target, target)) {
    return { ok: true, symlinkExists: true, action: 'unchanged', link, target };
  }
  const deviceRefusal = stagingDeviceRefusal(projectDir, stagingDir);
  if (deviceRefusal) return { ok: false, reason: deviceRefusal };
  return { ok: true, symlinkExists: true, action: 'repoint', link, target };
}

function placeCoralSymlink(symlinkPlan, token, stagingDir, durabilityDir, durabilityRunDir) {
  if (symlinkPlan.action === 'not-requested') return { state: 'not-requested' };

  const target = symlinkPlan.target;
  if (symlinkPlan.action === 'unchanged') return { state: 'unchanged' };

  const marker = durabilityMarker(durabilityDir, durabilityRunDir, symlinkPlan.link);
  if (!marker) return { state: 'refused', reason: 'durability-evidence-unavailable' };

  if (symlinkPlan.action === 'create') {
    let markerCreated = false;
    let result = { state: 'refused', reason: 'publish-failed' };
    try {
      const recorded = recordPendingDurability(marker);
      markerCreated = recorded.created;
      if (!recorded.ok) {
        result = {
          state: 'refused',
          reason: 'durability-evidence-unavailable',
          ...(recorded.residue === 'owned-staging' ? { residue: recorded.residue } : {}),
        };
      } else {
        symlinkSync(target, symlinkPlan.link);
        result = {
          state: 'created',
          durability: syncPendingPublication(symlinkPlan.link, marker),
        };
      }
    } catch (error) {
      result = {
        state: 'refused',
        reason: error?.code === 'EEXIST' ? 'symlink-conflict' : 'publish-failed',
      };
    } finally {
      if (markerCreated && result.state !== 'created') {
        result = withDurability(result, cleanupFinalDurabilityMarker(marker));
      }
    }
    return result;
  }

  const tempLink = join(stagingDir, `coral-${token}.tmp`);
  let markerCreated = false;
  let result = { state: 'refused', reason: 'publish-failed', residue: 'none' };
  try {
    const recorded = recordPendingDurability(marker);
    markerCreated = recorded.created;
    if (!recorded.ok) {
      result = {
        state: 'refused',
        reason: 'durability-evidence-unavailable',
        residue: recorded.residue,
      };
    } else {
      symlinkSync(target, tempLink);
      renameSync(tempLink, symlinkPlan.link);
      result = {
        state: 'repointed',
        residue: 'none',
        durability: syncPendingPublication(symlinkPlan.link, marker),
      };
    }
  } catch (error) {
    result = {
      state: 'refused',
      reason: error?.code === 'EXDEV' ? 'publish-cross-device' : 'publish-failed',
      residue: 'none',
    };
  } finally {
    if (!safeUnlink(tempLink)) {
      result =
        result.state === 'repointed'
          ? { ...result, reason: 'staging-cleanup-failed', residue: 'owned-staging' }
          : { ...result, residue: 'owned-staging' };
    }
    if (markerCreated && result.state !== 'repointed') {
      result = withDurability(result, cleanupFinalDurabilityMarker(marker));
    }
  }
  return result;
}

const SKIPPED_REPLACEMENT = { state: 'skipped', reason: 'upstream-refusal', residue: 'none' };
const SKIPPED_ARTIFACT = { state: 'skipped', reason: 'upstream-refusal' };

function refusedArtifacts(arenaSweep, legacySweep, artifact, reason) {
  const artifacts = {
    arenaSweep,
    durabilityReconciliation: { state: 'reconciled' },
    legacySweep,
    exclude: { ...SKIPPED_REPLACEMENT },
    symlink: { ...SKIPPED_ARTIFACT },
    scopedIgnoreRetraction: { ...SKIPPED_REPLACEMENT },
    rootIgnoreRetraction: { ...SKIPPED_REPLACEMENT },
  };
  artifacts[artifact] =
    artifact === 'symlink'
      ? { state: 'refused', reason }
      : { state: 'refused', reason, residue: 'none' };
  return artifacts;
}

function refusedDurabilityReconciliation(arenaSweep, durabilityReconciliation) {
  return {
    arenaSweep,
    durabilityReconciliation,
    legacySweep: { ...SKIPPED_ARTIFACT },
    exclude: { ...SKIPPED_REPLACEMENT },
    symlink: { ...SKIPPED_ARTIFACT },
    scopedIgnoreRetraction: { ...SKIPPED_REPLACEMENT },
    rootIgnoreRetraction: { ...SKIPPED_REPLACEMENT },
  };
}

function preflightProjectIgnoreArtifacts({
  context,
  createSymlink,
  stagingDir,
  durabilityDir,
  durabilityRunDir,
}) {
  const symlink = prepareCoralSymlink(context.projectDir, createSymlink, stagingDir);
  if (!symlink.ok) return { ok: false, artifact: 'symlink', reason: symlink.reason };

  const rootSnapshot = readRegularSnapshot(context.rootGitignore, { allowMissing: true });
  if (!rootSnapshot.ok) {
    return { ok: false, artifact: 'rootIgnoreRetraction', reason: rootSnapshot.reason };
  }

  const claudeDir = join(context.projectDir, '.claude');
  let scopedSnapshot = null;
  if (isRealDirectory(claudeDir)) {
    scopedSnapshot = readRegularSnapshot(join(claudeDir, '.gitignore'), { allowMissing: true });
    if (!scopedSnapshot.ok) {
      return { ok: false, artifact: 'scopedIgnoreRetraction', reason: scopedSnapshot.reason };
    }
  }

  const wantsExclude = symlink.symlinkExists || createSymlink;
  if (wantsExclude && context.commonGitDir && !context.excludePath) {
    return { ok: false, artifact: 'exclude', reason: 'exclude-path-unresolvable' };
  }
  const publishExclude = wantsExclude && context.excludePath !== null;
  let excludeSnapshot = null;
  let excludePathDevice = null;
  if (publishExclude) {
    const excludeDir = dirname(context.excludePath);
    try {
      const excludeDirStat = lstatSync(excludeDir);
      if (
        excludeDirStat.isSymbolicLink() ||
        !excludeDirStat.isDirectory() ||
        !isUsableExcludeDirectory(excludeDir)
      ) {
        return { ok: false, artifact: 'exclude', reason: 'artifact-unreadable' };
      }
    } catch (error) {
      if (!isMissing(error)) {
        return { ok: false, artifact: 'exclude', reason: 'artifact-unreadable' };
      }
    }
    excludeSnapshot = readRegularSnapshot(context.excludePath, { allowMissing: true });
    if (!excludeSnapshot.ok) return { ok: false, artifact: 'exclude', reason: excludeSnapshot.reason };
    excludePathDevice = excludeDevicePath(context.excludePath);
    if (!excludePathDevice) return { ok: false, artifact: 'exclude', reason: 'publish-failed' };
  }

  let exclude = null;
  if (publishExclude) {
    exclude = prepareReplacement({
      target: context.excludePath,
      snapshot: excludeSnapshot,
      next: appendExactLine(excludeSnapshot.content, context.excludeEntry),
      contentChangeNeeded: !hasExactLine(excludeSnapshot.content, context.excludeEntry),
      devicePath: excludePathDevice,
      stagingDir,
      durabilityDir,
      durabilityRunDir,
    });
  }
  let scopedIgnoreRetraction = null;
  if (scopedSnapshot) {
    scopedIgnoreRetraction = prepareReplacement({
      target: join(claudeDir, '.gitignore'),
      snapshot: scopedSnapshot,
      next: removeExactLines(scopedSnapshot.content, CORAL_IGNORE_ENTRY),
      contentChangeNeeded: hasExactLine(scopedSnapshot.content, CORAL_IGNORE_ENTRY),
      devicePath: claudeDir,
      stagingDir,
      durabilityDir,
      durabilityRunDir,
    });
  }
  const rootIgnoreRetraction = prepareReplacement({
    target: context.rootGitignore,
    snapshot: rootSnapshot,
    next: removeExactLines(rootSnapshot.content, context.legacyEntry),
    contentChangeNeeded: hasExactLine(rootSnapshot.content, context.legacyEntry),
    devicePath: context.gitRoot,
    stagingDir,
    durabilityDir,
    durabilityRunDir,
  });

  for (const [artifact, replacement] of [
    ['exclude', exclude],
    ['scopedIgnoreRetraction', scopedIgnoreRetraction],
    ['rootIgnoreRetraction', rootIgnoreRetraction],
  ]) {
    if (replacement && !replacement.ok) return { ok: false, artifact, reason: replacement.reason };
  }

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

function maintainProjectIgnoreArtifacts({
  context,
  createSymlink,
  token,
  stagingDir,
  durabilityDir,
  durabilityRunDir,
  arenaSweep,
  legacySweep,
}) {
  const preflight = preflightProjectIgnoreArtifacts({
    context,
    createSymlink,
    stagingDir,
    durabilityDir,
    durabilityRunDir,
  });
  if (!preflight.ok) {
    return refusedArtifacts(arenaSweep, legacySweep, preflight.artifact, preflight.reason);
  }

  const artifacts = {
    arenaSweep,
    durabilityReconciliation: { state: 'reconciled' },
    legacySweep,
    exclude: preflight.publishExclude
      ? { state: 'unchanged', residue: 'none' }
      : { state: 'not-needed', residue: 'none' },
    symlink: { state: preflight.symlink.action },
    scopedIgnoreRetraction: preflight.replacements.scopedIgnoreRetraction
      ? { state: 'unchanged', residue: 'none' }
      : { state: 'not-needed', residue: 'none' },
    rootIgnoreRetraction: preflight.replacements.rootIgnoreRetraction
      ? { state: 'unchanged', residue: 'none' }
      : { state: 'not-needed', residue: 'none' },
  };
  if (preflight.publishExclude) {
    const excludeDirectory = ensureExcludeDirectory(
      context.excludePath,
      durabilityDir,
      durabilityRunDir,
    );
    if (!excludeDirectory.ok) {
      artifacts.exclude = withDurability(
        {
          state: 'refused',
          reason: excludeDirectory.reason ?? 'publish-failed',
          residue: excludeDirectory.residue ?? 'none',
        },
        excludeDirectory.durability,
      );
      artifacts.symlink = { ...SKIPPED_ARTIFACT };
      artifacts.scopedIgnoreRetraction = { ...SKIPPED_REPLACEMENT };
      artifacts.rootIgnoreRetraction = { ...SKIPPED_REPLACEMENT };
      return artifacts;
    }
    artifacts.exclude = withDurability(
      preflight.replacements.exclude
        ? atomicReplace({ ...preflight.replacements.exclude, stagingDir })
        : artifacts.exclude,
      excludeDirectory.durability,
    );
    if (artifacts.exclude.state === 'refused') {
      artifacts.symlink = { ...SKIPPED_ARTIFACT };
      artifacts.scopedIgnoreRetraction = { ...SKIPPED_REPLACEMENT };
      artifacts.rootIgnoreRetraction = { ...SKIPPED_REPLACEMENT };
      return artifacts;
    }
  }

  artifacts.symlink = placeCoralSymlink(
    preflight.symlink,
    token,
    stagingDir,
    durabilityDir,
    durabilityRunDir,
  );
  if (artifacts.symlink.state === 'refused') {
    artifacts.scopedIgnoreRetraction = { ...SKIPPED_REPLACEMENT };
    artifacts.rootIgnoreRetraction = { ...SKIPPED_REPLACEMENT };
    return artifacts;
  }

  if (preflight.replacements.scopedIgnoreRetraction) {
    artifacts.scopedIgnoreRetraction = atomicReplace({
      ...preflight.replacements.scopedIgnoreRetraction,
      stagingDir,
      stagingName: 'scoped-ignore-retraction.tmp',
    });
    if (artifacts.scopedIgnoreRetraction.state === 'refused') {
      artifacts.rootIgnoreRetraction = { ...SKIPPED_REPLACEMENT };
      return artifacts;
    }
  }

  if (preflight.replacements.rootIgnoreRetraction) {
    artifacts.rootIgnoreRetraction = atomicReplace({
      ...preflight.replacements.rootIgnoreRetraction,
      stagingDir,
      stagingName: 'root-ignore-retraction.tmp',
    });
  }
  return artifacts;
}

function reconcileRemovedProjectIgnoreStaging(artifacts) {
  for (const key of ['exclude', 'symlink', 'scopedIgnoreRetraction', 'rootIgnoreRetraction']) {
    const artifact = artifacts[key];
    if (artifact.residue !== 'owned-staging') continue;
    const reconciled = { ...artifact, residue: 'none' };
    if (['published', 'repointed'].includes(artifact.state)) delete reconciled.reason;
    artifacts[key] = reconciled;
  }
}

export function projectIgnoreContextRefusal(context) {
  if (context && !context.refusalReason) return null;
  const artifact = context ? 'exclude' : 'symlink';
  const reason = context?.refusalReason ?? 'project-context-unresolvable';
  return projectIgnoreResult(
    refusedArtifacts({ ...SKIPPED_ARTIFACT }, { ...SKIPPED_ARTIFACT }, artifact, reason),
  );
}

export function maintainProjectIgnore({
  projectDir,
  createSymlink = false,
  token = `${process.pid}-${Date.now()}`,
  context: suppliedContext,
  contextProbeDeadlineNs,
}) {
  const context =
    suppliedContext === undefined
      ? resolveProjectContext(projectDir, contextProbeDeadlineNs)
      : suppliedContext;
  const contextRefusal = projectIgnoreContextRefusal(context);
  if (contextRefusal) return contextRefusal;
  if (
    suppliedContext !== undefined &&
    !isDeepStrictEqual(
      resolveProjectContext(context.projectDir, contextProbeDeadlineNs),
      suppliedContext,
    )
  ) {
    return projectIgnoreContextRefusal(null);
  }

  const startedAt = Date.now();
  const fallbackArena = prepareProjectIgnoreStagingDir();
  const repositoryArenaAuthorized = Boolean(
    context?.commonGitDir && isRepositoryProjectIgnoreStagingAuthorized(context),
  );
  const repositoryArena = repositoryArenaAuthorized
    ? prepareRepositoryProjectIgnoreStagingDir(context.commonGitDir)
    : null;
  const arenaDirs = [fallbackArena, repositoryArena].filter(Boolean);
  const arenaResult = sweepProjectIgnoreArenas(arenaDirs);
  const arenaPreparationFailures =
    Number(fallbackArena === null) + Number(repositoryArenaAuthorized && !repositoryArena);
  const arenaSweep =
    arenaPreparationFailures + arenaResult.failures > 0
      ? { state: 'refused', reason: 'arena-sweep-failed' }
      : arenaResult.removed > 0
        ? { state: 'cleaned' }
        : { state: 'unchanged' };

  let artifacts;
  const reconciliation = reconcileDurabilityMarkers(fallbackArena);
  if (reconciliation.state === 'refused') {
    artifacts = refusedDurabilityReconciliation(arenaSweep, reconciliation);
  } else {
    const legacySweep = sweepLegacyWorkingTreeStaging(context);
    if (legacySweep.state === 'refused') {
      artifacts = {
        arenaSweep,
        durabilityReconciliation: reconciliation,
        legacySweep,
        exclude: { ...SKIPPED_REPLACEMENT },
        symlink: { ...SKIPPED_ARTIFACT },
        scopedIgnoreRetraction: { ...SKIPPED_REPLACEMENT },
        rootIgnoreRetraction: { ...SKIPPED_REPLACEMENT },
      };
    } else {
      const useRepositoryArena = context.commonGitDir !== null && repositoryArenaAuthorized;
      const durabilityRunDir = fallbackArena
        ? createProjectIgnoreRunDir(fallbackArena, startedAt)
        : null;
      const stagingDir = useRepositoryArena
        ? repositoryArena
          ? createProjectIgnoreRunDir(repositoryArena, startedAt)
          : null
        : durabilityRunDir;
      try {
        if (!stagingDir && useRepositoryArena) {
          artifacts = refusedArtifacts(
            arenaSweep,
            legacySweep,
            'exclude',
            'repository-arena-unavailable',
          );
        } else {
          artifacts = maintainProjectIgnoreArtifacts({
            context,
            createSymlink,
            token,
            stagingDir,
            durabilityDir: fallbackArena,
            durabilityRunDir,
            arenaSweep,
            legacySweep,
          });
        }
      } finally {
        const runDirectoriesRemoved = [...new Set([stagingDir, durabilityRunDir].filter(Boolean))]
          .map((runDir) => removeProjectIgnoreRunDir(runDir))
          .every(Boolean);
        if (runDirectoriesRemoved) {
          reconcileRemovedProjectIgnoreStaging(artifacts);
        } else {
          artifacts.arenaSweep = { state: 'refused', reason: 'arena-sweep-failed' };
        }
      }
    }
  }
  return projectIgnoreResult(artifacts);
}
