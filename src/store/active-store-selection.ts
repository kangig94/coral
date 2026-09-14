import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import type { StrictBundleManifest } from '../infra/bundle-manifest.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { manifestsMatch, type InvalidTargetEvidence, type InvalidTargetFailure } from '../infra/handoff-target.js';
import type { StorageBigIntStat, StorageEntryKind, StoragePort } from '../infra/port-types.js';
import type { StorageActuator } from '../infra/storage-actuator.js';
import { compareProductVersions } from '../infra/product-version.js';
import type { Runtime } from '../runtime/ports.js';
import { resolveGenerationBoundaryPaths } from './generation-mutation-coordination.js';

export const ACTIVE_STORE_SELECTION_MAX_BYTES = 16 * 1024;
export const ACTIVE_STORE_TRANSITION_MAX_BYTES = 32 * 1024;
export const ACTIVE_STORE_SELECTION_VERSION = 2 as const;
export const ACTIVE_STORE_TRANSITION_VERSION = 2 as const;

const ACTIVE_STORE_SELECTION_FILE_NAME = `active-store-selection.v${ACTIVE_STORE_SELECTION_VERSION}.json`;
const ACTIVE_STORE_TRANSITION_FILE_NAME = `active-store-transition.v${ACTIVE_STORE_TRANSITION_VERSION}.json`;
const ACTIVE_STORE_SELECTION_V1_FILE_NAME = 'active-store-selection.v1.json';
const ACTIVE_STORE_TRANSITION_V1_FILE_NAME = 'active-store-transition.v1.json';
const PRIVATE_FILE_MODE = 0o600n;
const PERMISSION_BITS = 0o777n;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TRANSITION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const selectionFailureCodes = [
  'selection_too_large',
  'selection_invalid_utf8',
  'selection_invalid_json',
  'selection_invalid_schema',
  'selection_bundle_dir_not_canonical',
  'selection_manifest_disagreement',
] as const;

export type ActiveStoreSelectionFailureCode = (typeof selectionFailureCodes)[number];

export const activeStoreSelectionFailureCodeSchema = z.enum(selectionFailureCodes);

export type ActiveStoreTransitionFailureCode =
  | 'transition_too_large'
  | 'transition_invalid_utf8'
  | 'transition_invalid_json'
  | 'transition_invalid_schema';

export type ActiveStoreRecordReadFailureCode =
  | 'coordination_directory_link'
  | 'coordination_directory_not_regular'
  | 'coordination_directory_not_canonical'
  | 'coordination_directory_unavailable'
  | 'record_link'
  | 'record_not_regular'
  | 'record_mode'
  | 'record_changed'
  | 'record_incoherent'
  | 'record_unavailable';

export type ActiveStoreSelection = Readonly<{
  version: typeof ACTIVE_STORE_SELECTION_VERSION;
  manifest: StrictBundleManifest;
  bundleDir: string;
  activeStoreFingerprint: string;
}>;

export type NewerStoreEvidence = Readonly<{
  kind: 'newer-incompatible';
  currentFingerprint: string;
  currentProductVersion: string;
  storedFingerprint: string;
  storedProductVersion: string;
}>;

export type ActiveStoreEvidence = Readonly<{ kind: 'pending-classification' }> | NewerStoreEvidence;

export type ActiveStoreSelectionMalformedEvidence = Readonly<{
  kind: 'selection-malformed';
  selectionByteLength: number;
  selectionSha256: string;
  failureCode: ActiveStoreSelectionFailureCode;
}>;

export type ActiveStoreTransitionEvidence =
  | Readonly<{
      kind: 'valid-target-invalid';
      priorSelection: ActiveStoreSelection;
      invalidTargetEvidence: InvalidTargetEvidence;
      storeEvidence: ActiveStoreEvidence;
    }>
  | Readonly<{
      kind: 'selection-absent';
      storeEvidence: ActiveStoreEvidence;
    }>
  | Readonly<
      ActiveStoreSelectionMalformedEvidence & {
        storeEvidence: ActiveStoreEvidence;
      }
    >
  | Readonly<{
      kind: 'current-selection-newer-store';
      priorSelection: ActiveStoreSelection;
      newerStoreEvidence: NewerStoreEvidence;
    }>;

export type ActiveStoreTransition = Readonly<{
  version: typeof ACTIVE_STORE_TRANSITION_VERSION;
  transitionId: string;
  kind: 'selection-recovery';
  evidence: ActiveStoreTransitionEvidence;
  currentManifest: StrictBundleManifest;
  currentBundleDir: string;
}>;

export type ActiveStoreRecordPaths = Readonly<{
  coordinationRoot: string;
  selectionFile: string;
  transitionFile: string;
  selectionV1File: string;
  transitionV1File: string;
}>;

export type ActiveStoreSelectionReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly selection: ActiveStoreSelection }
  | { readonly kind: 'malformed'; readonly evidence: ActiveStoreSelectionMalformedEvidence }
  | { readonly kind: 'rejected'; readonly failureCode: ActiveStoreRecordReadFailureCode };

export type ActiveStoreSelectionCoordinationReadResult =
  | ActiveStoreSelectionReadResult
  | { readonly kind: 'v1'; readonly selection: ActiveStoreSelectionV1 };

