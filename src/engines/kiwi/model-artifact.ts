import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as timers from 'node:timers';
import { Worker } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';

import { downloadBuffer } from '#src/runtime/download.js';
import { sha256Hex } from '../../infra/hash.js';
import { isRecord } from '../../infra/json.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Runtime } from '../../runtime/ports.js';
import { extractTarGzEntriesInWorker } from '../../infra/archive-extraction-worker.js';
import {
  KIWI_INSTALL_ONLY_ID,
  KIWI_MODEL_ARCHIVE_SIZE_BYTES,
  KIWI_MODEL_FILES,
  KIWI_MODEL_SHA256,
  KIWI_MODEL_TAR_PREFIX,
  KIWI_MODEL_TYPE,
  KIWI_MODEL_URL,
  KIWI_MODEL_VERSION,
  KIWI_NLP_VERSION,
  type KiwiModelFileName,
} from './constants.js';
import { kiwiDataDir, kiwiModelDir, kiwiModelFilePath, kiwiModelManifestPath } from './paths.js';
import { withKiwiPackageOperationLock } from './operation-lock.js';

const TAR_BLOCK_SIZE = 512;
const TAR_FILE_TYPES = new Set(['0', '']);
const INSTALL_PATH_UNWRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']);
export const KIWI_MODEL_TAR_MAX_BYTES = 512 * 1024 * 1024;
const KIWI_MODEL_EXTRACTION_WORKER_TIMEOUT_MS = 60_000;
const KIWI_MODEL_WRITE_WORKER_TIMEOUT_MS = 60_000;

