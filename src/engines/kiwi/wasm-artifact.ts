import { createHash } from 'node:crypto';

import { extractTarGzEntriesInWorker } from '../../infra/archive-extraction-worker.js';
import { isNoEntryError } from '../../infra/fs-errors.js';
import { sha256Hex } from '../../infra/hash.js';
import { isRecord } from '../../infra/json.js';
import { downloadBuffer } from '../../runtime/download.js';
import type { Runtime } from '../../runtime/ports.js';
import {
  KIWI_INSTALL_ONLY_ID,
  KIWI_NLP_PACKAGE_INTEGRITY,
  KIWI_NLP_PACKAGE_SHA256,
  KIWI_NLP_PACKAGE_SIZE_BYTES,
  KIWI_NLP_PACKAGE_URL,
  KIWI_NLP_VERSION,
  KIWI_WASM_FILE_NAME,
  KIWI_WASM_SHA256,
  KIWI_WASM_SIZE_BYTES,
  KIWI_WASM_TAR_ENTRY,
} from './constants.js';
import { kiwiWasmDir, kiwiWasmManifestPath, kiwiWasmPath } from './paths.js';

const KIWI_WASM_MANIFEST_SCHEMA_VERSION = 1;
const KIWI_WASM_ARTIFACT_KIND = 'kiwi-wasm';
const KIWI_WASM_MANIFEST_MAX_BYTES = 64 * 1024;
const KIWI_WASM_TAR_MAX_BYTES = 4 * 1024 * 1024;
const KIWI_WASM_EXTRACTION_WORKER_TIMEOUT_MS = 60_000;

type KiwiWasmArtifactReason =
  | 'manifest_missing_or_invalid'
  | 'file_missing'
  | 'file_not_regular'
  | 'file_size_mismatch'
  | 'file_unreadable'
  | 'file_digest_mismatch';

export type KiwiWasmArtifactManifest = {
  readonly schemaVersion: typeof KIWI_WASM_MANIFEST_SCHEMA_VERSION;
  readonly artifact: typeof KIWI_WASM_ARTIFACT_KIND;
  readonly packageId: typeof KIWI_INSTALL_ONLY_ID;
  readonly kiwiNlpVersion: string;
  readonly sourceUrl: string;
  readonly archiveIntegrity: string;
  readonly archiveSha256: string;
  readonly archiveSizeBytes: number;
  readonly archiveEntry: string;
  readonly wasmSha256: string;
  readonly wasmSizeBytes: number;
  readonly file: typeof KIWI_WASM_FILE_NAME;
  readonly installedAt: string;
};

export type KiwiWasmArtifactState = {
  readonly targetDir: string;
  readonly manifestPath: string;
  readonly wasmPath: string;
  readonly installed: boolean;
  readonly manifest: KiwiWasmArtifactManifest | null;
  readonly payloadValid: boolean;
  readonly payloadSha256: string | null;
  readonly reason: KiwiWasmArtifactReason | null;
};

type KiwiWasmPathIdentity =
  | { readonly state: 'missing' | 'unreadable' }
  | {
      readonly state: 'present';
      readonly regularFile: boolean;
      readonly dev: string;
      readonly ino: string;
      readonly mode: string;
      readonly size: string;
      readonly mtimeNs: string;
    };

export type KiwiWasmArtifactIdentity = {
  readonly manifest: KiwiWasmPathIdentity;
  readonly payload: KiwiWasmPathIdentity;
};

type KiwiWasmDownload = (runtime: Runtime, url: string, options: { readonly maxBytes: number }) => Promise<Buffer>;

export type KiwiWasmInstallOptions = {
  readonly logger?: (event: { readonly kind: string; readonly message: string }) => void;
  readonly download?: KiwiWasmDownload;
  readonly extract?: (archive: Buffer) => Promise<Buffer>;
};

function logInstallEvent(opts: KiwiWasmInstallOptions, kind: string, message: string): void {
  opts.logger?.({ kind, message });
}

