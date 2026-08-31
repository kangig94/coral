import { isAbsolute, sep } from 'node:path';

const ARTIFACT_KEYS = [
  'arenaSweep',
  'legacySweep',
  'exclude',
  'symlink',
  'scopedIgnoreRetraction',
  'rootIgnoreRetraction',
];
const SELECTOR_KEYS = [
  'legacySweep',
  'exclude',
  'symlink',
  'scopedIgnoreRetraction',
  'rootIgnoreRetraction',
];
const REASONS = new Set([
  'project-context-unresolvable',
  'project-path-unrepresentable',
  'exclude-path-unresolvable',
  'artifact-unreadable',
  'artifact-too-large',
  'artifact-changed',
  'claude-directory-missing',
  'claude-directory-invalid',
  'repository-arena-unavailable',
  'staging-device-mismatch',
  'publish-cross-device',
  'publish-failed',
  'staging-cleanup-failed',
  'symlink-conflict',
  'legacy-sweep-failed',
  'arena-sweep-failed',
  'upstream-refusal',
]);
const LEGACY_TEMP_NAME = /^(?:\.gitignore|coral)\.coral-[1-9]\d*-[1-9]\d*\.tmp$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, required) {
  const keys = Object.keys(value);
  const allowed = new Set(required);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function hasReason(value, expected) {
  return typeof value.reason === 'string' && REASONS.has(value.reason) && (!expected || value.reason === expected);
}

function validateSweep(value, legacy) {
  if (!isRecord(value) || !['unchanged', 'cleaned', 'refused', 'skipped'].includes(value.state)) return false;
  if (value.state === 'cleaned') {
    return legacy
      ? hasExactKeys(value, ['state', 'count']) && Number.isSafeInteger(value.count) && value.count > 0
      : hasExactKeys(value, ['state']);
  }
  if (value.state === 'refused') {
    if (legacy) {
      return (
        hasExactKeys(value, ['state', 'reason', 'path', 'count']) &&
        hasReason(value, 'legacy-sweep-failed') &&
        isLegacyWorkingTreeStagingPath(value.path) &&
        Number.isSafeInteger(value.count) &&
        value.count >= 0
      );
    }
    return hasExactKeys(value, ['state', 'reason']) && hasReason(value, 'arena-sweep-failed');
  }
  if (value.state === 'skipped') {
    return hasExactKeys(value, ['state', 'reason']) && hasReason(value, 'upstream-refusal');
  }
  return hasExactKeys(value, ['state']);
}

function validateReplacement(value, states) {
  if (!isRecord(value) || !states.includes(value.state) || !['none', 'owned-staging'].includes(value.residue)) {
    return false;
  }
  if (value.residue === 'owned-staging') {
    if (value.state === 'published') {
      return hasExactKeys(value, ['state', 'reason', 'residue']) && hasReason(value, 'staging-cleanup-failed');
    }
    return (
      value.state === 'refused' &&
      hasExactKeys(value, ['state', 'reason', 'residue']) &&
      hasReason(value) &&
      !['upstream-refusal', 'staging-cleanup-failed', 'legacy-sweep-failed', 'arena-sweep-failed'].includes(
        value.reason,
      )
    );
  }
  if (value.state === 'refused') {
    return (
      hasExactKeys(value, ['state', 'reason', 'residue']) &&
      hasReason(value) &&
      !['upstream-refusal', 'staging-cleanup-failed', 'legacy-sweep-failed', 'arena-sweep-failed'].includes(
        value.reason,
      )
    );
  }
  if (value.state === 'skipped') {
    return hasExactKeys(value, ['state', 'reason', 'residue']) && hasReason(value, 'upstream-refusal');
  }
  return hasExactKeys(value, ['state', 'residue']);
}

function validateSymlink(value) {
  if (
    !isRecord(value) ||
    !['not-requested', 'unchanged', 'created', 'repointed', 'refused', 'skipped'].includes(value.state)
  ) {
    return false;
  }
  if (value.residue !== undefined && !['none', 'owned-staging'].includes(value.residue)) return false;
  if (value.residue === 'owned-staging') {
    if (value.state === 'repointed') {
      return hasExactKeys(value, ['state', 'reason', 'residue']) && hasReason(value, 'staging-cleanup-failed');
    }
    return (
      value.state === 'refused' &&
      hasExactKeys(value, ['state', 'reason', 'residue']) &&
      hasReason(value) &&
      !['upstream-refusal', 'staging-cleanup-failed', 'legacy-sweep-failed', 'arena-sweep-failed'].includes(
        value.reason,
      )
    );
  }
  if (value.state === 'repointed') return hasExactKeys(value, ['state', 'residue']);
  if (value.state === 'refused') {
    return (
      (hasExactKeys(value, ['state', 'reason']) || hasExactKeys(value, ['state', 'reason', 'residue'])) &&
      (value.residue === undefined || value.residue === 'none') &&
      hasReason(value) &&
      !['upstream-refusal', 'staging-cleanup-failed', 'legacy-sweep-failed', 'arena-sweep-failed'].includes(
        value.reason,
      )
    );
  }
  if (value.state === 'skipped') {
    return hasExactKeys(value, ['state', 'reason']) && hasReason(value, 'upstream-refusal');
  }
  return hasExactKeys(value, ['state']);
}

export function isLegacyWorkingTreeStagingPath(path) {
  if (typeof path !== 'string' || path.length === 0 || Buffer.byteLength(path, 'utf-8') > 4096) return false;
  if (isAbsolute(path)) return false;
  const segments = path.split(sep);
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false;

  const name = segments.at(-1);
  if (!LEGACY_TEMP_NAME.test(name)) return false;
  if (segments.length === 1) return name.startsWith('.gitignore.');
  return segments.at(-2) === '.claude';
}

export function projectIgnoreStatus(artifacts) {
  const selected = SELECTOR_KEYS.map((key) => artifacts[key]);
  const hasFailure = selected.some(
    (artifact) =>
      artifact.state === 'refused' ||
      (artifact.state === 'skipped' && artifact.reason === 'upstream-refusal') ||
      artifact.residue === 'owned-staging',
  );
  const hasProgress = selected.some(
    (artifact) =>
      ['cleaned', 'published', 'created', 'repointed'].includes(artifact.state) ||
      artifact.residue === 'owned-staging' ||
      (artifact.state === 'refused' && Number.isSafeInteger(artifact.count) && artifact.count > 0),
  );
  if (!hasFailure) return 'complete';
  return hasProgress ? 'partial' : 'refused';
}

export function projectIgnoreResult(artifacts) {
  return { status: projectIgnoreStatus(artifacts), artifacts };
}

export function isProjectIgnoreResult(value) {
  if (!isRecord(value) || !hasExactKeys(value, ['status', 'artifacts'])) return false;
  if (!['complete', 'refused', 'partial'].includes(value.status)) return false;
  const artifacts = value.artifacts;
  if (!isRecord(artifacts) || !hasExactKeys(artifacts, ARTIFACT_KEYS)) return false;
  if (!validateSweep(artifacts.arenaSweep, false) || !validateSweep(artifacts.legacySweep, true)) return false;
  if (!validateReplacement(artifacts.exclude, ['unchanged', 'published', 'refused', 'skipped'])) return false;
  if (!validateSymlink(artifacts.symlink)) return false;
  if (
    !validateReplacement(artifacts.scopedIgnoreRetraction, [
      'not-needed',
      'unchanged',
      'published',
      'refused',
      'skipped',
    ]) ||
    !validateReplacement(artifacts.rootIgnoreRetraction, [
      'not-needed',
      'unchanged',
      'published',
      'refused',
      'skipped',
    ])
  ) {
    return false;
  }
  return value.status === projectIgnoreStatus(artifacts);
}