const KIWI_MODEL_WRITE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function errorCode(error) {
  return error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function renameExistingTarget(targetDir, backupDir) {
  try {
    renameSync(targetDir, backupDir);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function restoreBackup(targetDir, backupDir) {
  if (!existsSync(targetDir) && existsSync(backupDir)) {
    renameSync(backupDir, targetDir);
  }
}

function writeModelFiles() {
  const targetDir = workerData.targetDir;
  const backupDir = workerData.backupDir;
  const stagingDir = workerData.stagingDir;
  mkdirSync(workerData.parentDir, { recursive: true });
  rmSync(stagingDir, { recursive: true, force: true });
  rmSync(backupDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  let targetBackedUp = false;
  try {
    for (const file of workerData.files) {
      writeFileSync(join(stagingDir, file.name), Buffer.from(file.data));
    }
    writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify(workerData.manifest, null, 2) + '\\n', {
      encoding: 'utf-8',
    });
    targetBackedUp = renameExistingTarget(targetDir, backupDir);
    renameSync(stagingDir, targetDir);
    rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    if (targetBackedUp) {
      restoreBackup(targetDir, backupDir);
    }
    throw error;
  }
}

try {
  writeModelFiles();
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    code: errorCode(error),
  });
}
`;

export type KiwiModelArtifactManifest = {
  readonly packageId: typeof KIWI_INSTALL_ONLY_ID;
  readonly kiwiNlpVersion: string;
  readonly modelVersion: string;
  readonly modelType: typeof KIWI_MODEL_TYPE;
  readonly sourceUrl: string;
  readonly archiveSha256: string;
  readonly archiveSizeBytes: number;
  readonly files: readonly KiwiModelFileName[];
  readonly installedAt: string;
};

export type KiwiModelArtifactState = {
  readonly targetDir: string;
  readonly manifestPath: string;
  readonly installed: boolean;
  readonly manifest: KiwiModelArtifactManifest | null;
  readonly missingFiles: readonly string[];
};

export type KiwiModelArtifactInstallResult =
  | {
      readonly status: 'installed' | 'updated' | 'already_installed' | 'already_up_to_date';
      readonly method: 'github-release';
      readonly version: string;
      readonly targetDir: string;
    }
  | {
      readonly status: 'error';
      readonly code: string;
      readonly userMessage: string;
      readonly remediation: string;
      readonly context?: Record<string, unknown>;
    };

type KiwiModelInstallOptions = {
  readonly update?: boolean;
  readonly lockTimeoutMs?: number;
  readonly logger?: (event: { readonly kind: string; readonly message: string }) => void;
  readonly operationLockHeld?: true;
};

type KiwiModelWriteWorkerFile = {
  readonly name: KiwiModelFileName;
  readonly data: ArrayBuffer;
};

type KiwiModelWriteWorkerRequest = {
  readonly targetDir: string;
  readonly parentDir: string;
  readonly stagingDir: string;
  readonly backupDir: string;
  readonly manifest: KiwiModelArtifactManifest;
  readonly files: readonly KiwiModelWriteWorkerFile[];
};

type KiwiModelWriteWorkerSuccess = {
  readonly ok: true;
};

type KiwiModelWriteWorkerFailure = {
  readonly ok: false;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
};

type KiwiModelWriteWorkerReply = KiwiModelWriteWorkerSuccess | KiwiModelWriteWorkerFailure;

function logInstallEvent(opts: KiwiModelInstallOptions, kind: string, message: string): void {
  opts.logger?.({ kind, message });
}

function toInstallError(
  code: Parameters<typeof documentedCoralSetupError>[0],
  context: Parameters<typeof documentedCoralSetupError>[1],
): Extract<KiwiModelArtifactInstallResult, { status: 'error' }> {
  const error = documentedCoralSetupError(code, context);
  return {
    status: 'error',
    code: error.code,
    userMessage: error.userMessage,
    remediation: error.remediation,
    ...(error.context === undefined ? {} : { context: error.context }),
  };
}

function isInstallPathUnwritableError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    INSTALL_PATH_UNWRITABLE_CODES.has(String((error as NodeJS.ErrnoException).code))
  );
}

function isFile(runtime: Pick<Runtime, 'storage'>, path: string): boolean {
  try {
    return runtime.storage.statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(runtime: Pick<Runtime, 'storage'>, path: string): boolean {
  try {
    return runtime.storage.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isKiwiModelArtifactManifest(value: unknown): value is KiwiModelArtifactManifest {
  const files = isRecord(value) && Array.isArray(value.files) ? value.files : null;
  return (
    isRecord(value) &&
    value.packageId === KIWI_INSTALL_ONLY_ID &&
    value.kiwiNlpVersion === KIWI_NLP_VERSION &&
    value.modelVersion === KIWI_MODEL_VERSION &&
    value.modelType === KIWI_MODEL_TYPE &&
    value.sourceUrl === KIWI_MODEL_URL &&
    value.archiveSha256 === KIWI_MODEL_SHA256 &&
    value.archiveSizeBytes === KIWI_MODEL_ARCHIVE_SIZE_BYTES &&
    files !== null &&
    files.length === KIWI_MODEL_FILES.length &&
    KIWI_MODEL_FILES.every((fileName) => files.includes(fileName)) &&
    typeof value.installedAt === 'string'
  );
}

function readInstalledManifest(runtime: Pick<Runtime, 'paths' | 'storage'>): KiwiModelArtifactManifest | null {
  try {
    const parsed = JSON.parse(runtime.storage.readFileSync(kiwiModelManifestPath(runtime), 'utf-8')) as unknown;
    return isKiwiModelArtifactManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function inspectKiwiModelArtifact(runtime: Pick<Runtime, 'paths' | 'storage'>): KiwiModelArtifactState {
  const manifest = readInstalledManifest(runtime);
  const missingFiles = KIWI_MODEL_FILES.filter((fileName) => !isFile(runtime, kiwiModelFilePath(runtime, fileName)));
  return {
    targetDir: kiwiModelDir(runtime),
    manifestPath: kiwiModelManifestPath(runtime),
    installed: manifest !== null && missingFiles.length === 0,
    manifest,
    missingFiles,
  };
}

export function hasKiwiModelArtifact(runtime: Pick<Runtime, 'paths' | 'storage'>): boolean {
  return inspectKiwiModelArtifact(runtime).installed;
}

export function hasKiwiDurableState(runtime: Pick<Runtime, 'paths' | 'storage'>): boolean {
  const dataDir = kiwiDataDir(runtime);
  if (!isDirectory(runtime, dataDir)) {
    return false;
  }
  try {
    return runtime.storage.readdirSync(dataDir, { withFileTypes: true }).some((entry) => entry.name !== 'install.lock');
  } catch {
    return false;
  }
}

function tarFieldToString(buffer: Buffer): string {
  return buffer.toString('utf-8').replace(/\0.*$/, '').trim();
}

function tarFieldToNumber(buffer: Buffer): number {
  const raw = tarFieldToString(buffer);
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

function gunzipKiwiModelTar(archiveBuffer: Buffer, maxTarBytes: number): Buffer {
  try {
    return gunzipSync(archiveBuffer, { maxOutputLength: maxTarBytes });
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`Kiwi model archive exceeds maximum decompressed size (${maxTarBytes} bytes)`, {
        cause: error,
      });
    }
    throw error;
  }
}

function readTarEntrySize(header: Buffer, fullName: string): number {
  const size = tarFieldToNumber(header.subarray(124, 136));
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Kiwi model archive entry has invalid size: ${fullName || '<unnamed>'}`);
  }
  return size;
}

