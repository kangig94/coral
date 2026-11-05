import { lstatSync, realpathSync } from 'node:fs';
import { CLI_BUNDLE_FILE } from './bundle-manifest-address.js';
import { isAbsolute, join, resolve } from 'node:path';

import {
  hashStableAdjacentBundle,
  observeAdjacentManifest,
  observeStableAdjacentBundle,
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

export type ForeignTargetObservation =
  | ForeignTargetValidationResult
  | { readonly kind: 'unobservable'; readonly evidence: InvalidTargetEvidence };

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
  durableWrapperBundleHash: string;
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

function rejectedTarget(
  kind: 'invalid' | 'unobservable',
  bundleDir: string,
  expectedManifest: StrictBundleManifest | null,
  failure: InvalidTargetFailure,
): ForeignTargetObservation {
  return {
    kind,
    evidence: Object.freeze({
      bundleDir,
      expectedManifest: expectedManifest === null ? null : copyManifest(expectedManifest),
      failure,
    }),
  };
}

function resolveCanonicalBundleDir(bundleDir: string):
  | { readonly ok: true; readonly bundleDir: string }
  | {
      readonly ok: false;
      readonly kind: 'invalid' | 'unobservable';
      readonly failure: 'bundle-dir-not-canonical' | 'bundle-dir-unavailable';
    } {
  if (!isAbsolute(bundleDir) || resolve(bundleDir) !== bundleDir) {
    return { ok: false, kind: 'invalid', failure: 'bundle-dir-not-canonical' };
  }

  try {
    const stat = lstatSync(bundleDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, kind: 'invalid', failure: 'bundle-dir-not-canonical' };
    }
    const canonical = realpathSync(bundleDir);
    return canonical === bundleDir
      ? { ok: true, bundleDir: canonical }
      : { ok: false, kind: 'invalid', failure: 'bundle-dir-not-canonical' };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'invalid' : 'unobservable',
      failure: 'bundle-dir-unavailable',
    };
  }
}

// Derived from the schema rather than hand-listed: "every manifest and hash field must equal the expected
// foreign identity" has to keep holding when a field is added, and a hand-written list would weaken silently.
export const STRICT_MANIFEST_FIELDS = Object.keys(strictBundleManifestSchema.shape) as ReadonlyArray<
  keyof StrictBundleManifest
>;

export function supervisorExecutableReady(pluginRoot: string): boolean {
  const bridge = join(pluginRoot, 'bridge');
  return (
    hashStableAdjacentBundle(bridge, 'coral-sentinel.cjs') !== null &&
    hashStableAdjacentBundle(bridge, 'coral-backend.cjs') !== null
  );
}

export function manifestsMatch(left: StrictBundleManifest, right: StrictBundleManifest): boolean {
  return STRICT_MANIFEST_FIELDS.every((field) => left[field] === right[field]);
}

function validateAdjacentTarget(
  evidence: TargetCandidateEvidence,
):
  | { readonly ok: true; readonly verifiedHashes: VerifiedBundleHashes }
  | { readonly ok: false; readonly kind: 'invalid' | 'unobservable'; readonly failure: InvalidTargetFailure } {
  const adjacent = observeAdjacentManifest(evidence.bundleDir);
  if (!adjacent.ok) {
    return {
      ok: false,
      kind: adjacent.reason === 'unavailable' ? 'unobservable' : 'invalid',
      failure: adjacent.reason === 'invalid' ? 'adjacent-manifest-invalid' : 'adjacent-manifest-unavailable',
    };
  }

  const parsed = strictBundleManifestSchema.safeParse(adjacent.value);
  if (!parsed.success) {
    return { ok: false, kind: 'invalid', failure: 'adjacent-manifest-invalid' };
  }
  if (!manifestsMatch(parsed.data, evidence.expectedManifest)) {
    return { ok: false, kind: 'invalid', failure: 'adjacent-manifest-mismatch' };
  }

  const bundleHash = validateAdjacentBundle(
    evidence.bundleDir,
    'coral-backend.cjs',
    evidence.expectedManifest.bundleHash,
  );
  if (!bundleHash.ok) return bundleHash;
  const cliBundleHash = validateAdjacentBundle(
    evidence.bundleDir,
    CLI_BUNDLE_FILE,
    evidence.expectedManifest.cliBundleHash,
  );
  if (!cliBundleHash.ok) return cliBundleHash;
  const claudeAppserverBundleHash = validateAdjacentBundle(
    evidence.bundleDir,
    'coral-claude-appserver.cjs',
    evidence.expectedManifest.claudeAppserverBundleHash,
  );
  if (!claudeAppserverBundleHash.ok) return claudeAppserverBundleHash;
  const durableWrapperBundleHash = validateAdjacentBundle(
    evidence.bundleDir,
    'coral-durable-wrapper.cjs',
    evidence.expectedManifest.durableWrapperBundleHash,
  );
  if (!durableWrapperBundleHash.ok) return durableWrapperBundleHash;
  return {
    ok: true,
    verifiedHashes: Object.freeze({
      bundleHash: bundleHash.hash,
      cliBundleHash: cliBundleHash.hash,
      claudeAppserverBundleHash: claudeAppserverBundleHash.hash,
      durableWrapperBundleHash: durableWrapperBundleHash.hash,
    }),
  };
}