export type ActiveStoreTransitionReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly transition: ActiveStoreTransition }
  | { readonly kind: 'malformed'; readonly failureCode: ActiveStoreTransitionFailureCode }
  | { readonly kind: 'rejected'; readonly failureCode: ActiveStoreRecordReadFailureCode };

export type ActiveStoreTransitionV1ReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'rejected'; readonly failureCode: ActiveStoreRecordReadFailureCode };

export type ActiveStoreSelectionRelation = 'exact' | 'advance' | 'selected-newer';

const activeStoreManifestV1Schema = z
  .object({
    version: z
      .string()
      .max(128)
      .regex(
        /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
      ),
    buildSetId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    bundleHash: z.string().regex(/^[0-9a-f]{16}$/),
    cliBundleHash: z.string().regex(/^[0-9a-f]{16}$/),
    claudeAppserverBundleHash: z.string().regex(/^[0-9a-f]{16}$/),
    flavor: z.enum(['dev', 'prod']),
    storeFormatFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

const activeStoreManifestV2Schema = activeStoreManifestV1Schema
  .extend({ durableWrapperBundleHash: z.string().regex(/^[0-9a-f]{16}$/) })
  .strict();

type ActiveStoreManifestV1 = z.infer<typeof activeStoreManifestV1Schema>;

const activeStoreSelectionV1StructuralSchema = z
  .object({
    version: z.literal(1),
    manifest: activeStoreManifestV1Schema,
    bundleDir: z.string().min(1),
    activeStoreFingerprint: activeStoreManifestV1Schema.shape.storeFormatFingerprint,
  })
  .strict();

const activeStoreSelectionStructuralSchema = z
  .object({
    version: z.literal(ACTIVE_STORE_SELECTION_VERSION),
    manifest: activeStoreManifestV2Schema,
    bundleDir: z.string().min(1),
    activeStoreFingerprint: activeStoreManifestV2Schema.shape.storeFormatFingerprint,
  })
  .strict();

function isLexicallyCanonicalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path;
}

function selectionManifestAgrees(selection: {
  readonly manifest: { readonly storeFormatFingerprint: string };
  readonly activeStoreFingerprint: string;
}): boolean {
  return selection.activeStoreFingerprint === selection.manifest.storeFormatFingerprint;
}

const activeStoreSelectionV1Schema = activeStoreSelectionV1StructuralSchema.superRefine((selection, context) => {
  if (!isLexicallyCanonicalAbsolutePath(selection.bundleDir)) {
    context.addIssue({ code: 'custom', message: 'bundleDir must be canonical' });
  }
  if (!selectionManifestAgrees(selection)) {
    context.addIssue({ code: 'custom', message: 'activeStoreFingerprint must match the manifest' });
  }
});

export const activeStoreSelectionSchema = activeStoreSelectionStructuralSchema.superRefine((selection, context) => {
  if (!isLexicallyCanonicalAbsolutePath(selection.bundleDir)) {
    context.addIssue({ code: 'custom', message: 'bundleDir must be canonical' });
  }
  if (!selectionManifestAgrees(selection)) {
    context.addIssue({ code: 'custom', message: 'activeStoreFingerprint must match the manifest' });
  }
});

const newerStoreEvidenceSchema = z
  .object({
    kind: z.literal('newer-incompatible'),
    currentFingerprint: activeStoreManifestV2Schema.shape.storeFormatFingerprint,
    currentProductVersion: activeStoreManifestV2Schema.shape.version,
    storedFingerprint: activeStoreManifestV2Schema.shape.storeFormatFingerprint,
    storedProductVersion: activeStoreManifestV2Schema.shape.version,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (compareProductVersions(evidence.storedProductVersion, evidence.currentProductVersion) <= 0) {
      context.addIssue({ code: 'custom', message: 'storedProductVersion must be newer than the current build' });
    }
  });

const pendingStoreEvidenceSchema = z.object({ kind: z.literal('pending-classification') }).strict();
const activeStoreEvidenceSchema = z.union([pendingStoreEvidenceSchema, newerStoreEvidenceSchema]);

const invalidTargetFailures = {
  'bundle-dir-not-canonical': 'bundle-dir-not-canonical',
  'bundle-dir-unavailable': 'bundle-dir-unavailable',
  'expected-manifest-invalid': 'expected-manifest-invalid',
  'adjacent-manifest-unavailable': 'adjacent-manifest-unavailable',
  'adjacent-manifest-invalid': 'adjacent-manifest-invalid',
  'adjacent-manifest-mismatch': 'adjacent-manifest-mismatch',
  'adjacent-bundle-mismatch': 'adjacent-bundle-mismatch',
} as const satisfies Record<InvalidTargetFailure, InvalidTargetFailure>;

const invalidTargetFailureValues = Object.values(invalidTargetFailures) as [
  InvalidTargetFailure,
  ...InvalidTargetFailure[],
];

const recoverableInvalidTargetFailureSchema = z
  .enum(invalidTargetFailureValues)
  .refine((failure) => failure !== 'expected-manifest-invalid');

const recoverableInvalidTargetEvidenceSchema = z
  .object({
    bundleDir: z.string().min(1),
    expectedManifest: activeStoreManifestV2Schema,
    failure: recoverableInvalidTargetFailureSchema,
  })
  .strict();

const validTargetInvalidEvidenceSchema = z
  .object({
    kind: z.literal('valid-target-invalid'),
    priorSelection: activeStoreSelectionSchema,
    invalidTargetEvidence: recoverableInvalidTargetEvidenceSchema,
    storeEvidence: activeStoreEvidenceSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      evidence.priorSelection.bundleDir !== evidence.invalidTargetEvidence.bundleDir ||
      !manifestsMatch(evidence.priorSelection.manifest, evidence.invalidTargetEvidence.expectedManifest)
    ) {
      context.addIssue({ code: 'custom', message: 'invalid target evidence must describe the prior selection' });
    }
  });