function tarEntryNextOffset(dataOffset: number, size: number, tarLength: number, fullName: string): number {
  const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  const dataEnd = dataOffset + size;
  const nextOffset = dataOffset + paddedSize;
  if (dataEnd > tarLength || nextOffset > tarLength) {
    throw new Error(`Kiwi model archive entry exceeds archive bounds: ${fullName || '<unnamed>'}`);
  }
  return nextOffset;
}

export function extractKiwiModelFiles(
  archiveBuffer: Buffer,
  maxTarBytes = KIWI_MODEL_TAR_MAX_BYTES,
): ReadonlyMap<KiwiModelFileName, Buffer> {
  const tarBuffer = gunzipKiwiModelTar(archiveBuffer, maxTarBytes);
  let offset = 0;
  const required = new Set<string>(KIWI_MODEL_FILES);
  const files = new Map<KiwiModelFileName, Buffer>();

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = tarFieldToString(header.subarray(0, 100));
    const prefix = tarFieldToString(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = readTarEntrySize(header, fullName);
    const typeFlag = header[156] === 0 ? '' : String.fromCharCode(header[156]);
    offset += TAR_BLOCK_SIZE;
    const nextOffset = tarEntryNextOffset(offset, size, tarBuffer.length, fullName);

    const data = tarBuffer.subarray(offset, offset + size);
    if (TAR_FILE_TYPES.has(typeFlag) && fullName.startsWith(KIWI_MODEL_TAR_PREFIX)) {
      const fileName = fullName.slice(KIWI_MODEL_TAR_PREFIX.length);
      if (required.has(fileName) && !fileName.includes('/')) {
        files.set(fileName as KiwiModelFileName, Buffer.from(data));
      }
    }

    offset = nextOffset;
  }

  const missing = KIWI_MODEL_FILES.filter((fileName) => !files.has(fileName));
  if (missing.length > 0) {
    throw new Error(`Kiwi model archive is missing required files: ${missing.join(', ')}`);
  }

  return files;
}

export async function extractKiwiModelFilesInWorker(
  archiveBuffer: Buffer,
  maxTarBytes = KIWI_MODEL_TAR_MAX_BYTES,
): Promise<ReadonlyMap<KiwiModelFileName, Buffer>> {
  const extracted = await extractTarGzEntriesInWorker(
    {
      archive: archiveBuffer,
      archiveLabel: 'Kiwi model archive',
      maxTarBytes,
      entries: KIWI_MODEL_FILES.map((fileName) => ({
        key: fileName,
        exactPath: `${KIWI_MODEL_TAR_PREFIX}${fileName}`,
      })),
      missingMessage: `Kiwi model archive is missing required files: ${KIWI_MODEL_FILES.join(', ')}`,
    },
    { timeoutMs: KIWI_MODEL_EXTRACTION_WORKER_TIMEOUT_MS },
  );

  const files = new Map<KiwiModelFileName, Buffer>();
  for (const fileName of KIWI_MODEL_FILES) {
    const content = extracted.get(fileName);
    if (content === undefined) {
      throw new Error(`Kiwi model file ${fileName} was not extracted.`);
    }
    files.set(fileName, content);
  }
  return files;
}

