import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import {
  compareSnapshot,
  fsyncParent,
  isMissing,
  isRealDirectory,
  MAX_GITIGNORE_BYTES,
  READ_FLAGS,
  safeUnlink,
  TEMP_WRITE_FLAGS,
} from './artifacts.mjs';

const DURABILITY_MARKER_NAME = /^\.durability-[0-9a-f]{64}\.pending$/u;

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

export function withDurability(artifact, ...outcomes) {
  const durability = combineDurability(artifact.durability, ...outcomes);
  if (!durability) return artifact;
  if (['published', 'unchanged'].includes(artifact.state)) return { ...artifact, durability };
  return artifact.state === 'refused' && durability.state !== 'synced'
    ? { ...artifact, durability }
    : artifact;
}

export function cleanupFinalDurabilityMarker(marker) {
  return safeUnlink(marker.path)
    ? null
    : { state: 'failed', reasons: ['durability-evidence-cleanup-failed'] };
}

// Durability evidence must remain discoverable without the repository context or artifact demand that created it.
function durabilityMarkerPath(durabilityDir, target) {
  const digest = createHash('sha256').update(target).digest('hex');
  return join(durabilityDir, `.durability-${digest}.pending`);
}

export function durabilityMarker(durabilityDir, durabilityRunDir, target) {
  if (!durabilityDir || !durabilityRunDir) return null;
  const path = durabilityMarkerPath(durabilityDir, target);
  return { path, stagingPath: join(durabilityRunDir, basename(path)), target };
}

export function recordPendingDurability(marker) {
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

function isRunOwnedDurabilityTarget(context, target) {
  return [context.projectDir, context.commonGitDir].filter(Boolean).some((directory) => {
    const containment = relative(directory, target);
    return (
      containment.length > 0 &&
      !isAbsolute(containment) &&
      containment !== '..' &&
      !containment.startsWith(`..${sep}`)
    );
  });
}

export function reconcileDurabilityMarkers(durabilityDir, context) {
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
    if (!isRunOwnedDurabilityTarget(context, marker.target)) continue;
    const durability = fsyncParent(marker.target, { missingParentIsSynced: true });
    if (durability.state === 'failed') {
      for (const reason of durability.reasons) reasons.add(reason);
      continue;
    }
    if (durability.state === 'unsupported') {
      const removed = safeUnlink(markerPath);
      if (removed) {
        reasons.add('durability-sync-unsupported-discharged');
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

export function syncPendingPublication(target, marker) {
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

      const snapshotState = compareSnapshot(target, snapshot);
      if (snapshotState !== 'unchanged') {
        result = {
          state: 'refused',
          reason:
            snapshotState === 'observation-failed'
              ? 'artifact-observation-failed'
              : 'artifact-changed',
          residue: 'none',
        };
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
