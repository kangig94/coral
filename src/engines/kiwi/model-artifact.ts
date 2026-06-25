import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { downloadBuffer } from '#src/runtime/download.js';
import { acquireDirectoryLock, isDirectoryLockTimeoutError } from '../../infra/fs-lock.js';
import { sha256Hex } from '../../infra/hash.js';
import { isRecord } from '../../infra/json.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Runtime } from '../../runtime/ports.js';
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

const KIWI_INSTALL_LOCK_TIMEOUT_MS = 250;
const TAR_BLOCK_SIZE = 512;
const TAR_FILE_TYPES = new Set(['0', '']);
const INSTALL_PATH_UNWRITABLE_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOSPC']);

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
};

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

async function withInstallLock<T>(
  runtime: Runtime,
  opts: KiwiModelInstallOptions,
  run: () => Promise<T>,
): Promise<T | Extract<KiwiModelArtifactInstallResult, { status: 'error' }>> {
  const dataDir = kiwiDataDir(runtime);
  runtime.storage.mkdirSync(dataDir, { recursive: true });

  let release: () => void;
  try {
    release = await acquireDirectoryLock(
      runtime.paths.coral.engine.installLockPath(KIWI_INSTALL_ONLY_ID),
      { storage: runtime.storage, time: runtime.time },
      opts.lockTimeoutMs ?? KIWI_INSTALL_LOCK_TIMEOUT_MS,
    );
  } catch (error: unknown) {
    if (isDirectoryLockTimeoutError(error)) {
      return toInstallError('expansion_install_lock_contended', { name: KIWI_INSTALL_ONLY_ID });
    }
    throw error;
  }

  try {
    return await run();
  } finally {
    release();
  }
}

function tarFieldToString(buffer: Buffer): string {
  return buffer.toString('utf-8').replace(/\0.*$/, '').trim();
}

function tarFieldToNumber(buffer: Buffer): number {
  const raw = tarFieldToString(buffer);
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

function extractKiwiModelFiles(archiveBuffer: Buffer): ReadonlyMap<KiwiModelFileName, Buffer> {
  const tarBuffer = gunzipSync(archiveBuffer);
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
    const size = tarFieldToNumber(header.subarray(124, 136));
    const typeFlag = header[156] === 0 ? '' : String.fromCharCode(header[156]);
    offset += TAR_BLOCK_SIZE;

    const data = tarBuffer.subarray(offset, offset + size);
    if (TAR_FILE_TYPES.has(typeFlag) && fullName.startsWith(KIWI_MODEL_TAR_PREFIX)) {
      const fileName = fullName.slice(KIWI_MODEL_TAR_PREFIX.length);
      if (required.has(fileName) && !fileName.includes('/')) {
        files.set(fileName as KiwiModelFileName, Buffer.from(data));
      }
    }

    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  const missing = KIWI_MODEL_FILES.filter((fileName) => !files.has(fileName));
  if (missing.length > 0) {
    throw new Error(`Kiwi model archive is missing required files: ${missing.join(', ')}`);
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

function writeModelFilesAtomic(
  runtime: Runtime,
  modelFiles: ReadonlyMap<KiwiModelFileName, Buffer>,
): KiwiModelArtifactManifest {
  const targetDir = kiwiModelDir(runtime);
  const parentDir = dirname(targetDir);
  const stagingDir = join(parentDir, `.cong-base-${runtime.env.pid()}-${Date.now()}.part`);
  runtime.storage.mkdirSync(parentDir, { recursive: true });
  runtime.storage.rmSync(stagingDir, { recursive: true, force: true });
  runtime.storage.mkdirSync(stagingDir, { recursive: true });

  try {
    for (const fileName of KIWI_MODEL_FILES) {
      const content = modelFiles.get(fileName);
      if (content === undefined) {
        throw new Error(`Kiwi model file ${fileName} was not extracted.`);
      }
      runtime.storage.writeFileSync(join(stagingDir, fileName), content);
    }

    const manifest = createManifest(runtime.time.now());
    runtime.storage.writeFileSync(join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      encoding: 'utf-8',
    });
    runtime.storage.rmSync(targetDir, { recursive: true, force: true });
    runtime.storage.renameSync(stagingDir, targetDir);
    return manifest;
  } catch (error: unknown) {
    runtime.storage.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
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

  const modelFiles = extractKiwiModelFiles(archive);
  writeModelFilesAtomic(runtime, modelFiles);
  return {
    status: opts.update === true ? 'updated' : 'installed',
    method: 'github-release',
    version: KIWI_MODEL_VERSION,
    targetDir: kiwiModelDir(runtime),
  };
}

export async function ensureKiwiModelArtifact(
  runtime: Runtime,
  opts: KiwiModelInstallOptions = {},
): Promise<KiwiModelArtifactInstallResult> {
  try {
    return await withInstallLock(runtime, opts, async () => {
      const current = inspectKiwiModelArtifact(runtime);
      if (current.installed) {
        return {
          status: opts.update === true ? 'already_up_to_date' : 'already_installed',
          method: 'github-release',
          version: KIWI_MODEL_VERSION,
          targetDir: current.targetDir,
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
