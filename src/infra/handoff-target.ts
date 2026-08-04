import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  hashStableAdjacentBundle,
  readBoundedAdjacentManifest,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from './bundle-manifest.js';

declare const validatedHandoffTargetBrand: unique symbol;

export type TargetCandidateEvidence = Readonly<{
  bundleDir: string;
  expectedManifest: StrictBundleManifest;
}>;

export type InvalidTargetFailure =
  | 'bundle-dir-not-canonical'
  | 'bundle-dir-unavailable'
  | 'expected-manifest-invalid'
  | 'adjacent-manifest-unavailable'
  | 'adjacent-manifest-invalid'
  | 'adjacent-manifest-mismatch'
  | 'adjacent-bundle-mismatch';

export type InvalidTargetEvidence = Readonly<{
  bundleDir: string;
  expectedManifest: StrictBundleManifest | null;
  failure: InvalidTargetFailure;
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

type VerifiedBundleHashes = Readonly<{
  bundleHash: string;
  cliBundleHash: string;
  claudeAppserverBundleHash: string;
}>;

type ValidatedTargetState = {
  readonly evidence: TargetCandidateEvidence;
  readonly verifiedHashes: VerifiedBundleHashes;
};

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

// Derived from the schema rather than hand-listed: "every manifest and hash field must equal the expected
// foreign identity" has to keep holding when a field is added, and a hand-written list would weaken silently.
const STRICT_MANIFEST_FIELDS = Object.keys(strictBundleManifestSchema.shape) as ReadonlyArray<
  keyof StrictBundleManifest
>;

function manifestsMatch(left: StrictBundleManifest, right: StrictBundleManifest): boolean {
  return STRICT_MANIFEST_FIELDS.every((field) => left[field] === right[field]);
}

function validateAdjacentTarget(
  evidence: TargetCandidateEvidence,
):
  | { readonly ok: true; readonly verifiedHashes: VerifiedBundleHashes }
  | { readonly ok: false; readonly failure: InvalidTargetFailure } {
  const adjacent = readBoundedAdjacentManifest(evidence.bundleDir);
  if (!adjacent.ok) {
    return {
      ok: false,
      failure: adjacent.reason === 'invalid' ? 'adjacent-manifest-invalid' : 'adjacent-manifest-unavailable',
    };
  }

  const parsed = strictBundleManifestSchema.safeParse(adjacent.value);
  if (!parsed.success) {
    return { ok: false, failure: 'adjacent-manifest-invalid' };
  }
  if (!manifestsMatch(parsed.data, evidence.expectedManifest)) {
    return { ok: false, failure: 'adjacent-manifest-mismatch' };
  }

  const bundleHash = hashStableAdjacentBundle(evidence.bundleDir, 'coral-backend.cjs');
  const cliBundleHash = hashStableAdjacentBundle(evidence.bundleDir, 'coral-cli.cjs');
  const claudeAppserverBundleHash = hashStableAdjacentBundle(evidence.bundleDir, 'coral-claude-appserver.cjs');
  if (
    bundleHash === null ||
    cliBundleHash === null ||
    claudeAppserverBundleHash === null ||
    bundleHash !== evidence.expectedManifest.bundleHash ||
    cliBundleHash !== evidence.expectedManifest.cliBundleHash ||
    claudeAppserverBundleHash !== evidence.expectedManifest.claudeAppserverBundleHash
  ) {
    return { ok: false, failure: 'adjacent-bundle-mismatch' };
  }
  const verifiedHashes = Object.freeze({ bundleHash, cliBundleHash, claudeAppserverBundleHash });
  return { ok: true, verifiedHashes };
}

function sameVerifiedHashes(left: VerifiedBundleHashes, right: VerifiedBundleHashes): boolean {
  return (
    left.bundleHash === right.bundleHash &&
    left.cliBundleHash === right.cliBundleHash &&
    left.claudeAppserverBundleHash === right.claudeAppserverBundleHash
  );
}

function sealValidatedTarget(
  evidence: TargetCandidateEvidence,
  verifiedHashes: VerifiedBundleHashes,
): ValidatedHandoffTarget {
  const target = Object.freeze(Object.create(null)) as ValidatedHandoffTarget;
  validatedTargets.set(target, { evidence, verifiedHashes });
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

    const evidence = copyCandidate(canonical.bundleDir, parsedExpected.data);
    const validation = validateAdjacentTarget(evidence);
    if (!validation.ok) {
      return invalidTarget(evidence.bundleDir, evidence.expectedManifest, validation.failure);
    }
    return { kind: 'validated', target: sealValidatedTarget(evidence, validation.verifiedHashes) };
  };
}

export function withValidatedHandoffTarget(target: ValidatedHandoffTarget): ValidatedTargetExecution {
  const state = validatedTargets.get(target);
  if (state === undefined) {
    throw new Error('Handoff target was not produced by the live foreign-target authority.');
  }

  validatedTargets.delete(target);
  return Object.freeze({
    bundleDir: state.evidence.bundleDir,
    manifest: state.evidence.expectedManifest,
    assertExecutable: () => {
      const validation = validateAdjacentTarget(state.evidence);
      if (!validation.ok || !sameVerifiedHashes(validation.verifiedHashes, state.verifiedHashes)) {
        throw new Error('Validated handoff target bytes changed before execution.');
      }
    },
  });
}
