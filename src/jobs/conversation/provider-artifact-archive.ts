import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';

import { providerArtifactIdentitySchema, type ProviderArtifactIdentity } from '../../providers/artifact-identity.js';
import type { ArtifactCleanupRuntime } from '../../providers/contract.js';
import type { JobConversation } from './entry.js';
import { jobConversationProvider } from './entry.js';
import type { EventsRow } from '../../store/schema.js';
import type { StoragePort } from '../../infra/port-types.js';
import { withJobArtifactGuard } from './artifact-guard.js';

const ARCHIVE_SCHEMA_VERSION = 3;

export type CanonicalProviderArtifactHandle = {
  readonly handle: string;
  readonly sourceJobId: string;
  readonly identity?: ProviderArtifactIdentity;
};

export type ProviderArtifactActionDescriptor = {
  readonly operationId: string;
  readonly execution: number;
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
    handle: z.string().refine(isAbsolute, 'Native handle must be absolute.'),
    sourceJobId: z.string().min(1),
    identity: providerArtifactIdentitySchema.optional(),
  })
  .strict();

const archiveArtifactRecordSchema = z
  .object({
    sourceHandle: z.string().refine(isAbsolute, 'Native handle must be absolute.'),
    sourceJobId: z.string().min(1),
    identity: providerArtifactIdentitySchema.optional(),
    archivePath: z
      .string()
      .regex(/^\.archive-[a-f0-9]+-\d+\.bytes$/)
      .optional(),
    bytes: z.number().int().nonnegative().optional(),
    sourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    archiveSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
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
    execution: z.number().int().positive().safe(),
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

type ArchiveInvariantCode = 'archive_invalid' | 'archive_missing' | 'archive_hash_mismatch';

export class ProviderArtifactArchiveInvariantError extends Error {
  readonly code: ArchiveInvariantCode;

  constructor(message: string, code: ArchiveInvariantCode = 'archive_invalid') {
    super(message);
    this.name = 'ProviderArtifactArchiveInvariantError';
    this.code = code;
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
  entry: JobConversation,
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

/** A replay of the same persisted action must derive the same archive and discard identities. */
export function deriveProviderArtifactActionDescriptor(options: {
  readonly entry: JobConversation;
  readonly jobId: string;
  readonly handles: readonly string[];
  readonly sourceRevision: string;
  readonly archivedAt: string;
}): ProviderArtifactActionDescriptor {
  const provider = jobConversationProvider(options.entry);
  const handles = canonicalHandles(options.entry, options.jobId, options.handles);
  const operationId = hash(
    stableJson({
      v: 1,
      execution: options.entry.execution,
      jobId: options.jobId,
      provider,
      sourceRevision: options.sourceRevision,
      handles,
    }),
  );
  const archiveActionId = `archive-${hash(`${operationId}\u0000job.retention.archive`).slice('sha256:'.length)}`;
  const discardActionId = `discard-${hash(`${operationId}\u0000job.retention.provider-discard`).slice('sha256:'.length)}`;
  return {
    operationId,
    execution: options.entry.execution,
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

export function deriveProviderArtifactSourceRevision(options: {
  readonly jobId: string;
  readonly execution: number;
  readonly accepted: EventsRow;
}): string {
  if (options.accepted.type !== 'job.execution.outcome.accepted' || options.accepted.stream_id !== options.jobId) {
    throw new ProviderArtifactArchiveInvariantError(`Provider artifact source contradicts job ${options.jobId}.`);
  }
  return hash(stableJson(options));
}

export function conversationArchiveDirectory(runtime: Pick<ArtifactCleanupRuntime, 'paths'>, jobId: string): string {
  return join(runtime.paths.coral.exports.jobsRoot, jobId, 'conversation');
}

function readManifest(runtime: ArtifactCleanupRuntime, path: string): ArchiveManifest | null {
  try {
    const manifest = archiveManifestSchema.parse(JSON.parse(runtime.storage.readFileSync(path, 'utf-8')) as unknown);
    assertManifestContents(manifest);
    return manifest;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof ProviderArtifactArchiveInvariantError) throw error;
    throw new ProviderArtifactArchiveInvariantError(`Invalid conversation manifest '${path}': ${String(error)}`);
  }
}

function assertManifestContents(manifest: ArchiveManifest): void {
  if (manifest.artifacts.length !== manifest.canonicalHandles.length)
    throw new Error('Archive handle count does not match its action.');
  for (const [index, record] of manifest.artifacts.entries()) {
    const handle = manifest.canonicalHandles[index];
    if (
      record.sourceHandle !== handle.handle ||
      record.sourceJobId !== handle.sourceJobId ||
      stableJson(record.identity ?? null) !== stableJson(handle.identity ?? null) ||
      record.status === 'failed'
    ) {
      throw new Error('Archive source does not match its action.');
    }
    if (
      record.status === 'archived' &&
      (record.archivePath !== `.${manifest.archiveActionId}-${index}.bytes` ||
        record.bytes === undefined ||
        record.sourceSha256 === undefined ||
        record.archiveSha256 === undefined)
    ) {
      throw new Error('Archive bytes do not match their publication record.');
    }
    if (record.status === 'archived' && record.archiveSha256 !== record.sourceSha256)
      throw new ProviderArtifactArchiveInvariantError('Conversation archive hashes disagree.', 'archive_hash_mismatch');
  }
}

function bytesHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifiedBytes(runtime: ArtifactCleanupRuntime, directory: string, record: ArchiveArtifactRecord): Uint8Array {
  if (
    record.status !== 'archived' ||
    record.archivePath === undefined ||
    record.bytes === undefined ||
    record.sourceSha256 === undefined ||
    record.archiveSha256 === undefined
  ) {
    throw new ProviderArtifactArchiveInvariantError(`Incomplete archive for '${record.sourceHandle}'.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = runtime.storage.readFileBytesSync(join(directory, record.archivePath));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ProviderArtifactArchiveInvariantError('The archived native bytes are missing.', 'archive_missing');
    throw error;
  }
  if (
    record.archiveSha256 !== record.sourceSha256 ||
    bytes.length !== record.bytes ||
    bytesHash(bytes) !== record.sourceSha256
  ) {
    throw new ProviderArtifactArchiveInvariantError(
      `Conversation archive hash mismatch for '${record.sourceHandle}'.`,
      'archive_hash_mismatch',
    );
  }
  return bytes;
}

function syncDirectory(runtime: ArtifactCleanupRuntime, directory: string): void {
  if (!runtime.storage.syncDirectoryDurableSync(directory))
    throw new Error(`Directory durability unknown: ${directory}`);
}

function ensureDurableDirectory(runtime: ArtifactCleanupRuntime, directory: string): void {
  const missing: string[] = [];
  let parent = directory;
  for (;;) {
    try {
      if (!runtime.storage.statSync(parent).isDirectory()) throw new Error(`Not a directory: ${parent}`);
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(parent);
      parent = dirname(parent);
    }
  }
  for (const path of missing.reverse()) {
    runtime.storage.mkdirSync(path, { mode: 0o700 });
    syncDirectory(runtime, path);
    syncDirectory(runtime, dirname(path));
  }
}

function removeUnreferencedBytes(
  runtime: ArtifactCleanupRuntime,
  directory: string,
  manifest: ArchiveManifest | null,
): void {
  const live = new Set(
    manifest?.artifacts.flatMap((record) => (record.archivePath === undefined ? [] : [record.archivePath])),
  );
  for (const name of runtime.storage.readdirSync(directory)) {
    if (name.startsWith('.archive-') && !live.has(name)) runtime.storage.unlinkSync(join(directory, name));
  }
  syncDirectory(runtime, directory);
}

export function restoreStagePath(sourceHandle: string, jobId: string, execution: number): string {
  return join(dirname(sourceHandle), `.coral-restore-${jobId}-${execution}.stage`);
}

function removeRestoreStages(
  runtime: ArtifactCleanupRuntime,
  jobId: string,
  throughExecution: number,
  handles: readonly string[],
): void {
  for (let execution = 1; execution <= throughExecution; execution++) {
    const stages = new Set(handles.map((handle) => restoreStagePath(handle, jobId, execution)));
    for (const stage of stages) {
      try {
        runtime.storage.unlinkSync(stage);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  for (const directory of new Set(handles.map(dirname))) {
    try {
      if (!runtime.storage.statSync(directory).isDirectory()) throw new Error(`Not a directory: ${directory}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    syncDirectory(runtime, directory);
  }
}

export async function cleanupConversationRestoreStages(
  runtime: ArtifactCleanupRuntime,
  jobId: string,
  throughExecution: number,
  handles: readonly string[],
): Promise<void> {
  await withJobArtifactGuard(runtime, jobId, () => {
    removeRestoreStages(runtime, jobId, throughExecution, handles);
  });
}

function verifyArchiveReplay(
  runtime: ArtifactCleanupRuntime,
  directory: string,
  existing: ArchiveManifest,
  descriptor: ProviderArtifactActionDescriptor,
): void {
  if (
    existing.archivePayloadHash !== descriptor.archivePayloadHash ||
    existing.sourceRevision !== descriptor.sourceRevision ||
    existing.jobId !== descriptor.jobId ||
    existing.execution !== descriptor.execution ||
    existing.provider !== descriptor.provider ||
    stableJson(existing.canonicalHandles) !== stableJson(descriptor.handles)
  ) {
    throw new ProviderArtifactArchiveInvariantError('Archive action has conflicting inputs.');
  }
  for (const artifact of existing.artifacts)
    if (artifact.status === 'archived') verifiedBytes(runtime, directory, artifact);
  syncDirectory(runtime, directory);
  removeUnreferencedBytes(runtime, directory, existing);
}

function readNativeBytes(runtime: ArtifactCleanupRuntime, handle: string): Uint8Array | null {
  try {
    if (!runtime.storage.statSync(handle).isFile()) throw new Error(`Native artifact is not a file: ${handle}`);
    return runtime.storage.readFileBytesSync(handle);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function publishArchiveArtifacts(
  runtime: ArtifactCleanupRuntime,
  directory: string,
  descriptor: ProviderArtifactActionDescriptor,
  existing: ArchiveManifest | null,
): { artifacts: ArchiveArtifactRecord[]; prepared: boolean } {
  const artifacts: ArchiveArtifactRecord[] = [];
  let prepared = false;
  for (const [index, handle] of descriptor.handles.entries()) {
    const source = {
      sourceHandle: handle.handle,
      sourceJobId: handle.sourceJobId,
      ...(handle.identity === undefined ? {} : { identity: handle.identity }),
    };
    const bytes = readNativeBytes(runtime, handle.handle);
    if (bytes === null) {
      artifacts.push({ ...source, status: 'missing' });
      continue;
    }
    if (!prepared) {
      ensureDurableDirectory(runtime, directory);
      removeUnreferencedBytes(runtime, directory, existing);
      prepared = true;
    }
    const archivePath = `.${descriptor.archiveActionId}-${index}.bytes`;
    const sourceSha256 = bytesHash(bytes);
    const record: ArchiveArtifactRecord = {
      ...source,
      status: 'archived',
      archivePath,
      bytes: bytes.length,
      sourceSha256,
      archiveSha256: sourceSha256,
    };
    if (!runtime.storage.writeAtomicDurableSync(join(directory, archivePath), bytes, { mode: 0o600 })) {
      throw new Error('Conversation bytes publication durability is unknown.');
    }
    verifiedBytes(runtime, directory, record);
    artifacts.push(record);
  }
  return { artifacts, prepared };
}

function replaceArchiveManifest(
  runtime: ArtifactCleanupRuntime,
  directory: string,
  descriptor: ProviderArtifactActionDescriptor,
  artifacts: ArchiveArtifactRecord[],
): ArchiveManifest {
  const manifestPath = join(directory, 'manifest.json');
  const manifest = archiveManifestSchema.parse({
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    archiveActionId: descriptor.archiveActionId,
    archivePayloadHash: descriptor.archivePayloadHash,
    sourceRevision: descriptor.sourceRevision,
    canonicalHandles: descriptor.handles,
    jobId: descriptor.jobId,
    execution: descriptor.execution,
    provider: descriptor.provider,
    archivedAt: descriptor.archivedAt,
    artifacts,
  });
  if (
    !runtime.storage.writeAtomicDurableSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  ) {
    throw new Error('Conversation manifest publication durability is unknown; native artifacts kept.');
  }
  const committed = readManifest(runtime, manifestPath);
  if (committed === null || stableJson(committed) !== stableJson(manifest))
    throw new Error('Conversation publication did not commit.');
  for (const artifact of committed.artifacts)
    if (artifact.status === 'archived') verifiedBytes(runtime, directory, artifact);
  return committed;
}

export async function archiveProviderArtifactsForJob(options: {
  readonly runtime: ArtifactCleanupRuntime;
  readonly descriptor: ProviderArtifactActionDescriptor;
}): Promise<ProviderArtifactArchiveResult> {
  const { runtime, descriptor } = options;
  return withJobArtifactGuard<ProviderArtifactArchiveResult>(runtime, descriptor.jobId, () => {
    z.array(canonicalHandleSchema).parse(descriptor.handles);
    const directory = conversationArchiveDirectory(runtime, descriptor.jobId);
    const manifestPath = join(directory, 'manifest.json');
    const existing = readManifest(runtime, manifestPath);
    removeRestoreStages(runtime, descriptor.jobId, descriptor.execution, [
      ...descriptor.handles.map((item) => item.handle),
      ...(existing?.artifacts.map((item) => item.sourceHandle) ?? []),
    ]);
    if (existing?.archiveActionId === descriptor.archiveActionId) {
      verifyArchiveReplay(runtime, directory, existing, descriptor);
      return { manifestPath, artifacts: existing.artifacts };
    }
    if (existing !== null && existing.execution >= descriptor.execution) {
      throw new ProviderArtifactArchiveInvariantError('An older retention action cannot replace the current archive.');
    }
    const { artifacts, prepared } = publishArchiveArtifacts(runtime, directory, descriptor, existing);
    if (!prepared) {
      try {
        removeUnreferencedBytes(runtime, directory, existing);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return { manifestPath, artifacts };
    }
    const committed = replaceArchiveManifest(runtime, directory, descriptor, artifacts);
    removeUnreferencedBytes(runtime, directory, committed);
    return { manifestPath, artifacts: committed.artifacts };
  });
}

export type ConversationRestoreResult =
  | { readonly kind: 'present'; readonly sourceHandle: string }
  | { readonly kind: 'restored'; readonly sourceHandle: string; readonly sourceSha256: string }
  | {
      readonly kind: 'unrestorable';
      readonly reason:
        | 'archive_missing'
        | 'archive_stale'
        | 'archive_invalid'
        | 'archive_hash_mismatch'
        | 'profile_mismatch'
        | 'native_unobservable'
        | 'publication_failed';
      readonly message: string;
    };

export type ConversationRestoreVerification =
  | Exclude<ConversationRestoreResult, { kind: 'restored' }>
  | {
      readonly kind: 'verified';
      readonly sourceHandle: string;
      readonly sourceSha256: string;
      readonly bytes: Uint8Array;
    };

function nativePresent(storage: StoragePort, handle: string): boolean {
  try {
    if (!storage.statSync(handle).isFile()) throw new Error(`Native path is not a file: ${handle}`);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function belongsToBoundProfile(conversation: JobConversation, handle: string): boolean {
  const profile = z
    .object({ profile: z.object({ canonicalLocation: z.string().refine(isAbsolute) }) })
    .passthrough()
    .safeParse(conversation.binding.binding);
  if (!profile.success || !isAbsolute(handle)) return false;
  const path = relative(profile.data.profile.canonicalLocation, handle);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function verifyArchivedConversation(
  runtime: ArtifactCleanupRuntime,
  conversation: JobConversation,
  minimumExecution: number,
): ConversationRestoreVerification {
  const directory = conversationArchiveDirectory(runtime, conversation.jobId);
  const manifest = readManifest(runtime, join(directory, 'manifest.json'));
  if (manifest === null)
    return {
      kind: 'unrestorable',
      reason: 'archive_missing',
      message: 'The conversation archive is missing or expired.',
    };
  if (manifest.jobId !== conversation.jobId || manifest.provider !== jobConversationProvider(conversation)) {
    throw new ProviderArtifactArchiveInvariantError('Archive belongs to a different conversation.');
  }
  const artifact = manifest.artifacts.find((record) => record.status === 'archived');
  if (artifact === undefined)
    return { kind: 'unrestorable', reason: 'archive_missing', message: 'No native bytes were archived.' };
  if (!belongsToBoundProfile(conversation, artifact.sourceHandle)) {
    return {
      kind: 'unrestorable',
      reason: 'profile_mismatch',
      message: 'The native path lies outside the bound provider profile.',
    };
  }
  if (nativePresent(runtime.storage, artifact.sourceHandle))
    return { kind: 'present', sourceHandle: artifact.sourceHandle };
  if (manifest.execution < minimumExecution || manifest.execution > conversation.execution) {
    return {
      kind: 'unrestorable',
      reason: 'archive_stale',
      message: 'The archive predates the latest native execution.',
    };
  }
  const bytes = verifiedBytes(runtime, directory, artifact);
  return { kind: 'verified', sourceHandle: artifact.sourceHandle, sourceSha256: bytesHash(bytes), bytes };
}

export async function verifyConversationRestore(options: {
  readonly runtime: ArtifactCleanupRuntime;
  readonly conversation: JobConversation;
  readonly nativeHandle: string | null;
  readonly minimumExecution: number;
}): Promise<ConversationRestoreVerification> {
  const { runtime, conversation, nativeHandle, minimumExecution } = options;
  return withJobArtifactGuard<ConversationRestoreVerification>(runtime, conversation.jobId, () => {
    try {
      if (nativeHandle !== null) {
        if (!belongsToBoundProfile(conversation, nativeHandle))
          return {
            kind: 'unrestorable',
            reason: 'profile_mismatch',
            message: 'The native path lies outside the bound provider profile.',
          };
        if (nativePresent(runtime.storage, nativeHandle)) return { kind: 'present', sourceHandle: nativeHandle };
      }
      return verifyArchivedConversation(runtime, conversation, minimumExecution);
    } catch (error: unknown) {
      return {
        kind: 'unrestorable',
        reason: error instanceof ProviderArtifactArchiveInvariantError ? error.code : 'native_unobservable',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function prepareRestoreStage(
  runtime: ArtifactCleanupRuntime,
  jobId: string,
  execution: number,
  verification: Extract<ConversationRestoreVerification, { kind: 'verified' }>,
): string {
  if (bytesHash(verification.bytes) !== verification.sourceSha256)
    throw new Error('Restore bytes failed hash verification.');
  const parent = dirname(verification.sourceHandle);
  ensureDurableDirectory(runtime, parent);
  const stage = restoreStagePath(verification.sourceHandle, jobId, execution);
  try {
    runtime.storage.unlinkSync(stage);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  runtime.storage.writeFileSync(stage, verification.bytes, { mode: 0o600, flag: 'wx' });
  const fd = runtime.storage.openSync(stage, 'r+');
  try {
    runtime.storage.fdatasyncSync(fd);
  } finally {
    runtime.storage.closeSync(fd);
  }
  syncDirectory(runtime, parent);
  if (bytesHash(runtime.storage.readFileBytesSync(stage)) !== verification.sourceSha256)
    throw new Error('Restore stage failed hash verification.');
  return stage;
}

export async function publishConversationRestore(options: {
  readonly runtime: ArtifactCleanupRuntime;
  readonly jobId: string;
  readonly execution: number;
  readonly verification: ConversationRestoreVerification;
}): Promise<ConversationRestoreResult> {
  const { runtime, jobId, execution, verification } = options;
  return withJobArtifactGuard<ConversationRestoreResult>(runtime, jobId, () => {
    if (verification.kind === 'unrestorable') return verification;
    try {
      if (nativePresent(runtime.storage, verification.sourceHandle))
        return { kind: 'present', sourceHandle: verification.sourceHandle };
      if (verification.kind === 'present')
        return {
          kind: 'unrestorable',
          reason: 'publication_failed',
          message: 'The existing native file disappeared after verification.',
        };
      const stage = prepareRestoreStage(runtime, jobId, execution, verification);
      const publication = runtime.storage.publishFileNoReplaceSync(stage, verification.sourceHandle);
      if (publication.kind === 'exists') {
        if (!nativePresent(runtime.storage, verification.sourceHandle))
          throw new Error('The occupied native path disappeared.');
        return { kind: 'present', sourceHandle: verification.sourceHandle };
      }
      if (publication.kind === 'failed') throw new Error(publication.reason);
      return { kind: 'restored', sourceHandle: verification.sourceHandle, sourceSha256: verification.sourceSha256 };
    } catch (error: unknown) {
      return {
        kind: 'unrestorable',
        reason: 'publication_failed',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
