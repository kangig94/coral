import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  hashStableAdjacentBundle,
  readBoundedAdjacentManifest,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from './bundle-manifest.js';
import { acquireDirectoryLockSync, type DirectoryLockLease } from './fs-lock.js';

const TARGET_EXECUTION_LOCK_SUFFIX = '.coral-target-execution.lock';

declare const targetExecutionLeaseBrand: unique symbol;
declare const validatedHandoffTargetBrand: unique symbol;

export type TargetCandidateEvidence = Readonly<{
  bundleDir: string;
  expectedManifest: StrictBundleManifest;
}>;

export type InvalidTargetFailure =
  | 'bundle-dir-not-canonical'
  | 'bundle-dir-unavailable'
  | 'expected-manifest-invalid'
  | 'target-lease-unavailable'
  | 'adjacent-manifest-unavailable'
  | 'adjacent-manifest-invalid'
  | 'adjacent-manifest-mismatch'
  | 'adjacent-bundle-mismatch';

export type InvalidTargetEvidence = Readonly<{
  bundleDir: string;
  expectedManifest: StrictBundleManifest | null;
  failure: InvalidTargetFailure;
}>;

export type TargetExecutionLease = Readonly<{
  [targetExecutionLeaseBrand]: true;
}>;

export type ValidatedHandoffTarget = Readonly<{
  [validatedHandoffTargetBrand]: true;
}>;

export type ForeignTargetValidationResult =
  | { readonly kind: 'validated'; readonly target: ValidatedHandoffTarget }
  | { readonly kind: 'invalid'; readonly evidence: InvalidTargetEvidence };

export type ForeignTargetValidator = (
  bundleDir: string,
  expectedManifest: StrictBundleManifest,
) => ForeignTargetValidationResult;

export type ValidatedTargetExecution = Readonly<{
  bundleDir: string;
  manifest: StrictBundleManifest;
  assertExecutable(): void;
}>;

type ExecutionLeaseState = {
  readonly bundleDir: string;
  readonly directoryLease: DirectoryLockLease;
  released: boolean;
};

type ValidatedTargetState = {
  readonly evidence: TargetCandidateEvidence;
  readonly lease: TargetExecutionLease;
  state: 'available' | 'in-use' | 'released';
};

const executionLeases = new WeakMap<TargetExecutionLease, ExecutionLeaseState>();
const validatedTargets = new WeakMap<ValidatedHandoffTarget, ValidatedTargetState>();

function copyManifest(manifest: StrictBundleManifest): StrictBundleManifest {
  return Object.freeze({ ...manifest });
}

function copyCandidate(bundleDir: string, manifest: StrictBundleManifest): TargetCandidateEvidence {
  return Object.freeze({ bundleDir, expectedManifest: copyManifest(manifest) });
}

function invalidTarget(
  bundleDir: string,
  expectedManifest: StrictBundleManifest | null,
  failure: InvalidTargetFailure,
): ForeignTargetValidationResult {
  return {
    kind: 'invalid',
    evidence: Object.freeze({
      bundleDir,
      expectedManifest: expectedManifest === null ? null : copyManifest(expectedManifest),
      failure,
    }),
  };
}

function resolveCanonicalBundleDir(
  bundleDir: string,
):
  | { readonly ok: true; readonly bundleDir: string }
  | { readonly ok: false; readonly failure: 'bundle-dir-not-canonical' | 'bundle-dir-unavailable' } {
  if (!isAbsolute(bundleDir) || resolve(bundleDir) !== bundleDir) {
    return { ok: false, failure: 'bundle-dir-not-canonical' };
  }

  try {
    const stat = lstatSync(bundleDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, failure: 'bundle-dir-not-canonical' };
    }
    const canonical = realpathSync(bundleDir);
    return canonical === bundleDir
      ? { ok: true, bundleDir: canonical }
      : { ok: false, failure: 'bundle-dir-not-canonical' };
  } catch {
    return { ok: false, failure: 'bundle-dir-unavailable' };
  }
}

function executionLockPath(bundleDir: string): string {
  // The adjacent lease coordinates Coral writers only. Node still executes by
  // path, so a non-Coral same-uid writer remains outside this lock boundary.
  return join(dirname(bundleDir), `.${basename(bundleDir)}${TARGET_EXECUTION_LOCK_SUFFIX}`);
}

function acquireTargetExecutionLease(bundleDir: string): TargetExecutionLease {
  const directoryLease = acquireDirectoryLockSync(executionLockPath(bundleDir));
  const lease = Object.freeze(Object.create(null)) as TargetExecutionLease;
  executionLeases.set(lease, { bundleDir, directoryLease, released: false });
  return lease;
}

