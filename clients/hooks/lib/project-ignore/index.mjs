import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { coralProjectDir, coralStateRoot } from '../hook-utils.mjs';
import {
  CONTEXT_PROBE_BUDGET_MS,
  createArenaRunDir,
  fallbackArenaDir,
  isRepositoryArenaAuthorized,
  prepareCoralProjectDir,
  prepareFallbackArena,
  prepareRepositoryArena,
  removeArenaRunDir,
  sweepArenas,
} from './arena.mjs';
import {
  ARTIFACT_ACCESS_CODES,
  ARTIFACT_STRUCTURAL_CODES,
  isMissing,
  isRealDirectory,
  MAX_GITIGNORE_BYTES,
  observeDirectory,
  readRegularSnapshot,
  safeUnlink,
} from './artifacts.mjs';
import {
  atomicReplace,
  cleanupFinalDurabilityMarker,
  durabilityMarker,
  reconcileDurabilityMarkers,
  recordPendingDurability,
  syncPendingPublication,
  withDurability,
} from './durability.mjs';
import { sweepLegacyWorkingTreeStaging } from './legacy.mjs';
import { projectIgnoreResult } from './result.mjs';

const CORAL_IGNORE_ENTRY = 'coral';
const LEGACY_CORAL_IGNORE_ENTRY = '.claude/coral';

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
  return process.hrtime.bigint() + BigInt(CONTEXT_PROBE_BUDGET_MS) * 1_000_000n;
}