function validateAdjacentBundle(
  bundleDir: string,
  file: string,
  expectedHash: string,
): { ok: true; hash: string } | { ok: false; kind: 'invalid' | 'unobservable'; failure: InvalidTargetFailure } {
  const observation = observeStableAdjacentBundle(bundleDir, file);
  if (observation.kind !== 'hashed')
    return {
      ok: false,
      kind: observation.kind === 'unobservable' ? 'unobservable' : 'invalid',
      failure: 'adjacent-bundle-mismatch',
    };
  if (observation.hash !== expectedHash) return { ok: false, kind: 'invalid', failure: 'adjacent-bundle-mismatch' };
  return { ok: true, hash: observation.hash };
}

function sameVerifiedHashes(left: VerifiedBundleHashes, right: VerifiedBundleHashes): boolean {
  return (
    left.bundleHash === right.bundleHash &&
    left.cliBundleHash === right.cliBundleHash &&
    left.claudeAppserverBundleHash === right.claudeAppserverBundleHash &&
    left.durableWrapperBundleHash === right.durableWrapperBundleHash
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

export function createForeignTargetObserver(): (
  bundleDir: string,
  expectedManifest: StrictBundleManifest,
) => ForeignTargetObservation {
  return (bundleDir, expectedManifest) => {
    const parsedExpected = strictBundleManifestSchema.safeParse(expectedManifest);
    if (!parsedExpected.success) {
      return rejectedTarget('invalid', bundleDir, null, 'expected-manifest-invalid');
    }

    const canonical = resolveCanonicalBundleDir(bundleDir);
    if (!canonical.ok) {
      return rejectedTarget(canonical.kind, bundleDir, parsedExpected.data, canonical.failure);
    }

    const evidence = copyCandidate(canonical.bundleDir, parsedExpected.data);
    const validation = validateAdjacentTarget(evidence);
    if (!validation.ok) {
      return rejectedTarget(validation.kind, evidence.bundleDir, evidence.expectedManifest, validation.failure);
    }
    return { kind: 'validated', target: sealValidatedTarget(evidence, validation.verifiedHashes) };
  };
}

export function createForeignTargetValidator(): ForeignTargetValidator {
  const observe = createForeignTargetObserver();
  return (bundleDir, expectedManifest) => {
    const observation = observe(bundleDir, expectedManifest);
    return observation.kind === 'unobservable' ? { kind: 'invalid', evidence: observation.evidence } : observation;
  };
}

export function inspectValidatedHandoffTarget(target: ValidatedHandoffTarget): Readonly<{
  build: Readonly<Pick<StrictBundleManifest, 'version' | 'buildSetId' | 'bundleHash' | 'flavor'>>;
}> {
  const state = validatedTargets.get(target);
  if (state === undefined) {
    throw new Error('Handoff target was not produced by the live foreign-target authority.');
  }

  const { version, buildSetId, bundleHash, flavor } = state.evidence.expectedManifest;
  return Object.freeze({ build: Object.freeze({ version, buildSetId, bundleHash, flavor }) });
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