const selectionAbsentEvidenceSchema = z
  .object({
    kind: z.literal('selection-absent'),
    storeEvidence: activeStoreEvidenceSchema,
  })
  .strict();

const selectionMalformedEvidenceSchema = z
  .object({
    kind: z.literal('selection-malformed'),
    selectionByteLength: z.number().int().min(0).max(ACTIVE_STORE_SELECTION_MAX_BYTES),
    selectionSha256: z.string().regex(SHA256_PATTERN),
    failureCode: activeStoreSelectionFailureCodeSchema,
    storeEvidence: activeStoreEvidenceSchema,
  })
  .strict();

const currentSelectionNewerStoreEvidenceSchema = z
  .object({
    kind: z.literal('current-selection-newer-store'),
    priorSelection: activeStoreSelectionSchema,
    newerStoreEvidence: newerStoreEvidenceSchema,
  })
  .strict();

const activeStoreTransitionEvidenceSchema = z.union([
  validTargetInvalidEvidenceSchema,
  selectionAbsentEvidenceSchema,
  selectionMalformedEvidenceSchema,
  currentSelectionNewerStoreEvidenceSchema,
]);

const activeStoreManifestV1Fields = Object.keys(activeStoreManifestV1Schema.shape) as ReadonlyArray<
  keyof ActiveStoreManifestV1
>;

function activeStoreManifestV1Matches(left: ActiveStoreManifestV1, right: ActiveStoreManifestV1): boolean {
  return activeStoreManifestV1Fields.every((field) => left[field] === right[field]);
}

export function classifyActiveStoreSelection(
  selected: ActiveStoreSelection,
  current: ActiveStoreSelection,
): ActiveStoreSelectionRelation {
  if (
    selected.bundleDir === current.bundleDir &&
    selected.activeStoreFingerprint === current.activeStoreFingerprint &&
    manifestsMatch(selected.manifest, current.manifest)
  ) {
    return 'exact';
  }

  const precedence = compareProductVersions(selected.manifest.version, current.manifest.version);
  // Every non-exact, non-newer precedence (behind or equal) is handled identically: it republishes the
  // current build's own selection. Whether the recorded selection names an older version or the same version
  // under a different build carries no separate consequence today, so both collapse here rather than
  // certifying a distinction no caller observes.
  return precedence > 0 ? 'selected-newer' : 'advance';
}

export function classifyActiveStoreSelectionV1(
  selected: ActiveStoreSelectionV1,
  current: ActiveStoreSelection,
): ActiveStoreSelectionRelation {
  const currentV1 = projectActiveStoreSelectionV1(current);
  if (
    selected.bundleDir === currentV1.bundleDir &&
    selected.activeStoreFingerprint === currentV1.activeStoreFingerprint &&
    activeStoreManifestV1Matches(selected.manifest, currentV1.manifest)
  ) {
    return 'exact';
  }

  return compareProductVersions(selected.manifest.version, current.manifest.version) > 0 ? 'selected-newer' : 'advance';
}

export function resolveActiveStoreSelectionV1(
  selected: ActiveStoreSelectionV1,
  manifest: StrictBundleManifest,
): ActiveStoreSelection | null {
  try {
    const resolved = validateSelectionValue({
      version: ACTIVE_STORE_SELECTION_VERSION,
      manifest,
      bundleDir: selected.bundleDir,
      activeStoreFingerprint: selected.activeStoreFingerprint,
    });
    return classifyActiveStoreSelectionV1(selected, resolved) === 'exact' ? resolved : null;
  } catch {
    return null;
  }
}

function classifiedStoreEvidence(evidence: ActiveStoreTransitionEvidence): NewerStoreEvidence | null {
  if (evidence.kind === 'current-selection-newer-store') return evidence.newerStoreEvidence;
  return evidence.storeEvidence.kind === 'newer-incompatible' ? evidence.storeEvidence : null;
}

export const activeStoreTransitionSchema = z
  .object({
    version: z.literal(ACTIVE_STORE_TRANSITION_VERSION),
    transitionId: z.string().regex(TRANSITION_ID_PATTERN),
    kind: z.literal('selection-recovery'),
    evidence: activeStoreTransitionEvidenceSchema,
    currentManifest: activeStoreManifestV2Schema,
    currentBundleDir: z.string().min(1).refine(isLexicallyCanonicalAbsolutePath),
  })
  .strict()
  .superRefine((transition, context) => {
    const storeEvidence = classifiedStoreEvidence(transition.evidence);
    if (
      storeEvidence !== null &&
      (storeEvidence.currentFingerprint !== transition.currentManifest.storeFormatFingerprint ||
        storeEvidence.currentProductVersion !== transition.currentManifest.version)
    ) {
      context.addIssue({ code: 'custom', message: 'newer store evidence must describe the current manifest' });
    }

    if (
      transition.evidence.kind === 'current-selection-newer-store' &&
      (transition.evidence.priorSelection.bundleDir !== transition.currentBundleDir ||
        !manifestsMatch(transition.evidence.priorSelection.manifest, transition.currentManifest))
    ) {
      context.addIssue({ code: 'custom', message: 'current selection evidence must describe the current build' });
    }
  });

