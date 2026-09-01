import { lstatSync, readdirSync, readlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { coralStateRoot } from '../hook-utils.mjs';
import { isMissing } from './artifacts.mjs';
import { isLegacyWorkingTreeStagingPath } from './result.mjs';

const LEGACY_WORKING_TREE_STAGING_MAX_AGE_MS = 30_000;

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
