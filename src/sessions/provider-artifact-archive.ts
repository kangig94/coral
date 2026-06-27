import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';

import type { ArtifactCleanupRuntime } from '../providers/contract.js';
import type { ProviderArtifactHandle, SessionEntry } from './entry.js';

const ARCHIVE_SCHEMA_VERSION = 1;
const ARTIFACT_DIR_NAME = 'provider-artifacts';
const STABLE_READ_ATTEMPTS = 4;
const STABLE_READ_SETTLE_MS = 500;

type ArchiveArtifactStatus = 'archived' | 'missing' | 'failed';

type ArchiveArtifactRecord = {
  readonly sourceHandle: string;
  readonly archivePath?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly status: ArchiveArtifactStatus;
  readonly error?: string;
  readonly identity?: ProviderArtifactHandle['identity'];
  readonly sourceJobId?: string;
};

type ArchiveManifest = {
  readonly schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  readonly jobId: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly archivedAt: string;
  readonly artifacts: readonly ArchiveArtifactRecord[];
};

export type ProviderArtifactArchiveResult = {
  readonly manifestPath: string;
  readonly artifacts: readonly ArchiveArtifactRecord[];
};

export async function archiveProviderArtifactsForJob(options: {
  readonly runtime: ArtifactCleanupRuntime;
  readonly entry: SessionEntry;
  readonly provider: string;
  readonly jobId: string;
  readonly handles: readonly string[];
  readonly archivedAt: string;
}): Promise<ProviderArtifactArchiveResult> {
  const { runtime, entry, provider, jobId, handles, archivedAt } = options;
  const archiveDir = join(
    runtime.paths.coral.exports.jobsRoot,
    jobId,
    ARTIFACT_DIR_NAME,
    sanitizePathSegment(provider),
  );
  runtime.storage.mkdirSync(archiveDir, { recursive: true });

  const metadataByHandle = new Map(entry.artifactHandles.map((artifact) => [artifact.handle, artifact]));
  const artifacts = await Promise.all(
    handles.map((handle, index) =>
      archiveOneProviderArtifact({
        runtime,
        archiveDir,
        handle,
        index,
        metadata: metadataByHandle.get(handle),
      }),
    ),
  );
  const manifest: ArchiveManifest = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    jobId,
    sessionId: entry.sessionId,
    provider,
    archivedAt,
    artifacts,
  };
  const manifestPath = join(archiveDir, 'manifest.json');
  const manifestWritten = runtime.storage.writeAtomicSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  if (!manifestWritten) {
    throw new Error(`Failed to write provider artifact archive manifest for job ${jobId}`);
  }
  return { manifestPath, artifacts };
}

async function archiveOneProviderArtifact(options: {
  readonly runtime: ArtifactCleanupRuntime;
  readonly archiveDir: string;
  readonly handle: string;
  readonly index: number;
  readonly metadata: ProviderArtifactHandle | undefined;
}): Promise<ArchiveArtifactRecord> {
  const { runtime, archiveDir, handle, index, metadata } = options;
  const source = {
    sourceHandle: handle,
    ...(metadata?.identity === undefined ? {} : { identity: metadata.identity }),
    ...(metadata?.sourceJobId === undefined ? {} : { sourceJobId: metadata.sourceJobId }),
  };

  try {
    const content = await readStableUtf8File(runtime, handle);
    const archivePath = join(archiveDir, `${String(index + 1).padStart(4, '0')}-${safeArtifactFileName(handle)}`);
    const written = runtime.storage.writeAtomicSync(archivePath, content, { encoding: 'utf-8', mode: 0o600 });
    if (!written) {
      return { ...source, status: 'failed', error: 'archive write failed' };
    }
    return {
      ...source,
      archivePath,
      bytes: Buffer.byteLength(content, 'utf-8'),
      sha256: createHash('sha256').update(content, 'utf-8').digest('hex'),
      status: 'archived',
    };
  } catch (error: unknown) {
    const code = typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code : '';
    return {
      ...source,
      status: code === 'ENOENT' ? 'missing' : 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readStableUtf8File(runtime: ArtifactCleanupRuntime, handle: string): Promise<string> {
  let previousContent: string | null = null;
  for (let attempt = 1; attempt <= STABLE_READ_ATTEMPTS; attempt += 1) {
    const stats = runtime.storage.statSync(handle);
    if (!stats.isFile()) {
      throw new Error('source is not a file');
    }
    const content = runtime.storage.readFileSync(handle, 'utf-8');
    if (previousContent !== null && content === previousContent) {
      return content;
    }
    previousContent = content;
    if (attempt < STABLE_READ_ATTEMPTS) {
      await runtime.time.sleep(STABLE_READ_SETTLE_MS);
    }
  }

  return previousContent ?? '';
}

function safeArtifactFileName(handle: string): string {
  const name = basename(handle) || 'artifact.log';
  const sanitized = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'artifact.log';
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'provider';
}