export type ActiveStoreSelectionV1 = z.infer<typeof activeStoreSelectionV1Schema>;

export class ActiveStoreSelectionDecodeError extends Error {
  readonly code: ActiveStoreSelectionFailureCode;

  constructor(code: ActiveStoreSelectionFailureCode) {
    super(code);
    this.name = 'ActiveStoreSelectionDecodeError';
    this.code = code;
  }
}

export class ActiveStoreTransitionDecodeError extends Error {
  readonly code: ActiveStoreTransitionFailureCode;

  constructor(code: ActiveStoreTransitionFailureCode) {
    super(code);
    this.name = 'ActiveStoreTransitionDecodeError';
    this.code = code;
  }
}

/**
 * Carries the specific coordination-directory or record-publish failure across the module boundary so
 * `active-store-selection-coordination.ts` can route it through `refuseActiveStoreCoordination` with the
 * documented `active_store_coordination_invalid` code instead of an unremediated `internal` error.
 */
export class ActiveStoreCoordinationWriteError extends Error {
  readonly code: ActiveStoreRecordReadFailureCode;

  constructor(code: ActiveStoreRecordReadFailureCode, message: string) {
    super(message);
    this.name = 'ActiveStoreCoordinationWriteError';
    this.code = code;
  }
}

export function resolveActiveStoreRecordPaths(runtime: Pick<Runtime, 'paths'>): ActiveStoreRecordPaths {
  const { coordinationRoot } = resolveGenerationBoundaryPaths(runtime);
  return {
    coordinationRoot,
    selectionFile: join(coordinationRoot, ACTIVE_STORE_SELECTION_FILE_NAME),
    transitionFile: join(coordinationRoot, ACTIVE_STORE_TRANSITION_FILE_NAME),
    selectionV1File: join(coordinationRoot, ACTIVE_STORE_SELECTION_V1_FILE_NAME),
    transitionV1File: join(coordinationRoot, ACTIVE_STORE_TRANSITION_V1_FILE_NAME),
  };
}

function parseJson(bytes: Uint8Array, invalidUtf8: () => Error, invalidJson: () => Error): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidUtf8();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidJson();
  }
}

function validateSelectionValue(value: unknown): ActiveStoreSelection {
  const parsed = activeStoreSelectionStructuralSchema.safeParse(value);
  if (!parsed.success) {
    throw new ActiveStoreSelectionDecodeError('selection_invalid_schema');
  }
  if (!selectionManifestAgrees(parsed.data)) {
    throw new ActiveStoreSelectionDecodeError('selection_manifest_disagreement');
  }
  if (!isLexicallyCanonicalAbsolutePath(parsed.data.bundleDir)) {
    throw new ActiveStoreSelectionDecodeError('selection_bundle_dir_not_canonical');
  }
  return parsed.data;
}

function projectActiveStoreManifestV1(manifest: StrictBundleManifest): ActiveStoreManifestV1 {
  return {
    version: manifest.version,
    buildSetId: manifest.buildSetId,
    bundleHash: manifest.bundleHash,
    cliBundleHash: manifest.cliBundleHash,
    claudeAppserverBundleHash: manifest.claudeAppserverBundleHash,
    flavor: manifest.flavor,
    storeFormatFingerprint: manifest.storeFormatFingerprint,
  };
}

function projectActiveStoreSelectionV1(selection: ActiveStoreSelection): ActiveStoreSelectionV1 {
  return {
    version: 1,
    manifest: projectActiveStoreManifestV1(selection.manifest),
    bundleDir: selection.bundleDir,
    activeStoreFingerprint: selection.activeStoreFingerprint,
  };
}