function isRegularFile(runtime: Pick<Runtime, 'storage'>, path: string): boolean {
  try {
    const stat = runtime.storage.lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function probePathIdentity(runtime: Pick<Runtime, 'storage'>, path: string): KiwiWasmPathIdentity {
  try {
    const kind = runtime.storage.lstatSync(path);
    const stat = runtime.storage.statSync(path, { bigint: true });
    return {
      state: 'present',
      regularFile: kind.isFile() && !kind.isSymbolicLink(),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      mode: stat.mode.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
    };
  } catch (error: unknown) {
    return { state: isNoEntryError(error) ? 'missing' : 'unreadable' };
  }
}

export function probeKiwiWasmArtifactIdentity(runtime: Pick<Runtime, 'paths' | 'storage'>): KiwiWasmArtifactIdentity {
  return {
    manifest: probePathIdentity(runtime, kiwiWasmManifestPath(runtime)),
    payload: probePathIdentity(runtime, kiwiWasmPath(runtime)),
  };
}

function isKiwiWasmArtifactManifest(value: unknown): value is KiwiWasmArtifactManifest {
  return (
    isRecord(value) &&
    value.schemaVersion === KIWI_WASM_MANIFEST_SCHEMA_VERSION &&
    value.artifact === KIWI_WASM_ARTIFACT_KIND &&
    value.packageId === KIWI_INSTALL_ONLY_ID &&
    value.kiwiNlpVersion === KIWI_NLP_VERSION &&
    value.sourceUrl === KIWI_NLP_PACKAGE_URL &&
    value.archiveIntegrity === KIWI_NLP_PACKAGE_INTEGRITY &&
    value.archiveSha256 === KIWI_NLP_PACKAGE_SHA256 &&
    value.archiveSizeBytes === KIWI_NLP_PACKAGE_SIZE_BYTES &&
    value.archiveEntry === KIWI_WASM_TAR_ENTRY &&
    value.wasmSha256 === KIWI_WASM_SHA256 &&
    value.wasmSizeBytes === KIWI_WASM_SIZE_BYTES &&
    value.file === KIWI_WASM_FILE_NAME &&
    typeof value.installedAt === 'string'
  );
}

function readInstalledManifest(runtime: Pick<Runtime, 'paths' | 'storage'>): KiwiWasmArtifactManifest | null {
  const manifestPath = kiwiWasmManifestPath(runtime);
  try {
    if (
      !isRegularFile(runtime, manifestPath) ||
      runtime.storage.statSync(manifestPath).size > KIWI_WASM_MANIFEST_MAX_BYTES
    ) {
      return null;
    }
    const parsed = JSON.parse(runtime.storage.readFileSync(manifestPath, 'utf-8')) as unknown;
    return isKiwiWasmArtifactManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type StableFileStat = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
};

function sameStableFile(left: StableFileStat, right: StableFileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function hashOpenFile(
  runtime: Pick<Runtime, 'storage'>,
  descriptor: number,
  expectedSize: bigint,
  path: string,
): { readonly digest: string; readonly bytesRead: bigint } {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytesRead = 0n;
  while (bytesRead < expectedSize) {
    const remaining = Number(expectedSize - bytesRead);
    const read = runtime.storage.readSync(descriptor, buffer, 0, Math.min(buffer.length, remaining), null);
    if (read <= 0) {
      throw new Error(`Unexpected end of file while hashing ${path}`);
    }
    bytesRead += BigInt(read);
    hash.update(buffer.subarray(0, read));
  }
  const probe = Buffer.allocUnsafe(1);
  if (runtime.storage.readSync(descriptor, probe, 0, 1, null) !== 0) {
    throw new Error(`Kiwi WASM grew while hashing: ${path}`);
  }
  return { digest: hash.digest('hex'), bytesRead };
}

function assertStableFileIdentity(
  runtime: Pick<Runtime, 'storage'>,
  path: string,
  descriptor: number,
  opened: StableFileStat,
  bytesRead: bigint,
): void {
  const openedAfter = runtime.storage.fstatSync(descriptor, { bigint: true });
  const pathAfter = runtime.storage.statSync(path, { bigint: true });
  const pathKindAfter = runtime.storage.lstatSync(path);
  if (
    pathKindAfter.isSymbolicLink() ||
    !pathKindAfter.isFile() ||
    bytesRead !== opened.size ||
    !sameStableFile(opened, openedAfter) ||
    !sameStableFile(opened, pathAfter)
  ) {
    throw new Error(`Kiwi WASM identity changed while hashing: ${path}`);
  }
}

/**
 * Hashes fresh bytes and proves the descriptor still names the canonical path.
 * This prevents same-metadata replacement races from being accepted as ready.
 */
function stableFileSha256(runtime: Pick<Runtime, 'storage'>, path: string): string {
  const pathBefore = runtime.storage.statSync(path, { bigint: true });
  const descriptor = runtime.storage.openSync(path, 'r');
  let digest: string | undefined;
  let closeError: unknown = null;
  try {
    const opened = runtime.storage.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameStableFile(pathBefore, opened)) {
      throw new Error(`Kiwi WASM identity changed before hashing: ${path}`);
    }
    const hashed = hashOpenFile(runtime, descriptor, opened.size, path);
    assertStableFileIdentity(runtime, path, descriptor, opened, hashed.bytesRead);
    digest = hashed.digest;
  } finally {
    try {
      runtime.storage.closeSync(descriptor);
    } catch (error: unknown) {
      closeError = error;
    }
  }
  if (closeError !== null || digest === undefined) {
    throw new Error(`Kiwi WASM descriptor could not be closed safely: ${path}`, {
      cause: closeError,
    });
  }
  return digest;
}

function inspectPayload(
  runtime: Pick<Runtime, 'paths' | 'storage'>,
): Pick<KiwiWasmArtifactState, 'payloadValid' | 'payloadSha256' | 'reason'> {
  const wasmPath = kiwiWasmPath(runtime);
  try {
    const lstat = runtime.storage.lstatSync(wasmPath);
    if (!lstat.isFile() || lstat.isSymbolicLink()) {
      return { payloadValid: false, payloadSha256: null, reason: 'file_not_regular' };
    }
  } catch {
    return { payloadValid: false, payloadSha256: null, reason: 'file_missing' };
  }

  try {
    if (runtime.storage.statSync(wasmPath).size !== KIWI_WASM_SIZE_BYTES) {
      return { payloadValid: false, payloadSha256: null, reason: 'file_size_mismatch' };
    }
    const payloadSha256 = stableFileSha256(runtime, wasmPath);
    return payloadSha256 === KIWI_WASM_SHA256
      ? { payloadValid: true, payloadSha256, reason: null }
      : { payloadValid: false, payloadSha256, reason: 'file_digest_mismatch' };
  } catch {
    return { payloadValid: false, payloadSha256: null, reason: 'file_unreadable' };
  }
}

export function inspectKiwiWasmArtifact(runtime: Pick<Runtime, 'paths' | 'storage'>): KiwiWasmArtifactState {
  const manifest = readInstalledManifest(runtime);
  const payload = inspectPayload(runtime);
  return {
    targetDir: kiwiWasmDir(runtime),
    manifestPath: kiwiWasmManifestPath(runtime),
    wasmPath: kiwiWasmPath(runtime),
    // The manifest remains load-bearing for install provenance (when and from where);
    // a missing one is republished without downloading when the pinned payload digest is valid.
    installed: manifest !== null && payload.payloadValid,
    manifest,
    ...payload,
    reason: payload.reason ?? (manifest === null ? 'manifest_missing_or_invalid' : null),
  };
}

function createManifest(now: number): KiwiWasmArtifactManifest {
  return {
    schemaVersion: KIWI_WASM_MANIFEST_SCHEMA_VERSION,
    artifact: KIWI_WASM_ARTIFACT_KIND,
    packageId: KIWI_INSTALL_ONLY_ID,
    kiwiNlpVersion: KIWI_NLP_VERSION,
    sourceUrl: KIWI_NLP_PACKAGE_URL,
    archiveIntegrity: KIWI_NLP_PACKAGE_INTEGRITY,
    archiveSha256: KIWI_NLP_PACKAGE_SHA256,
    archiveSizeBytes: KIWI_NLP_PACKAGE_SIZE_BYTES,
    archiveEntry: KIWI_WASM_TAR_ENTRY,
    wasmSha256: KIWI_WASM_SHA256,
    wasmSizeBytes: KIWI_WASM_SIZE_BYTES,
    file: KIWI_WASM_FILE_NAME,
    installedAt: new Date(now).toISOString(),
  };
}

function removeNonRegularReservedTarget(runtime: Pick<Runtime, 'storage'>, path: string): void {
  try {
    const stat = runtime.storage.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      runtime.storage.rmSync(path, { recursive: true, force: true });
    }
  } catch (error: unknown) {
    if (!isNoEntryError(error)) {
      throw error;
    }
  }
}

function publishManifest(runtime: Runtime): void {
  const manifest = createManifest(runtime.time.now());
  const manifestPath = kiwiWasmManifestPath(runtime);
  removeNonRegularReservedTarget(runtime, manifestPath);
  const published = runtime.storage.writeAtomicDurableSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o644,
  });
  if (!published) {
    throw new Error('Kiwi WASM manifest could not be published durably');
  }
}

