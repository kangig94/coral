import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

import { strictBundleManifestSchema, type StrictBundleManifest } from '../infra/bundle-manifest.js';
import { isNoEntryError } from '../infra/fs-errors.js';
import { manifestsMatch, type InvalidTargetEvidence, type InvalidTargetFailure } from '../infra/handoff-target.js';
import type { StorageBigIntStat, StoragePort } from '../infra/port-types.js';
import { compareProductVersions } from '../infra/product-version.js';
import type { Runtime } from '../runtime/ports.js';
import { resolveGenerationBoundaryPaths } from './generation-mutation-coordination.js';

export const ACTIVE_STORE_SELECTION_MAX_BYTES = 16 * 1024;
export const ACTIVE_STORE_TRANSITION_MAX_BYTES = 32 * 1024;

const ACTIVE_STORE_SELECTION_FILE_NAME = 'active-store-selection.v1.json';
const ACTIVE_STORE_TRANSITION_FILE_NAME = 'active-store-transition.v1.json';
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
  | 'record_unavailable';

export type ActiveStoreSelection = Readonly<{
  version: 1;
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
  version: 1;
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
}>;

export type ActiveStoreSelectionReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly selection: ActiveStoreSelection }
  | { readonly kind: 'malformed'; readonly evidence: ActiveStoreSelectionMalformedEvidence }
  | { readonly kind: 'rejected'; readonly failureCode: ActiveStoreRecordReadFailureCode };

export type ActiveStoreTransitionReadResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly transition: ActiveStoreTransition }
  | { readonly kind: 'malformed'; readonly failureCode: ActiveStoreTransitionFailureCode }
  | { readonly kind: 'rejected'; readonly failureCode: ActiveStoreRecordReadFailureCode };

export type ActiveStoreSelectionRelation = 'exact' | 'advance' | 'equal-refresh' | 'selected-newer';

const activeStoreSelectionStructuralSchema = z
  .object({
    version: z.literal(1),
    manifest: strictBundleManifestSchema,
    bundleDir: z.string().min(1),
    activeStoreFingerprint: strictBundleManifestSchema.shape.storeFormatFingerprint,
  })
  .strict();

function isLexicallyCanonicalAbsolutePath(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path;
}

function selectionManifestAgrees(selection: ActiveStoreSelection): boolean {
  return selection.activeStoreFingerprint === selection.manifest.storeFormatFingerprint;
}

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
    currentFingerprint: strictBundleManifestSchema.shape.storeFormatFingerprint,
    currentProductVersion: strictBundleManifestSchema.shape.version,
    storedFingerprint: strictBundleManifestSchema.shape.storeFormatFingerprint,
    storedProductVersion: strictBundleManifestSchema.shape.version,
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
    expectedManifest: strictBundleManifestSchema,
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
  if (precedence > 0) return 'selected-newer';
  if (precedence < 0) return 'advance';
  return 'equal-refresh';
}

function classifiedStoreEvidence(evidence: ActiveStoreTransitionEvidence): NewerStoreEvidence | null {
  if (evidence.kind === 'current-selection-newer-store') return evidence.newerStoreEvidence;
  return evidence.storeEvidence.kind === 'newer-incompatible' ? evidence.storeEvidence : null;
}

