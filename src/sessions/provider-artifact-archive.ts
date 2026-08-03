import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { z } from 'zod';

import { providerArtifactIdentitySchema, type ProviderArtifactIdentity } from '../providers/artifact-identity.js';
import type { ArtifactCleanupRuntime } from '../providers/contract.js';
import type { ProviderSession } from './entry.js';
import { providerSessionProvider } from './entry.js';
import type { EventsRow } from '../store/schema.js';

const ARCHIVE_SCHEMA_VERSION = 2;
const ARTIFACT_DIR_NAME = 'provider-artifacts';
const ACTIONS_DIR_NAME = 'actions';
const STABLE_READ_ATTEMPTS = 4;
const STABLE_READ_SETTLE_MS = 500;

export type CanonicalProviderArtifactHandle = {
  readonly handle: string;
  readonly sourceJobId: string;
  readonly identity?: ProviderArtifactIdentity;
};

export type ProviderArtifactActionDescriptor = {
  readonly operationId: string;
  readonly sessionId: string;
  readonly jobId: string;
  readonly provider: string;
  readonly sourceRevision: string;
  readonly handles: readonly CanonicalProviderArtifactHandle[];
  readonly archiveActionId: string;
  readonly archivePayloadHash: string;
  readonly discardActionId: string;
  readonly discardPayloadHash: string;
  readonly archivedAt: string;
};

const canonicalHandleSchema = z
  .object({
    handle: z.string().min(1),
    sourceJobId: z.string().min(1),
    identity: providerArtifactIdentitySchema.optional(),
  })
  .strict();

const archiveArtifactRecordSchema = z
  .object({
    sourceHandle: z.string().min(1),
    sourceJobId: z.string().min(1),
    identity: providerArtifactIdentitySchema.optional(),
    archivePath: z.string().min(1).optional(),
    bytes: z.number().int().nonnegative().optional(),
    sourceSha256: z.string().min(1).optional(),
    archiveSha256: z.string().min(1).optional(),
    status: z.enum(['archived', 'missing', 'failed']),
    error: z.string().optional(),
  })
  .strict();

type ArchiveArtifactRecord = z.infer<typeof archiveArtifactRecordSchema>;

const archiveManifestSchema = z
  .object({
    schemaVersion: z.literal(ARCHIVE_SCHEMA_VERSION),
    archiveActionId: z.string().min(1),
    archivePayloadHash: z.string().min(1),
    sourceRevision: z.string().min(1),
    canonicalHandles: z.array(canonicalHandleSchema).readonly(),
    jobId: z.string().min(1),
    sessionId: z.string().min(1),
    provider: z.string().min(1),
    archivedAt: z.string().datetime({ offset: true }),
    artifacts: z.array(archiveArtifactRecordSchema),
  })
  .strict();

type ArchiveManifest = z.infer<typeof archiveManifestSchema>;

export type ProviderArtifactArchiveResult = {
  readonly manifestPath: string;
  readonly artifacts: readonly ArchiveArtifactRecord[];
};

/** Fail-closed contradiction in an action identity, payload, or verified archive hash. */
export class ProviderArtifactArchiveInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderArtifactArchiveInvariantError';
  }
}