function sha512Integrity(input: Uint8Array): string {
  return `sha512-${createHash('sha512').update(input).digest('base64')}`;
}

export function verifyKiwiNlpArchive(archive: Buffer): void {
  if (archive.length !== KIWI_NLP_PACKAGE_SIZE_BYTES) {
    throw new Error(`Kiwi npm archive size mismatch: expected ${KIWI_NLP_PACKAGE_SIZE_BYTES}, got ${archive.length}`);
  }
  const digest = sha256Hex(archive);
  if (digest !== KIWI_NLP_PACKAGE_SHA256) {
    throw new Error(`Kiwi npm archive digest mismatch: expected ${KIWI_NLP_PACKAGE_SHA256}, got ${digest}`);
  }
  const integrity = sha512Integrity(archive);
  if (integrity !== KIWI_NLP_PACKAGE_INTEGRITY) {
    throw new Error(`Kiwi npm archive integrity mismatch: expected ${KIWI_NLP_PACKAGE_INTEGRITY}, got ${integrity}`);
  }
}

function verifyKiwiWasmPayload(wasm: Buffer): void {
  if (wasm.length !== KIWI_WASM_SIZE_BYTES) {
    throw new Error(`Kiwi WASM size mismatch: expected ${KIWI_WASM_SIZE_BYTES}, got ${wasm.length}`);
  }
  const digest = sha256Hex(wasm);
  if (digest !== KIWI_WASM_SHA256) {
    throw new Error(`Kiwi WASM digest mismatch: expected ${KIWI_WASM_SHA256}, got ${digest}`);
  }
}