function createManifest(now: number): KiwiModelArtifactManifest {
  return {
    packageId: KIWI_INSTALL_ONLY_ID,
    kiwiNlpVersion: KIWI_NLP_VERSION,
    modelVersion: KIWI_MODEL_VERSION,
    modelType: KIWI_MODEL_TYPE,
    sourceUrl: KIWI_MODEL_URL,
    archiveSha256: KIWI_MODEL_SHA256,
    archiveSizeBytes: KIWI_MODEL_ARCHIVE_SIZE_BYTES,
    files: [...KIWI_MODEL_FILES],
    installedAt: new Date(now).toISOString(),
  };
}

function isKiwiModelWriteWorkerReply(value: unknown): value is KiwiModelWriteWorkerReply {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return false;
  }
  const reply = value as { ok?: unknown; message?: unknown };
  return reply.ok === true || (reply.ok === false && typeof reply.message === 'string');
}

function kiwiModelWriteWorkerFailureToError(reply: KiwiModelWriteWorkerFailure): Error {
  const error = new Error(reply.message) as NodeJS.ErrnoException;
  if (reply.stack !== undefined) {
    error.stack = reply.stack;
  }
  if (reply.code !== undefined) {
    error.code = reply.code;
  }
  return error;
}

function arrayBufferForWorker(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

function prepareKiwiModelWriteWorkerFiles(modelFiles: ReadonlyMap<KiwiModelFileName, Buffer>): {
  readonly files: readonly KiwiModelWriteWorkerFile[];
  readonly transferList: ArrayBuffer[];
} {
  const files: KiwiModelWriteWorkerFile[] = [];
  const transferList: ArrayBuffer[] = [];
  for (const fileName of KIWI_MODEL_FILES) {
    const content = modelFiles.get(fileName);
    if (content === undefined) {
      throw new Error(`Kiwi model file ${fileName} was not extracted.`);
    }
    const data = arrayBufferForWorker(content);
    files.push({ name: fileName, data });
    transferList.push(data);
  }
  return { files, transferList };
}

function restoreKiwiModelBackup(targetDir: string, backupDir: string): void {
  if (!existsSync(targetDir) && existsSync(backupDir)) {
    renameSync(backupDir, targetDir);
  }
}

function cleanupKiwiModelWriteFailure(request: KiwiModelWriteWorkerRequest): void {
  rmSync(request.stagingDir, { recursive: true, force: true });
  restoreKiwiModelBackup(request.targetDir, request.backupDir);
  if (existsSync(request.targetDir)) {
    rmSync(request.backupDir, { recursive: true, force: true });
  }
}

async function runKiwiModelWriteWorker(
  request: KiwiModelWriteWorkerRequest,
  transferList: ArrayBuffer[],
  timeoutMs = KIWI_MODEL_WRITE_WORKER_TIMEOUT_MS,
): Promise<void> {
  const worker = new Worker(KIWI_MODEL_WRITE_WORKER_SOURCE, {
    eval: true,
    transferList,
    workerData: request,
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = timers.setTimeout(() => {
      settleAfterTerminate(reject, new Error(`Kiwi model file install worker timed out after ${timeoutMs}ms`), true);
    }, timeoutMs);

    function cleanup(): void {
      timers.clearTimeout(timeout);
      worker.removeAllListeners('message');
      worker.removeAllListeners('error');
      worker.removeAllListeners('exit');
    }

    function settleAfterTerminate<T>(done: (value: T) => void, value: T, cleanupArtifacts: boolean): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void worker
        .terminate()
        .catch(() => undefined)
        .then(() => {
          let finalValue = value;
          try {
            if (cleanupArtifacts) {
              cleanupKiwiModelWriteFailure(request);
            }
          } catch (cleanupError: unknown) {
            finalValue = cleanupError as T;
          }
          done(finalValue);
        });
    }

    worker.once('message', (message: unknown) => {
      if (!isKiwiModelWriteWorkerReply(message)) {
        settleAfterTerminate(reject, new Error('Kiwi model file install worker returned an invalid response'), true);
        return;
      }
      if (!message.ok) {
        settleAfterTerminate(reject, kiwiModelWriteWorkerFailureToError(message), true);
        return;
      }
      settleAfterTerminate(resolve, undefined, false);
    });

    worker.once('error', (error) => {
      settleAfterTerminate(reject, error, true);
    });

    worker.once('exit', (code) => {
      const message =
        code === 0
          ? 'Kiwi model file install worker exited before returning a response'
          : `Kiwi model file install worker exited with code ${code}`;
      settleAfterTerminate(reject, new Error(message), true);
    });
  });
}