export const activeStoreTransitionSchema = z
  .object({
    version: z.literal(1),
    transitionId: z.string().regex(TRANSITION_ID_PATTERN),
    kind: z.literal('selection-recovery'),
    evidence: activeStoreTransitionEvidenceSchema,
    currentManifest: strictBundleManifestSchema,
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

export function decodeActiveStoreTransition(bytes: Uint8Array): ActiveStoreTransition {
  if (bytes.byteLength > ACTIVE_STORE_TRANSITION_MAX_BYTES) {
    throw new ActiveStoreTransitionDecodeError('transition_too_large');
  }
  const parsed = activeStoreTransitionSchema.safeParse(
    parseJson(
      bytes,
      () => new ActiveStoreTransitionDecodeError('transition_invalid_utf8'),
      () => new ActiveStoreTransitionDecodeError('transition_invalid_json'),
    ),
  );
  if (!parsed.success) {
    throw new ActiveStoreTransitionDecodeError('transition_invalid_schema');
  }
  return parsed.data;
}

export function encodeActiveStoreTransition(transition: ActiveStoreTransition): Uint8Array {
  const parsed = activeStoreTransitionSchema.safeParse(transition);
  if (!parsed.success) {
    throw new ActiveStoreTransitionDecodeError('transition_invalid_schema');
  }
  const bytes = new TextEncoder().encode(`${JSON.stringify(parsed.data)}\n`);
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

function ensureActiveStoreCoordinationDirectory(runtime: Runtime): void {
  const { coordinationRoot } = resolveActiveStoreRecordPaths(runtime);
  if (!runtime.storage.existsSync(coordinationRoot)) {
    runtime.storage.mkdirSync(coordinationRoot, { recursive: true });
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
    runtime.storage.chmodSync(coordinationRoot, 0o700);
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
  runtime.storage.chmodSync(coordinationRoot, 0o700);
  const stat = runtime.storage.statSync(coordinationRoot, { bigint: true });
  if (!stat.isDirectory()) {
    throw new ActiveStoreCoordinationWriteError(
      'coordination_directory_not_regular',
      'Active-store coordination directory is not a directory.',
    );
  }
  // Unix permission bits are not meaningful on win32 (chmod there only toggles the read-only attribute), so the
  // private-mode assertion is platform-gated, mirroring `assertPrivateDirectory` in backend-store-reset.ts.
  // Windows is not a supported Coral platform; this guard is defensive only.
  if (runtime.env.platform() !== 'win32' && (stat.mode & PERMISSION_BITS) !== 0o700n) {
    throw new ActiveStoreCoordinationWriteError(
      'coordination_directory_not_canonical',
      'Active-store coordination directory is not private (mode 0700).',
    );
  }
}

function publishActiveStoreRecord(runtime: Runtime, path: string, bytes: Uint8Array, record: string): void {
  ensureActiveStoreCoordinationDirectory(runtime);
  if (!runtime.storage.writeAtomicDurableSync(path, bytes, { mode: 0o600 })) {
    throw new ActiveStoreCoordinationWriteError('record_unavailable', `${record} could not be published durably.`);
  }
}

export function publishActiveStoreSelection(runtime: Runtime, selection: ActiveStoreSelection): void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  publishActiveStoreRecord(
    runtime,
    paths.selectionFile,
    encodeActiveStoreSelection(selection),
    'Active-store selection',
  );
}

export function publishActiveStoreTransition(runtime: Runtime, transition: ActiveStoreTransition): void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  publishActiveStoreRecord(
    runtime,
    paths.transitionFile,
    encodeActiveStoreTransition(transition),
    'Active-store transition',
  );
}

export function clearActiveStoreTransition(runtime: Runtime, expectedIdentity?: StorageBigIntStat): void {
  const paths = resolveActiveStoreRecordPaths(runtime);
  if (!runtime.storage.existsSync(paths.transitionFile)) return;
  const link = runtime.storage.lstatSync(paths.transitionFile);
  const stat = runtime.storage.statSync(paths.transitionFile, { bigint: true });
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
  runtime.storage.unlinkSync(paths.transitionFile);
  if (!runtime.storage.syncDirectoryDurableSync(paths.coordinationRoot)) {
    throw new ActiveStoreCoordinationWriteError(
      'record_unavailable',
      'Active-store transition clear could not be synchronized durably.',
    );
  }
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
  let pathStat: ReturnType<StoragePort['lstatSync']>;
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

function readBoundedRecord(
  storage: StoragePort,
  coordinationRoot: string,
  path: string,
  maxBytes: number,
): BoundedRecordReadResult {
  const coordination = inspectCoordinationDirectory(storage, coordinationRoot);
  if (coordination.kind !== 'present') return coordination;

  let pathKind: ReturnType<StoragePort['lstatSync']>;
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
      storage.chmodSync(path, Number(PRIVATE_FILE_MODE));
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

export function readActiveStoreSelection(runtime: Pick<Runtime, 'paths' | 'storage'>): ActiveStoreSelectionReadResult {
  const paths = resolveActiveStoreRecordPaths(runtime);
  const read = readBoundedRecord(
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

export function readActiveStoreTransition(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
): ActiveStoreTransitionReadResult {
  const paths = resolveActiveStoreRecordPaths(runtime);
  const read = readBoundedRecord(
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