function encodeActiveStoreSelectionV1(selection: ActiveStoreSelection): Uint8Array {
  const parsed = activeStoreSelectionV1Schema.safeParse(
    projectActiveStoreSelectionV1(validateSelectionValue(selection)),
  );
  if (!parsed.success) {
    throw new ActiveStoreSelectionDecodeError('selection_invalid_schema');
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(parsed.data)}\n`);
  if (bytes.byteLength > ACTIVE_STORE_SELECTION_MAX_BYTES) {
    throw new ActiveStoreSelectionDecodeError('selection_too_large');
  }
  return bytes;
}

export function decodeActiveStoreSelection(bytes: Uint8Array): ActiveStoreSelection {
  if (bytes.byteLength > ACTIVE_STORE_SELECTION_MAX_BYTES) {
    throw new ActiveStoreSelectionDecodeError('selection_too_large');
  }
  return validateSelectionValue(
    parseJson(
      bytes,
      () => new ActiveStoreSelectionDecodeError('selection_invalid_utf8'),
      () => new ActiveStoreSelectionDecodeError('selection_invalid_json'),
    ),
  );
}

export function encodeActiveStoreSelection(selection: ActiveStoreSelection): Uint8Array {
  const parsed = validateSelectionValue(selection);
  const bytes = new TextEncoder().encode(`${JSON.stringify(parsed)}\n`);
  if (bytes.byteLength > ACTIVE_STORE_SELECTION_MAX_BYTES) {
    throw new ActiveStoreSelectionDecodeError('selection_too_large');
  }
  return bytes;
}

function validateTransitionValue(value: unknown): ActiveStoreTransition {
  const parsed = activeStoreTransitionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ActiveStoreTransitionDecodeError('transition_invalid_schema');
  }
  return parsed.data;
}

export function decodeActiveStoreTransition(bytes: Uint8Array): ActiveStoreTransition {
  if (bytes.byteLength > ACTIVE_STORE_TRANSITION_MAX_BYTES) {
    throw new ActiveStoreTransitionDecodeError('transition_too_large');
  }
  return validateTransitionValue(
    parseJson(
      bytes,
      () => new ActiveStoreTransitionDecodeError('transition_invalid_utf8'),
      () => new ActiveStoreTransitionDecodeError('transition_invalid_json'),
    ),
  );
}

export function encodeActiveStoreTransition(transition: ActiveStoreTransition): Uint8Array {
  const parsed = validateTransitionValue(transition);
  const bytes = new TextEncoder().encode(`${JSON.stringify(parsed)}\n`);
  if (bytes.byteLength > ACTIVE_STORE_TRANSITION_MAX_BYTES) {
    throw new ActiveStoreTransitionDecodeError('transition_too_large');
  }
  return bytes;
}

function sameIdentity(left: StorageBigIntStat, right: StorageBigIntStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function ensureActiveStoreCoordinationDirectory(runtime: Runtime, actuator: StorageActuator): void {
  const { coordinationRoot } = resolveActiveStoreRecordPaths(runtime);
  if (!runtime.storage.existsSync(coordinationRoot)) {
    actuator.makeDirectory(coordinationRoot, { recursive: true });
    const created = runtime.storage.lstatSync(coordinationRoot);
    if (created.isSymbolicLink()) {
      throw new ActiveStoreCoordinationWriteError(
        'coordination_directory_link',
        'Active-store coordination directory could not be created safely: path is a symbolic link.',
      );
    }
    if (!created.isDirectory()) {
      throw new ActiveStoreCoordinationWriteError(
        'coordination_directory_not_regular',
        'Active-store coordination directory could not be created safely: path is not a directory.',
      );
    }
    actuator.setMode(coordinationRoot, 0o700);
  }
  const link = runtime.storage.lstatSync(coordinationRoot);
  if (link.isSymbolicLink()) {
    throw new ActiveStoreCoordinationWriteError(
      'coordination_directory_link',
      'Active-store coordination directory is a symbolic link.',
    );
  }
  if (!link.isDirectory()) {
    throw new ActiveStoreCoordinationWriteError(
      'coordination_directory_not_regular',
      'Active-store coordination directory is not a directory.',
    );
  }
  if (runtime.storage.realpathSync(coordinationRoot) !== coordinationRoot) {
    throw new ActiveStoreCoordinationWriteError(
      'coordination_directory_not_canonical',
      'Active-store coordination directory is not canonical.',
    );
  }
  actuator.setMode(coordinationRoot, 0o700);
  const stat = runtime.storage.statSync(coordinationRoot, { bigint: true });
  if (!stat.isDirectory()) {
    throw new ActiveStoreCoordinationWriteError(
      'coordination_directory_not_regular',
      'Active-store coordination directory is not a directory.',
    );
  }
  // Unix permission bits are not meaningful on win32 (chmod there only toggles the read-only attribute), so the
  // Private-mode assertion is platform-gated because Windows does not expose POSIX permission bits.
  // Windows is not a supported Coral platform; this guard is defensive only.
  if (runtime.env.platform() !== 'win32' && (stat.mode & PERMISSION_BITS) !== 0o700n) {
    throw new ActiveStoreCoordinationWriteError(
      'coordination_directory_not_canonical',
      'Active-store coordination directory is not private (mode 0700).',
    );
  }
}

function publishActiveStoreRecord(
  runtime: Runtime,
  path: string,
  bytes: Uint8Array,
  record: string,
  actuator: StorageActuator,
): void {
  ensureActiveStoreCoordinationDirectory(runtime, actuator);
  if (!actuator.writeWholeFileDurable(path, bytes, { mode: 0o600 })) {
    throw new ActiveStoreCoordinationWriteError('record_unavailable', `${record} could not be published durably.`);
  }
}

export function publishActiveStoreSelection(
  runtime: Runtime,
  selection: ActiveStoreSelection,
  actuator: StorageActuator,
): void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  const v1Bytes = encodeActiveStoreSelectionV1(selection);
  const currentBytes = encodeActiveStoreSelection(selection);
  publishActiveStoreRecord(runtime, paths.selectionV1File, v1Bytes, 'Active-store selection v1 projection', actuator);
  publishActiveStoreRecord(runtime, paths.selectionFile, currentBytes, 'Active-store selection', actuator);
}

export function publishActiveStoreTransition(
  runtime: Runtime,
  transition: ActiveStoreTransition,
  actuator: StorageActuator,
): void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  const currentBytes = encodeActiveStoreTransition(transition);
  publishActiveStoreRecord(runtime, paths.transitionFile, currentBytes, 'Active-store transition', actuator);
}

function activeStoreTransitionIdentity(
  runtime: Runtime,
  path: string,
  expectedIdentity?: StorageBigIntStat,
): StorageBigIntStat | null {
  if (!runtime.storage.existsSync(path)) return null;
  const link = runtime.storage.lstatSync(path);
  const stat = runtime.storage.statSync(path, { bigint: true });
  if (
    !link.isFile() ||
    link.isSymbolicLink() ||
    !stat.isFile() ||
    (expectedIdentity !== undefined && !sameIdentity(stat, expectedIdentity))
  ) {
    throw new ActiveStoreCoordinationWriteError(
      'record_changed',
      'Active-store transition changed before durable clear.',
    );
  }
  return stat;
}

type BoundedRecordReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array; readonly overLimit: boolean }
  | { readonly kind: 'rejected'; readonly failureCode: ActiveStoreRecordReadFailureCode };

class RecordReadError extends Error {
  readonly code: ActiveStoreRecordReadFailureCode;

  constructor(code: ActiveStoreRecordReadFailureCode) {
    super(code);
    this.code = code;
  }
}

function inspectCoordinationDirectory(
  storage: StoragePort,
  coordinationRoot: string,
): { readonly kind: 'present' } | Exclude<BoundedRecordReadResult, { readonly kind: 'bytes' }> {
  let pathStat: StorageEntryKind;
  try {
    pathStat = storage.lstatSync(coordinationRoot);
  } catch (error: unknown) {
    return isNoEntryError(error)
      ? { kind: 'absent' }
      : { kind: 'rejected', failureCode: 'coordination_directory_unavailable' };
  }

  if (pathStat.isSymbolicLink()) {
    return { kind: 'rejected', failureCode: 'coordination_directory_link' };
  }
  if (!pathStat.isDirectory()) {
    return { kind: 'rejected', failureCode: 'coordination_directory_not_regular' };
  }

  try {
    const stat = storage.statSync(coordinationRoot, { bigint: true });
    if (!stat.isDirectory()) {
      return { kind: 'rejected', failureCode: 'coordination_directory_not_regular' };
    }
    if (storage.realpathSync(coordinationRoot) !== coordinationRoot) {
      return { kind: 'rejected', failureCode: 'coordination_directory_not_canonical' };
    }
  } catch {
    return { kind: 'rejected', failureCode: 'coordination_directory_unavailable' };
  }
  return { kind: 'present' };
}

function readOpenedRecord(
  storage: StoragePort,
  path: string,
  pathBefore: StorageBigIntStat,
  maxBytes: number,
): Exclude<BoundedRecordReadResult, { readonly kind: 'absent' }> {
  let descriptor: number | null = null;
  let result: Exclude<BoundedRecordReadResult, { readonly kind: 'absent' }>;
  try {
    descriptor = storage.openSync(path, 'r');
    const opened = storage.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(pathBefore, opened)) {
      throw new RecordReadError('record_changed');
    }

    const buffer = Buffer.allocUnsafe(maxBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const read = storage.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (read < 0 || read > buffer.length - offset) throw new RecordReadError('record_unavailable');
      if (read === 0) break;
      offset += read;
    }

    let overLimit = false;
    if (offset === maxBytes) {
      const probe = Buffer.allocUnsafe(1);
      const read = storage.readSync(descriptor, probe, 0, 1, null);
      if (read < 0 || read > 1) throw new RecordReadError('record_unavailable');
      overLimit = read === 1;
    }
    if (
      (opened.size <= BigInt(maxBytes) && opened.size !== BigInt(offset)) ||
      (opened.size > BigInt(maxBytes) && !overLimit)
    ) {
      throw new RecordReadError('record_changed');
    }

    const openedAfter = storage.fstatSync(descriptor, { bigint: true });
    const pathAfterKind = storage.lstatSync(path);
    const pathAfter = storage.statSync(path, { bigint: true });
    if (
      !sameIdentity(opened, openedAfter) ||
      pathAfterKind.isSymbolicLink() ||
      !pathAfterKind.isFile() ||
      !sameIdentity(opened, pathAfter)
    ) {
      throw new RecordReadError('record_changed');
    }
    result = { kind: 'bytes', bytes: buffer.subarray(0, offset), overLimit };
  } catch (error: unknown) {
    result = {
      kind: 'rejected',
      failureCode: error instanceof RecordReadError ? error.code : 'record_unavailable',
    };
  } finally {
    if (descriptor !== null) {
      try {
        storage.closeSync(descriptor);
      } catch {
        result = { kind: 'rejected', failureCode: 'record_unavailable' };
      }
    }
  }
  return result;
}

type RecordPathInspection =
  | Extract<BoundedRecordReadResult, { readonly kind: 'absent' | 'rejected' }>
  | { readonly kind: 'present'; readonly stat: StorageBigIntStat };

function inspectRecordPath(storage: StoragePort, coordinationRoot: string, path: string): RecordPathInspection {
  const coordination = inspectCoordinationDirectory(storage, coordinationRoot);
  if (coordination.kind !== 'present') return coordination;

  let pathKind: StorageEntryKind;
  try {
    pathKind = storage.lstatSync(path);
  } catch (error: unknown) {
    return isNoEntryError(error) ? { kind: 'absent' } : { kind: 'rejected', failureCode: 'record_unavailable' };
  }
  if (pathKind.isSymbolicLink()) return { kind: 'rejected', failureCode: 'record_link' };
  if (!pathKind.isFile()) return { kind: 'rejected', failureCode: 'record_not_regular' };

  let pathBefore: StorageBigIntStat;
  try {
    pathBefore = storage.statSync(path, { bigint: true });
  } catch {
    return { kind: 'rejected', failureCode: 'record_unavailable' };
  }
  if (!pathBefore.isFile()) return { kind: 'rejected', failureCode: 'record_not_regular' };
  return { kind: 'present', stat: pathBefore };
}

function readBoundedRecord(
  storage: StoragePort,
  coordinationRoot: string,
  path: string,
  maxBytes: number,
): BoundedRecordReadResult {
  const inspected = inspectRecordPath(storage, coordinationRoot, path);
  if (inspected.kind !== 'present') return inspected;
  const pathBefore = inspected.stat;
  if ((pathBefore.mode & PERMISSION_BITS) !== PRIVATE_FILE_MODE) {
    return { kind: 'rejected', failureCode: 'record_mode' };
  }
  if (pathBefore.size < 0n) return { kind: 'rejected', failureCode: 'record_unavailable' };
  return readOpenedRecord(storage, path, pathBefore, maxBytes);
}

function readBoundedRecordForSettlement(
  storage: StoragePort,
  coordinationRoot: string,
  path: string,
  maxBytes: number,
  actuator: StorageActuator,
): BoundedRecordReadResult {
  const inspected = inspectRecordPath(storage, coordinationRoot, path);
  if (inspected.kind !== 'present') return inspected;
  let pathBefore = inspected.stat;
  if ((pathBefore.mode & PERMISSION_BITS) !== PRIVATE_FILE_MODE) {
    const currentUid = process.getuid?.();
    const ownerUid = pathBefore.uid;
    // Mode drift is repairable only for the current user's regular file. A foreign owner is a trust boundary,
    // not state an upgrade may silently adopt; abstract storage ports without uid metadata must prove authority
    // by allowing the chmod itself.
    if (currentUid !== undefined && ownerUid !== undefined && ownerUid !== BigInt(currentUid)) {
      return { kind: 'rejected', failureCode: 'record_mode' };
    }
    try {
      actuator.setMode(path, Number(PRIVATE_FILE_MODE));
      pathBefore = storage.statSync(path, { bigint: true });
    } catch {
      return { kind: 'rejected', failureCode: 'record_mode' };
    }
    if (!pathBefore.isFile() || (pathBefore.mode & PERMISSION_BITS) !== PRIVATE_FILE_MODE) {
      return { kind: 'rejected', failureCode: 'record_mode' };
    }
  }
  if (pathBefore.size < 0n) return { kind: 'rejected', failureCode: 'record_unavailable' };
  return readOpenedRecord(storage, path, pathBefore, maxBytes);
}

function malformedSelectionEvidence(
  bytes: Uint8Array,
  failureCode: ActiveStoreSelectionFailureCode,
): ActiveStoreSelectionMalformedEvidence {
  const bounded = bytes.subarray(0, ACTIVE_STORE_SELECTION_MAX_BYTES);
  return {
    kind: 'selection-malformed',
    selectionByteLength: bounded.byteLength,
    selectionSha256: createHash('sha256').update(bounded).digest('hex'),
    failureCode,
  };
}

function validateSelectionV1Value(value: unknown): ActiveStoreSelectionV1 {
  const parsed = activeStoreSelectionV1StructuralSchema.safeParse(value);
  if (!parsed.success) {
    throw new ActiveStoreSelectionDecodeError('selection_invalid_schema');
  }
  if (!selectionManifestAgrees(parsed.data)) {
    throw new ActiveStoreSelectionDecodeError('selection_manifest_disagreement');
  }
  if (!isLexicallyCanonicalAbsolutePath(parsed.data.bundleDir)) {
    throw new ActiveStoreSelectionDecodeError('selection_bundle_dir_not_canonical');
  }
  return parsed.data;
}

function decodeActiveStoreSelectionV1(bytes: Uint8Array): ActiveStoreSelectionV1 {
  if (bytes.byteLength > ACTIVE_STORE_SELECTION_MAX_BYTES) {
    throw new ActiveStoreSelectionDecodeError('selection_too_large');
  }
  return validateSelectionV1Value(
    parseJson(
      bytes,
      () => new ActiveStoreSelectionDecodeError('selection_invalid_utf8'),
      () => new ActiveStoreSelectionDecodeError('selection_invalid_json'),
    ),
  );
}

type ActiveStoreSelectionV1ReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly selection: ActiveStoreSelectionV1 }
  | { readonly kind: 'malformed'; readonly evidence: ActiveStoreSelectionMalformedEvidence }
  | { readonly kind: 'rejected'; readonly failureCode: ActiveStoreRecordReadFailureCode };

type ActiveStoreRecordReader = typeof readBoundedRecord;

function readActiveStoreSelectionV1With(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  readRecord: ActiveStoreRecordReader,
): ActiveStoreSelectionV1ReadResult {
  const paths = resolveActiveStoreRecordPaths(runtime);
  const read = readRecord(
    runtime.storage,
    paths.coordinationRoot,
    paths.selectionV1File,
    ACTIVE_STORE_SELECTION_MAX_BYTES,
  );
  if (read.kind === 'absent') return read;
  if (read.kind === 'rejected') return read;
  if (read.overLimit) {
    return { kind: 'malformed', evidence: malformedSelectionEvidence(read.bytes, 'selection_too_large') };
  }

  try {
    return { kind: 'valid', selection: decodeActiveStoreSelectionV1(read.bytes) };
  } catch (error: unknown) {
    const failureCode = error instanceof ActiveStoreSelectionDecodeError ? error.code : 'selection_invalid_schema';
    return { kind: 'malformed', evidence: malformedSelectionEvidence(read.bytes, failureCode) };
  }
}

function readActiveStoreSelectionWith(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  readRecord: ActiveStoreRecordReader,
): ActiveStoreSelectionReadResult {
  const paths = resolveActiveStoreRecordPaths(runtime);
  const read = readRecord(
    runtime.storage,
    paths.coordinationRoot,
    paths.selectionFile,
    ACTIVE_STORE_SELECTION_MAX_BYTES,
  );
  if (read.kind === 'absent') return read;
  if (read.kind === 'rejected') return read;
  if (read.overLimit) {
    return { kind: 'malformed', evidence: malformedSelectionEvidence(read.bytes, 'selection_too_large') };
  }

  try {
    return { kind: 'valid', selection: decodeActiveStoreSelection(read.bytes) };
  } catch (error: unknown) {
    const failureCode = error instanceof ActiveStoreSelectionDecodeError ? error.code : 'selection_invalid_schema';
    return { kind: 'malformed', evidence: malformedSelectionEvidence(read.bytes, failureCode) };
  }
}

export function readActiveStoreSelection(runtime: Pick<Runtime, 'paths' | 'storage'>): ActiveStoreSelectionReadResult {
  return readActiveStoreSelectionWith(runtime, readBoundedRecord);
}

export function readActiveStoreSelectionForCoordination(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
): ActiveStoreSelectionCoordinationReadResult {
  return readActiveStoreSelectionForCoordinationWith(runtime, readBoundedRecord);
}

export function readActiveStoreSelectionForSettlement(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  actuator: StorageActuator,
): ActiveStoreSelectionCoordinationReadResult {
  return readActiveStoreSelectionForCoordinationWith(runtime, (storage, root, path, maxBytes) =>
    readBoundedRecordForSettlement(storage, root, path, maxBytes, actuator),
  );
}

function readActiveStoreSelectionForCoordinationWith(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  readRecord: ActiveStoreRecordReader,
): ActiveStoreSelectionCoordinationReadResult {
  const v1 = readActiveStoreSelectionV1With(runtime, readRecord);
  const current = readActiveStoreSelectionWith(runtime, readRecord);
  if (v1.kind === 'absent') return current;
  if (v1.kind === 'rejected') return v1;
  if (v1.kind === 'malformed') return { kind: 'rejected', failureCode: 'record_incoherent' };
  if (current.kind === 'rejected') return current;
  if (
    current.kind === 'valid' &&
    current.selection.bundleDir === v1.selection.bundleDir &&
    current.selection.activeStoreFingerprint === v1.selection.activeStoreFingerprint &&
    activeStoreManifestV1Matches(projectActiveStoreManifestV1(current.selection.manifest), v1.selection.manifest)
  ) {
    return current;
  }
  return { kind: 'v1', selection: v1.selection };
}

function readActiveStoreTransitionWith(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  readRecord: ActiveStoreRecordReader,
): ActiveStoreTransitionReadResult {
  const paths = resolveActiveStoreRecordPaths(runtime);
  const read = readRecord(
    runtime.storage,
    paths.coordinationRoot,
    paths.transitionFile,
    ACTIVE_STORE_TRANSITION_MAX_BYTES,
  );
  if (read.kind === 'absent') return read;
  if (read.kind === 'rejected') return read;
  if (read.overLimit) return { kind: 'malformed', failureCode: 'transition_too_large' };

  try {
    return { kind: 'valid', transition: decodeActiveStoreTransition(read.bytes) };
  } catch (error: unknown) {
    return {
      kind: 'malformed',
      failureCode: error instanceof ActiveStoreTransitionDecodeError ? error.code : 'transition_invalid_schema',
    };
  }
}

export function readActiveStoreTransition(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
): ActiveStoreTransitionReadResult {
  return readActiveStoreTransitionWith(runtime, readBoundedRecord);
}

export function readActiveStoreTransitionForSettlement(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  actuator: StorageActuator,
): ActiveStoreTransitionReadResult {
  return readActiveStoreTransitionWith(runtime, (storage, root, path, maxBytes) =>
    readBoundedRecordForSettlement(storage, root, path, maxBytes, actuator),
  );
}

function readActiveStoreTransitionV1With(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  readRecord: ActiveStoreRecordReader,
): ActiveStoreTransitionV1ReadResult {
  const paths = resolveActiveStoreRecordPaths(runtime);
  const read = readRecord(
    runtime.storage,
    paths.coordinationRoot,
    paths.transitionV1File,
    ACTIVE_STORE_TRANSITION_MAX_BYTES,
  );
  if (read.kind === 'absent' || read.kind === 'rejected') return read;
  return { kind: 'legacy' };
}

export function readActiveStoreTransitionV1ForSettlement(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
  actuator: StorageActuator,
): ActiveStoreTransitionV1ReadResult {
  return readActiveStoreTransitionV1With(runtime, (storage, root, path, maxBytes) =>
    readBoundedRecordForSettlement(storage, root, path, maxBytes, actuator),
  );
}