export async function extractKiwiWasm(archive: Buffer, maxTarBytes = KIWI_WASM_TAR_MAX_BYTES): Promise<Buffer> {
  const entries = await extractTarGzEntriesInWorker(
    {
      archive,
      archiveLabel: 'Kiwi npm archive',
      maxTarBytes,
      entries: [{ key: 'wasm', exactPath: KIWI_WASM_TAR_ENTRY }],
      missingMessage: `Kiwi npm archive is missing ${KIWI_WASM_TAR_ENTRY}`,
    },
    { timeoutMs: KIWI_WASM_EXTRACTION_WORKER_TIMEOUT_MS },
  );
  const wasm = entries.get('wasm');
  if (wasm === undefined) {
    throw new Error(`Kiwi npm archive is missing ${KIWI_WASM_TAR_ENTRY}`);
  }
  return wasm;
}

export function publishKiwiWasmArtifact(runtime: Runtime, wasm: Buffer): KiwiWasmArtifactState {
  verifyKiwiWasmPayload(wasm);
  runtime.storage.mkdirSync(kiwiWasmDir(runtime), { recursive: true });
  const wasmPath = kiwiWasmPath(runtime);
  removeNonRegularReservedTarget(runtime, wasmPath);
  const published = runtime.storage.writeAtomicDurableSync(wasmPath, wasm, { mode: 0o644 });
  if (!published) {
    throw new Error('Kiwi WASM could not be published durably');
  }
  publishManifest(runtime);
  const installed = inspectKiwiWasmArtifact(runtime);
  if (!installed.installed) {
    throw new Error(`Kiwi WASM artifact failed post-install validation: ${installed.reason ?? 'unknown reason'}`);
  }
  return installed;
}

export async function ensureKiwiWasmArtifactLocked(
  runtime: Runtime,
  opts: KiwiWasmInstallOptions = {},
): Promise<KiwiWasmArtifactState> {
  const current = inspectKiwiWasmArtifact(runtime);
  if (current.installed) {
    return current;
  }

  runtime.storage.mkdirSync(kiwiWasmDir(runtime), { recursive: true });
  if (!current.payloadValid) {
    logInstallEvent(opts, 'expansion.install.download', `Downloading ${KIWI_NLP_PACKAGE_URL}`);
    const archive = await (opts.download ?? downloadBuffer)(runtime, KIWI_NLP_PACKAGE_URL, {
      maxBytes: KIWI_NLP_PACKAGE_SIZE_BYTES,
    });
    verifyKiwiNlpArchive(archive);

    logInstallEvent(opts, 'expansion.install.extract', `Extracting ${KIWI_WASM_TAR_ENTRY}`);
    const wasm = await (opts.extract ?? extractKiwiWasm)(archive);

    logInstallEvent(opts, 'expansion.install.write', 'Installing Kiwi WASM');
    return publishKiwiWasmArtifact(runtime, wasm);
  }

  publishManifest(runtime);
  const installed = inspectKiwiWasmArtifact(runtime);
  if (!installed.installed) {
    throw new Error(`Kiwi WASM artifact failed post-install validation: ${installed.reason ?? 'unknown reason'}`);
  }
  return installed;
}