function assertLeaseOwned(lease: TargetExecutionLease, expectedBundleDir: string): void {
  const state = executionLeases.get(lease);
  if (state === undefined || state.released || state.bundleDir !== expectedBundleDir) {
    throw new Error('Validated handoff target execution lease is not live.');
  }
  state.directoryLease.assertOwned();
}

function releaseLease(lease: TargetExecutionLease): void {
  const state = executionLeases.get(lease);
  if (state === undefined || state.released) {
    return;
  }
  state.released = true;
  state.directoryLease();
  executionLeases.delete(lease);
}

// Derived from the schema rather than hand-listed: "every manifest and hash field must equal the expected
// foreign identity" has to keep holding when a field is added, and a hand-written list would weaken silently.
const STRICT_MANIFEST_FIELDS = Object.keys(strictBundleManifestSchema.shape) as ReadonlyArray<
  keyof StrictBundleManifest
>;

function manifestsMatch(left: StrictBundleManifest, right: StrictBundleManifest): boolean {
  return STRICT_MANIFEST_FIELDS.every((field) => left[field] === right[field]);
}

function validateAdjacentTarget(evidence: TargetCandidateEvidence): InvalidTargetFailure | null {
  const adjacent = readBoundedAdjacentManifest(evidence.bundleDir);
  if (!adjacent.ok) {
    return adjacent.reason === 'invalid' ? 'adjacent-manifest-invalid' : 'adjacent-manifest-unavailable';
  }

  const parsed = strictBundleManifestSchema.safeParse(adjacent.value);
  if (!parsed.success) {
    return 'adjacent-manifest-invalid';
  }
  if (!manifestsMatch(parsed.data, evidence.expectedManifest)) {
    return 'adjacent-manifest-mismatch';
  }

  const backendHash = hashStableAdjacentBundle(evidence.bundleDir, 'coral-backend.cjs');
  const cliHash = hashStableAdjacentBundle(evidence.bundleDir, 'coral-cli.cjs');
  const claudeAppserverHash = hashStableAdjacentBundle(evidence.bundleDir, 'coral-claude-appserver.cjs');
  return backendHash === evidence.expectedManifest.bundleHash &&
    cliHash === evidence.expectedManifest.cliBundleHash &&
    claudeAppserverHash === evidence.expectedManifest.claudeAppserverBundleHash
    ? null
    : 'adjacent-bundle-mismatch';
}

function sealValidatedTarget(evidence: TargetCandidateEvidence, lease: TargetExecutionLease): ValidatedHandoffTarget {
  const target = Object.freeze(Object.create(null)) as ValidatedHandoffTarget;
  validatedTargets.set(target, { evidence, lease, state: 'available' });
  return target;
}

export function createForeignTargetValidator(): ForeignTargetValidator {
  return (bundleDir, expectedManifest) => {
    const parsedExpected = strictBundleManifestSchema.safeParse(expectedManifest);
    if (!parsedExpected.success) {
      return invalidTarget(bundleDir, null, 'expected-manifest-invalid');
    }

    const canonical = resolveCanonicalBundleDir(bundleDir);
    if (!canonical.ok) {
      return invalidTarget(bundleDir, parsedExpected.data, canonical.failure);
    }

    let lease: TargetExecutionLease;
    try {
      lease = acquireTargetExecutionLease(canonical.bundleDir);
    } catch {
      return invalidTarget(canonical.bundleDir, parsedExpected.data, 'target-lease-unavailable');
    }

    const evidence = copyCandidate(canonical.bundleDir, parsedExpected.data);
    const failure = validateAdjacentTarget(evidence);
    if (failure !== null) {
      releaseLease(lease);
      return invalidTarget(evidence.bundleDir, evidence.expectedManifest, failure);
    }
    return { kind: 'validated', target: sealValidatedTarget(evidence, lease) };
  };
}

export async function withValidatedHandoffTarget<TResult>(
  target: ValidatedHandoffTarget,
  operation: (execution: ValidatedTargetExecution) => Promise<TResult> | TResult,
): Promise<TResult> {
  const state = validatedTargets.get(target);
  if (state === undefined || state.state !== 'available') {
    throw new Error('Handoff target was not produced by the live foreign-target authority.');
  }

  assertLeaseOwned(state.lease, state.evidence.bundleDir);
  state.state = 'in-use';
  const execution = Object.freeze({
    bundleDir: state.evidence.bundleDir,
    manifest: state.evidence.expectedManifest,
    assertExecutable: () => {
      assertLeaseOwned(state.lease, state.evidence.bundleDir);
      if (validateAdjacentTarget(state.evidence) !== null) {
        throw new Error('Validated handoff target bytes changed before execution.');
      }
    },
  });

  try {
    return await operation(execution);
  } finally {
    state.state = 'released';
    releaseLease(state.lease);
    validatedTargets.delete(target);
  }
}