function hash(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function canonicalHandles(
  entry: ProviderSession,
  jobId: string,
  handles: readonly string[],
): readonly CanonicalProviderArtifactHandle[] {
  const metadataByHandle = new Map(entry.artifactHandles.map((artifact) => [artifact.handle, artifact]));
  return [...new Set(handles)]
    .map((handle) => {
      const metadata = metadataByHandle.get(handle);
      return {
        handle,
        sourceJobId: metadata?.sourceJobId ?? jobId,
        ...(metadata?.identity === undefined ? {} : { identity: metadata.identity }),
      };
    })
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

/** Derives stable archive/discard identities from the complete persisted action inputs. */
export function deriveProviderArtifactActionDescriptor(options: {
  readonly entry: ProviderSession;
  readonly jobId: string;
  readonly handles: readonly string[];
  readonly sourceRevision: string;
  readonly archivedAt: string;
}): ProviderArtifactActionDescriptor {
  const provider = providerSessionProvider(options.entry);
  const handles = canonicalHandles(options.entry, options.jobId, options.handles);
  const operationId = hash(
    stableJson({
      v: 1,
      sessionId: options.entry.sessionId,
      jobId: options.jobId,
      provider,
      sourceRevision: options.sourceRevision,
      handles,
    }),
  );
  const archiveActionId = `archive-${hash(`${operationId}\u0000session.retention.archive`).slice('sha256:'.length)}`;
  const discardActionId = `discard-${hash(`${operationId}\u0000session.retention.provider-discard`).slice('sha256:'.length)}`;
  return {
    operationId,
    sessionId: options.entry.sessionId,
    jobId: options.jobId,
    provider,
    sourceRevision: options.sourceRevision,
    handles,
    archiveActionId,
    archivePayloadHash: hash(
      stableJson({ actionId: archiveActionId, sourceRevision: options.sourceRevision, handles }),
    ),
    discardActionId,
    discardPayloadHash: hash(stableJson({ actionId: discardActionId, handles: handles.map(({ handle }) => handle) })),
    archivedAt: options.archivedAt,
  };
}

/** Hashes the immutable release/terminal envelopes shared by retention and on-demand cleanup. */
export function deriveProviderArtifactSourceRevision(options: {
  readonly sessionId: string;
  readonly jobId: string;
  readonly release: EventsRow;
  readonly terminal: EventsRow;
}): string {
  if (
    options.release.type !== 'session.claim.released' ||
    options.release.stream_id !== options.sessionId ||
    options.terminal.type !== 'job.terminal.recorded' ||
    options.terminal.stream_id !== options.jobId
  ) {
    throw new ProviderArtifactArchiveInvariantError(
      `Provider artifact source envelope contradicts ${options.sessionId}/${options.jobId}.`,
    );
  }
  return hash(
    stableJson({
      v: 1,
      sessionId: options.sessionId,
      jobId: options.jobId,
      release: options.release,
      terminal: options.terminal,
    }),
  );
}

function providerActionsRoot(runtime: ArtifactCleanupRuntime, descriptor: ProviderArtifactActionDescriptor): string {
  return join(
    runtime.paths.coral.exports.jobsRoot,
    descriptor.jobId,
    ARTIFACT_DIR_NAME,
    sanitizePathSegment(descriptor.provider),
    ACTIONS_DIR_NAME,
  );
}

function actionArchiveDir(runtime: ArtifactCleanupRuntime, descriptor: ProviderArtifactActionDescriptor): string {
  return join(providerActionsRoot(runtime, descriptor), sanitizePathSegment(descriptor.archiveActionId));
}

function readManifest(runtime: ArtifactCleanupRuntime, path: string): ArchiveManifest | null {
  try {
    return archiveManifestSchema.parse(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')) as unknown);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ProviderArtifactArchiveInvariantError(
      `Provider artifact archive manifest '${path}' is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertManifestIdentity(manifest: ArchiveManifest, descriptor: ProviderArtifactActionDescriptor): void {
  if (
    manifest.archiveActionId !== descriptor.archiveActionId ||
    manifest.archivePayloadHash !== descriptor.archivePayloadHash ||
    manifest.sourceRevision !== descriptor.sourceRevision ||
    manifest.jobId !== descriptor.jobId ||
    manifest.sessionId !== descriptor.sessionId ||
    manifest.provider !== descriptor.provider ||
    stableJson(manifest.canonicalHandles) !== stableJson(descriptor.handles)
  ) {
    throw new ProviderArtifactArchiveInvariantError(
      `Provider artifact archive action '${descriptor.archiveActionId}' has a conflicting payload.`,
    );
  }
}

function matchingMetadata(record: ArchiveArtifactRecord, handle: CanonicalProviderArtifactHandle): boolean {
  return (
    record.sourceHandle === handle.handle &&
    record.sourceJobId === handle.sourceJobId &&
    stableJson(record.identity ?? null) === stableJson(handle.identity ?? null)
  );
}

function verifiedArchivedRecord(
  runtime: ArtifactCleanupRuntime,
  record: ArchiveArtifactRecord | undefined,
  handle: CanonicalProviderArtifactHandle,
): ArchiveArtifactRecord | null {
  if (record?.status !== 'archived' || !matchingMetadata(record, handle)) return null;
  if (record.archivePath === undefined || record.archiveSha256 === undefined || record.sourceSha256 === undefined) {
    throw new ProviderArtifactArchiveInvariantError(`Archived handle '${handle.handle}' has incomplete hashes.`);
  }
  let content: string;
  try {
    content = runtime.storage.readFileSync(record.archivePath, 'utf-8');
  } catch (error: unknown) {
    throw new ProviderArtifactArchiveInvariantError(
      `Archived handle '${handle.handle}' is no longer readable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const archiveHash = createHash('sha256').update(content, 'utf8').digest('hex');
  if (archiveHash !== record.archiveSha256) {
    throw new ProviderArtifactArchiveInvariantError(`Archived handle '${handle.handle}' failed hash verification.`);
  }
  return record;
}

function adoptArchivedRecord(
  runtime: ArtifactCleanupRuntime,
  descriptor: ProviderArtifactActionDescriptor,
  handle: CanonicalProviderArtifactHandle,
): ArchiveArtifactRecord | null {
  const actionsRoot = providerActionsRoot(runtime, descriptor);
  let entries: ReturnType<ArtifactCleanupRuntime['storage']['readdirSync']>;
  try {
    entries = runtime.storage.readdirSync(actionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === sanitizePathSegment(descriptor.archiveActionId)) continue;
    const manifestPath = join(actionsRoot, entry.name, 'manifest.json');
    let manifest: ArchiveManifest | null;
    try {
      manifest = readManifest(runtime, manifestPath);
    } catch {
      continue;
    }
    const candidate = manifest?.artifacts.find((record) => matchingMetadata(record, handle));
    const verified = verifiedArchivedRecord(runtime, candidate, handle);
    if (verified !== null) return verified;
  }
  return null;
}

/** Archives provider artifacts under the stable action namespace and verifies every retry. */
export async function archiveProviderArtifactsForJob(options: {
  readonly runtime: ArtifactCleanupRuntime;
  readonly descriptor: ProviderArtifactActionDescriptor;
}): Promise<ProviderArtifactArchiveResult> {
  const { runtime, descriptor } = options;
  const archiveDir = actionArchiveDir(runtime, descriptor);
  runtime.storage.mkdirSync(archiveDir, { recursive: true });
  const manifestPath = join(archiveDir, 'manifest.json');
  const existing = readManifest(runtime, manifestPath);
  if (existing !== null) assertManifestIdentity(existing, descriptor);

  const existingByHandle = new Map(
    existing?.artifacts.map((record) => [
      stableJson({
        handle: record.sourceHandle,
        sourceJobId: record.sourceJobId,
        ...(record.identity === undefined ? {} : { identity: record.identity }),
      }),
      record,
    ]),
  );
  const artifacts: ArchiveArtifactRecord[] = [];
  for (const [index, handle] of descriptor.handles.entries()) {
    const key = stableJson(handle);
    const verified = verifiedArchivedRecord(runtime, existingByHandle.get(key), handle);
    if (verified !== null) {
      artifacts.push(verified);
      continue;
    }
    const archived = await archiveOneProviderArtifact({ runtime, archiveDir, handle, index });
    if (archived.status === 'missing') {
      const adopted = adoptArchivedRecord(runtime, descriptor, handle);
      artifacts.push(adopted ?? archived);
    } else {
      artifacts.push(archived);
    }
  }

  const manifest: ArchiveManifest = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    archiveActionId: descriptor.archiveActionId,
    archivePayloadHash: descriptor.archivePayloadHash,
    sourceRevision: descriptor.sourceRevision,
    canonicalHandles: descriptor.handles,
    jobId: descriptor.jobId,
    sessionId: descriptor.sessionId,
    provider: descriptor.provider,
    archivedAt: existing?.archivedAt ?? descriptor.archivedAt,
    artifacts,
  };
  const manifestWritten = runtime.storage.writeAtomicSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  if (!manifestWritten) {
    throw new Error(`Failed to write provider artifact archive manifest for job ${descriptor.jobId}`);
  }
  return { manifestPath, artifacts };
}

async function archiveOneProviderArtifact(options: {
  readonly runtime: ArtifactCleanupRuntime;
  readonly archiveDir: string;
  readonly handle: CanonicalProviderArtifactHandle;
  readonly index: number;
}): Promise<ArchiveArtifactRecord> {
  const { runtime, archiveDir, handle, index } = options;
  const source = {
    sourceHandle: handle.handle,
    sourceJobId: handle.sourceJobId,
    ...(handle.identity === undefined ? {} : { identity: handle.identity }),
  };
  try {
    const content = await readStableUtf8File(runtime, handle.handle);
    const sourceSha256 = createHash('sha256').update(content, 'utf-8').digest('hex');
    const archivePath = join(
      archiveDir,
      `${String(index + 1).padStart(4, '0')}-${safeArtifactFileName(handle.handle)}`,
    );
    const written = runtime.storage.writeAtomicSync(archivePath, content, { encoding: 'utf-8', mode: 0o600 });
    if (!written) return { ...source, status: 'failed', error: 'archive write failed' };
    const archiveContent = runtime.storage.readFileSync(archivePath, 'utf-8');
    const archiveSha256 = createHash('sha256').update(archiveContent, 'utf-8').digest('hex');
    if (archiveSha256 !== sourceSha256) {
      throw new ProviderArtifactArchiveInvariantError(`Archived handle '${handle.handle}' changed during publication.`);
    }
    return {
      ...source,
      archivePath,
      bytes: Buffer.byteLength(archiveContent, 'utf-8'),
      sourceSha256,
      archiveSha256,
      status: 'archived',
    };
  } catch (error: unknown) {
    if (error instanceof ProviderArtifactArchiveInvariantError) throw error;
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
    if (!stats.isFile()) throw new Error('source is not a file');
    const content = runtime.storage.readFileSync(handle, 'utf-8');
    if (previousContent !== null && content === previousContent) return content;
    previousContent = content;
    if (attempt < STABLE_READ_ATTEMPTS) await runtime.time.sleep(STABLE_READ_SETTLE_MS);
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