function readGitPath(projectDir, args, probeDeadlineNs) {
  const remainingMs = Number((probeDeadlineNs - process.hrtime.bigint()) / 1_000_000n);
  if (remainingMs < 1) throw new Error('git context probe budget exhausted');
  const output = execFileSync('git', args, {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: Math.min(remainingMs, CONTEXT_PROBE_BUDGET_MS),
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
  stagingRefusal,
  durabilityDir,
  durabilityRunDir,
}) {
  if (!contentChangeNeeded) return { ok: true, replacement: null };
  if (next.length > MAX_GITIGNORE_BYTES) return { ok: false, reason: 'artifact-too-large' };
  if (!next.equals(snapshot.content)) {
    if (!stagingDir && stagingRefusal) return { ok: false, ...stagingRefusal };
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

function observeUsableExcludeDirectory(excludeDir) {
  try {
    const stat = lstatSync(excludeDir);
    return !stat.isSymbolicLink() && stat.isDirectory() && (stat.mode & 0o700) === 0o700
      ? 'usable'
      : 'structural';
  } catch (error) {
    if (isMissing(error)) return 'missing';
    return ARTIFACT_ACCESS_CODES.has(error?.code) || ARTIFACT_STRUCTURAL_CODES.has(error?.code)
      ? 'structural'
      : 'observation-failed';
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

function prepareCoralSymlinkTarget(projectDir) {
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
        targetPreparation.kind === 'structural-conflict'
          ? 'symlink-target-unavailable'
          : 'publish-failed',
    };
  }
  return { ok: true, target };
}

function prepareCoralSymlink(projectDir, createSymlink, stagingDir, stagingRefusal) {
  const claudeDir = join(projectDir, '.claude');
  const link = join(projectDir, '.claude', 'coral');
  const claudeDirectory = observeDirectory(claudeDir);
  if (claudeDirectory === 'observation-failed') {
    return { ok: false, reason: 'symlink-observation-failed' };
  }
  if (!createSymlink && claudeDirectory !== 'directory') {
    return { ok: true, symlinkExists: false, action: 'not-requested', link, target: null };
  }
  if (claudeDirectory === 'non-directory') {
    return { ok: false, reason: 'claude-directory-invalid' };
  }
  if (claudeDirectory === 'missing') {
    return { ok: false, reason: 'claude-directory-missing' };
  }

  const inspection = inspectCoralLink(link);
  if (inspection.state === 'observation-failed') {
    return { ok: false, reason: 'symlink-observation-failed' };
  }
  if (inspection.state === 'missing') {
    let target = null;
    if (createSymlink) {
      const preparedTarget = prepareCoralSymlinkTarget(projectDir);
      if (!preparedTarget.ok) return preparedTarget;
      target = preparedTarget.target;
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

  const preparedTarget = prepareCoralSymlinkTarget(projectDir);
  if (!preparedTarget.ok) return preparedTarget;
  const { target } = preparedTarget;
  if (!isOutgrownCoralLink(inspection.target, target)) {
    return { ok: true, symlinkExists: true, action: 'unchanged', link, target };
  }
  if (!stagingDir && stagingRefusal) return { ok: false, ...stagingRefusal };
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

function refusedArtifacts(arenaSweep, legacySweep, artifact, reason, detail = {}) {
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
      ? { state: 'refused', reason, ...detail }
      : { state: 'refused', reason, residue: 'none', ...detail };
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
  stagingRefusal,
  durabilityDir,
  durabilityRunDir,
}) {
  const symlink = prepareCoralSymlink(
    context.projectDir,
    createSymlink,
    stagingDir,
    stagingRefusal,
  );
  if (!symlink.ok) {
    return {
      ok: false,
      artifact: 'symlink',
      reason: symlink.reason,
      ...(symlink.component ? { component: symlink.component } : {}),
    };
  }

  const rootSnapshot = readRegularSnapshot(context.rootGitignore);
  if (!rootSnapshot.ok) {
    return { ok: false, artifact: 'rootIgnoreRetraction', reason: rootSnapshot.reason };
  }

  const claudeDir = join(context.projectDir, '.claude');
  let scopedSnapshot = null;
  const scopedDirectory = observeDirectory(claudeDir);
  if (scopedDirectory === 'observation-failed') {
    return {
      ok: false,
      artifact: 'scopedIgnoreRetraction',
      reason: 'artifact-observation-failed',
    };
  }
  if (scopedDirectory === 'directory') {
    scopedSnapshot = readRegularSnapshot(join(claudeDir, '.gitignore'));
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
    const excludeDirectory = observeUsableExcludeDirectory(excludeDir);
    if (excludeDirectory === 'structural') {
      return { ok: false, artifact: 'exclude', reason: 'artifact-unreadable' };
    }
    if (excludeDirectory === 'observation-failed') {
      return { ok: false, artifact: 'exclude', reason: 'artifact-observation-failed' };
    }
    excludeSnapshot = readRegularSnapshot(context.excludePath);
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
      stagingRefusal,
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
      stagingRefusal,
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
    stagingRefusal,
    durabilityDir,
    durabilityRunDir,
  });

  for (const [artifact, replacement] of [
    ['exclude', exclude],
    ['scopedIgnoreRetraction', scopedIgnoreRetraction],
    ['rootIgnoreRetraction', rootIgnoreRetraction],
  ]) {
    if (replacement && !replacement.ok) {
      return {
        ok: false,
        artifact,
        reason: replacement.reason,
        ...(replacement.component ? { component: replacement.component } : {}),
      };
    }
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
  stagingRefusal,
  durabilityDir,
  durabilityRunDir,
  arenaSweep,
  legacySweep,
}) {
  const preflight = preflightProjectIgnoreArtifacts({
    context,
    createSymlink,
    stagingDir,
    stagingRefusal,
    durabilityDir,
    durabilityRunDir,
  });
  if (!preflight.ok) {
    return refusedArtifacts(
      arenaSweep,
      legacySweep,
      preflight.artifact,
      preflight.reason,
      preflight.component ? { component: preflight.component } : {},
    );
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

function reconcileRemovedProjectIgnoreStaging(
  artifacts,
  removedRunDirectories,
  stagingDir,
  durabilityRunDir,
) {
  for (const key of ['exclude', 'symlink', 'scopedIgnoreRetraction', 'rootIgnoreRetraction']) {
    const artifact = artifacts[key];
    if (artifact.residue !== 'owned-staging') continue;
    const ownerRunDir =
      artifact.reason === 'durability-evidence-unavailable' ? durabilityRunDir : stagingDir;
    if (!removedRunDirectories.has(ownerRunDir)) continue;
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
  const fallbackArena = prepareFallbackArena();
  const fallbackArenaPreparation = fallbackArena
    ? { state: 'prepared', path: fallbackArena }
    : observeDirectory(fallbackArenaDir()) === 'non-directory'
      ? { state: 'structural-conflict', path: fallbackArenaDir() }
      : { state: 'unavailable', path: fallbackArenaDir() };
  const repositoryArenaAuthorized = Boolean(
    context?.commonGitDir && isRepositoryArenaAuthorized(context),
  );
  const repositoryArenaPreparation = repositoryArenaAuthorized
    ? prepareRepositoryArena(context.commonGitDir)
    : { state: 'not-requested', path: null };
  const repositoryArena =
    repositoryArenaPreparation.state === 'prepared' ? repositoryArenaPreparation.path : null;
  const arenaDirs = [fallbackArena, repositoryArena].filter(Boolean);
  const arenaResult = sweepArenas(arenaDirs);
  const arenaStructuralConflict =
    fallbackArenaPreparation.state === 'structural-conflict' ||
    arenaResult.failures.some((failure) => failure.state === 'structural-conflict');
  const arenaSweep = arenaStructuralConflict
    ? { state: 'refused', reason: 'arena-structural-conflict' }
    : arenaResult.failures.length > 0
      ? { state: 'refused', reason: 'arena-sweep-failed' }
      : arenaResult.removed > 0
        ? { state: 'cleaned' }
        : { state: 'unchanged' };

  let artifacts;
  const reconciliation = reconcileDurabilityMarkers(fallbackArena, context);
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
        ? createArenaRunDir(fallbackArena, startedAt)
        : null;
      const stagingDir = useRepositoryArena
        ? repositoryArena
          ? createArenaRunDir(repositoryArena, startedAt)
          : null
        : durabilityRunDir;
      const stagingRefusal =
        useRepositoryArena && !repositoryArena
          ? {
              reason:
                repositoryArenaPreparation.state === 'structural-conflict'
                  ? 'repository-arena-conflict'
                  : 'repository-arena-unavailable',
              ...(repositoryArenaPreparation.component
                ? { component: repositoryArenaPreparation.component }
                : {}),
            }
          : null;
      try {
        artifacts = maintainProjectIgnoreArtifacts({
          context,
          createSymlink,
          token,
          stagingDir,
          stagingRefusal,
          durabilityDir: fallbackArena,
          durabilityRunDir,
          arenaSweep,
          legacySweep,
        });
      } finally {
        const runDirectoryRemovals = [...new Set([stagingDir, durabilityRunDir].filter(Boolean))].map(
          (runDir) => [runDir, removeArenaRunDir(runDir)],
        );
        const removedRunDirectories = new Set(
          runDirectoryRemovals.filter(([, removed]) => removed).map(([runDir]) => runDir),
        );
        reconcileRemovedProjectIgnoreStaging(
          artifacts,
          removedRunDirectories,
          stagingDir,
          durabilityRunDir,
        );
        if (runDirectoryRemovals.some(([, removed]) => !removed)) {
          artifacts.arenaSweep = { state: 'refused', reason: 'arena-sweep-failed' };
        }
      }
    }
  }
  return projectIgnoreResult(artifacts);
}