export async function writeKiwiModelFilesAtomicInWorker(
  runtime: Pick<Runtime, 'env' | 'ids' | 'paths' | 'time'>,
  modelFiles: ReadonlyMap<KiwiModelFileName, Buffer>,
): Promise<KiwiModelArtifactManifest> {
  const targetDir = kiwiModelDir(runtime);
  const parentDir = dirname(targetDir);
  const installToken = `${runtime.env.pid()}-${runtime.ids.uuid()}`;
  const stagingDir = join(parentDir, `.cong-base-${installToken}.part`);
  const backupDir = join(parentDir, `.cong-base-${installToken}.previous`);
  const manifest = createManifest(runtime.time.now());
  const { files, transferList } = prepareKiwiModelWriteWorkerFiles(modelFiles);

  await runKiwiModelWriteWorker({ targetDir, parentDir, stagingDir, backupDir, manifest, files }, transferList);
  return manifest;
}

async function installDownloadedModel(
  runtime: Runtime,
  opts: KiwiModelInstallOptions,
): Promise<KiwiModelArtifactInstallResult> {
  logInstallEvent(opts, 'expansion.install.download', `Downloading ${KIWI_MODEL_URL}`);
  const archive = await downloadBuffer(runtime, KIWI_MODEL_URL, { maxBytes: KIWI_MODEL_ARCHIVE_SIZE_BYTES });
  const digest = sha256Hex(archive);
  if (digest !== KIWI_MODEL_SHA256) {
    throw new Error(`Kiwi model archive digest mismatch: expected ${KIWI_MODEL_SHA256}, got ${digest}`);
  }

  logInstallEvent(opts, 'expansion.install.extract', 'Extracting Kiwi model files');
  const modelFiles = await extractKiwiModelFilesInWorker(archive);
  logInstallEvent(opts, 'expansion.install.write', 'Installing Kiwi model files');
  await writeKiwiModelFilesAtomicInWorker(runtime, modelFiles);
  return {
    status: opts.update === true ? 'updated' : 'installed',
    method: 'github-release',
    version: KIWI_MODEL_VERSION,
    targetDir: kiwiDataDir(runtime),
  };
}

export async function ensureKiwiModelArtifact(
  runtime: Runtime,
  opts: KiwiModelInstallOptions = {},
): Promise<KiwiModelArtifactInstallResult> {
  try {
    return await withKiwiPackageOperationLock(runtime, opts, async () => {
      const current = inspectKiwiModelArtifact(runtime);
      if (current.installed) {
        return {
          status: opts.update === true ? 'already_up_to_date' : 'already_installed',
          method: 'github-release',
          version: KIWI_MODEL_VERSION,
          targetDir: kiwiDataDir(runtime),
        };
      }

      return installDownloadedModel(runtime, opts);
    });
  } catch (error: unknown) {
    if (isInstallPathUnwritableError(error)) {
      return toInstallError('expansion_install_path_unwritable', { name: KIWI_INSTALL_ONLY_ID });
    }
    throw error;
  }
}
