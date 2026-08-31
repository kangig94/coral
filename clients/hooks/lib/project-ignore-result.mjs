import { isAbsolute, sep } from 'node:path';

const ARTIFACT_KEYS = [
  'arenaSweep',
  'durabilityReconciliation',
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
const DURABILITY_RECONCILIATION_REASONS = new Set([
  'durability-evidence-unavailable',
  'durability-evidence-unreadable',
  'durability-evidence-quarantined',
  'durability-evidence-cleanup-failed',
  'durability-sync-unsupported-discharged',
  'durability-sync-failed',
]);
const DURABILITY_REASONS = [
  'durability-sync-unsupported',
  'durability-sync-failed',
  'durability-evidence-cleanup-failed',
];
const REPLACEMENT_REFUSAL_REASONS = [
  'artifact-unreadable',
  'artifact-too-large',
  'artifact-changed',
  'artifact-observation-failed',
  'staging-device-mismatch',
  'publish-cross-device',
  'publish-failed',
  'durability-evidence-unavailable',
];
const REPOSITORY_ARENA_REFUSAL_REASONS = [
  'repository-arena-unavailable',
  'repository-arena-conflict',
];
const REPOSITORY_ARENA_COMPONENTS = new Set(['coral', 'staging', 'project-ignore']);
export const PROJECT_IGNORE_REFUSAL_REASONS = Object.freeze({
  arenaSweep: Object.freeze(['arena-sweep-failed', 'arena-structural-conflict']),
  durabilityReconciliation: Object.freeze([...DURABILITY_RECONCILIATION_REASONS]),
  legacySweep: Object.freeze(['legacy-sweep-failed', 'legacy-sweep-observation-failed']),
  exclude: Object.freeze([
    'project-path-unrepresentable',
    'exclude-path-unresolvable',
    ...REPOSITORY_ARENA_REFUSAL_REASONS,
    ...REPLACEMENT_REFUSAL_REASONS,
  ]),
  symlink: Object.freeze([
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
    ...REPOSITORY_ARENA_REFUSAL_REASONS,
  ]),
  scopedIgnoreRetraction: Object.freeze([
    ...REPOSITORY_ARENA_REFUSAL_REASONS,
    ...REPLACEMENT_REFUSAL_REASONS,
  ]),
  rootIgnoreRetraction: Object.freeze([
    ...REPOSITORY_ARENA_REFUSAL_REASONS,
    ...REPLACEMENT_REFUSAL_REASONS,
  ]),
});
const SPECIAL_REASONS = ['staging-cleanup-failed', 'upstream-refusal'];
export const PROJECT_IGNORE_REASONS = Object.freeze([
  ...new Set([
    ...Object.values(PROJECT_IGNORE_REFUSAL_REASONS).flat(),
    ...DURABILITY_REASONS,
    ...SPECIAL_REASONS,
  ]),
]);
const REASONS = new Set(PROJECT_IGNORE_REASONS);
const REFUSAL_REASON_SETS = Object.fromEntries(
  Object.entries(PROJECT_IGNORE_REFUSAL_REASONS).map(([artifact, reasons]) => [
    artifact,
    new Set(reasons),
  ]),
);
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
  return (
    typeof value.reason === 'string' &&
    REASONS.has(value.reason) &&
    (!expected || value.reason === expected)
  );
}

function hasRefusalReason(value, artifact) {
  return typeof value.reason === 'string' && REFUSAL_REASON_SETS[artifact].has(value.reason);
}

function refusalComponentKeys(value) {
  if (value.reason !== 'repository-arena-conflict') {
    return Object.hasOwn(value, 'component') ? null : [];
  }
  return REPOSITORY_ARENA_COMPONENTS.has(value.component) ? ['component'] : null;
}

function validateDurability(value) {
  if (!isRecord(value) || !['synced', 'unsupported', 'failed'].includes(value.state)) return false;
  if (!hasExactKeys(value, ['state', 'reasons']) || !Array.isArray(value.reasons)) return false;
  if (
    !value.reasons.every(
      (reason, index) =>
        DURABILITY_REASONS.includes(reason) &&
        (index === 0 || value.reasons[index - 1] < reason),
    )
  ) {
    return false;
  }
  if (value.state === 'synced') return value.reasons.length === 0;
  if (value.state === 'unsupported') {
    return value.reasons.length === 1 && value.reasons[0] === 'durability-sync-unsupported';
  }
  return value.reasons.some((reason) =>
    ['durability-sync-failed', 'durability-evidence-cleanup-failed'].includes(reason),
  );
}

function validateDurabilityReconciliation(value) {
  if (!isRecord(value) || !['reconciled', 'refused'].includes(value.state)) return false;
  if (value.state === 'reconciled') return hasExactKeys(value, ['state']);
  if (!hasExactKeys(value, ['state', 'reasons']) || !Array.isArray(value.reasons)) return false;
  return (
    value.reasons.length > 0 &&
    value.reasons.every(
      (reason, index) =>
        DURABILITY_RECONCILIATION_REASONS.has(reason) &&
        (index === 0 || value.reasons[index - 1] < reason),
    )
  );
}

function validateSweep(value, artifact) {
  const legacy = artifact === 'legacySweep';
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
        hasRefusalReason(value, artifact) &&
        (value.reason === 'legacy-sweep-failed'
          ? isLegacyWorkingTreeStagingPath(value.path)
          : isLegacyWorkingTreeObservationPath(value.path)) &&
        Number.isSafeInteger(value.count) &&
        value.count >= 0
      );
    }
    return (
      hasExactKeys(value, ['state', 'reason']) &&
      hasRefusalReason(value, artifact)
    );
  }
  if (value.state === 'skipped') {
    return hasExactKeys(value, ['state', 'reason']) && hasReason(value, 'upstream-refusal');
  }
  return hasExactKeys(value, ['state']);
}

function validateReplacement(value, states, artifact) {
  if (!isRecord(value) || !states.includes(value.state) || !['none', 'owned-staging'].includes(value.residue)) {
    return false;
  }
  const hasDurability = Object.hasOwn(value, 'durability');
  if (hasDurability && !validateDurability(value.durability)) return false;
  if (value.state === 'refused') {
    const componentKeys = refusalComponentKeys(value);
    if (!componentKeys) return false;
    return (
      hasExactKeys(value, [
        'state',
        'reason',
        'residue',
        ...componentKeys,
        ...(hasDurability ? ['durability'] : []),
      ]) &&
      hasRefusalReason(value, artifact) &&
      (!hasDurability || value.durability.state !== 'synced')
    );
  }
  if (value.residue === 'owned-staging') {
    if (value.state === 'published') {
      return (
        hasDurability &&
        hasExactKeys(value, ['state', 'reason', 'residue', 'durability']) &&
        hasReason(value, 'staging-cleanup-failed')
      );
    }
    return false;
  }
  if (value.state === 'skipped') {
    return hasExactKeys(value, ['state', 'reason', 'residue']) && hasReason(value, 'upstream-refusal');
  }
  if (value.state === 'not-needed') return hasExactKeys(value, ['state', 'residue']);
  if (value.state === 'unchanged' && !hasDurability) {
    return hasExactKeys(value, ['state', 'residue']);
  }
  return hasDurability && hasExactKeys(value, ['state', 'residue', 'durability']);
}

function validateSymlink(value) {
  if (
    !isRecord(value) ||
    !['not-requested', 'unchanged', 'created', 'repointed', 'refused', 'skipped'].includes(value.state)
  ) {
    return false;
  }
  if (value.residue !== undefined && !['none', 'owned-staging'].includes(value.residue)) return false;
  const hasDurability = Object.hasOwn(value, 'durability');
  if (hasDurability && !validateDurability(value.durability)) return false;
  if (value.state === 'refused') {
    const componentKeys = refusalComponentKeys(value);
    if (!componentKeys) return false;
    return (
      hasExactKeys(value, [
        'state',
        'reason',
        ...componentKeys,
        ...(value.residue === undefined ? [] : ['residue']),
        ...(hasDurability ? ['durability'] : []),
      ]) &&
      (!hasDurability || value.durability.state !== 'synced') &&
      hasRefusalReason(value, 'symlink')
    );
  }
  if (value.residue === 'owned-staging') {
    if (value.state === 'repointed') {
      return (
        hasDurability &&
        hasExactKeys(value, ['state', 'reason', 'residue', 'durability']) &&
        hasReason(value, 'staging-cleanup-failed')
      );
    }
    return false;
  }
  if (value.state === 'repointed') {
    return hasDurability && hasExactKeys(value, ['state', 'residue', 'durability']);
  }
  if (value.state === 'skipped') {
    return hasExactKeys(value, ['state', 'reason']) && hasReason(value, 'upstream-refusal');
  }
  if (value.state === 'not-requested') return hasExactKeys(value, ['state']);
  if (value.state === 'unchanged') return !hasDurability && hasExactKeys(value, ['state']);
  return hasDurability && hasExactKeys(value, ['state', 'durability']);
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

function isLegacyWorkingTreeObservationPath(path) {
  if (path === '.' || isLegacyWorkingTreeStagingPath(path)) return true;
  if (typeof path !== 'string' || path.length === 0 || Buffer.byteLength(path, 'utf-8') > 4096) return false;
  if (isAbsolute(path)) return false;
  const segments = path.split(sep);
  return (
    segments.at(-1) === '.claude' &&
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

export function projectIgnoreStatus(artifacts) {
  const selected = SELECTOR_KEYS.map((key) => artifacts[key]);
  const durabilityReconciliationFailed = artifacts.durabilityReconciliation.state === 'refused';
  const hasFailure =
    durabilityReconciliationFailed ||
    selected.some(
      (artifact) =>
        artifact.state === 'refused' ||
        (artifact.state === 'skipped' && artifact.reason === 'upstream-refusal') ||
        artifact.residue === 'owned-staging' ||
        (artifact.durability && artifact.durability.state !== 'synced'),
    );
  // Evidence a refusal left behind is not something the run accomplished: a publication that did not
  // happen may not read as one that partly did.
  const hasProgress = selected.some(
    (artifact) =>
      ['cleaned', 'published', 'created', 'repointed'].includes(artifact.state) ||
      artifact.residue === 'owned-staging' ||
      (artifact.state !== 'refused' && artifact.durability && artifact.durability.state !== 'synced') ||
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
  if (
    !validateSweep(artifacts.arenaSweep, 'arenaSweep') ||
    !validateDurabilityReconciliation(artifacts.durabilityReconciliation) ||
    !validateSweep(artifacts.legacySweep, 'legacySweep')
  ) {
    return false;
  }
  if (
    !validateReplacement(
      artifacts.exclude,
      ['not-needed', 'unchanged', 'published', 'refused', 'skipped'],
      'exclude',
    )
  ) {
    return false;
  }
  if (!validateSymlink(artifacts.symlink)) return false;
  if (
    !validateReplacement(
      artifacts.scopedIgnoreRetraction,
      ['not-needed', 'unchanged', 'published', 'refused', 'skipped'],
      'scopedIgnoreRetraction',
    ) ||
    !validateReplacement(
      artifacts.rootIgnoreRetraction,
      ['not-needed', 'unchanged', 'published', 'refused', 'skipped'],
      'rootIgnoreRetraction',
    )
  ) {
    return false;
  }
  return value.status === projectIgnoreStatus(artifacts);
}
