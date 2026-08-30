import { basename, dirname, join } from 'node:path';

import { errorNumber } from '../../infra/error-number.js';
import { DirectoryLockOwnershipLostError } from '../../infra/fs-lock.js';
import type { StoragePort } from '../../infra/port-types.js';
import {
  type HandoffRoutingStorePathObservationError,
  observeHandoffRoutingPath,
  type HandoffRoutingWalObservationReceipt,
  type HandoffRoutingWalStatReceipt,
} from './artifact.js';
import { SQLITE_ERROR } from './transaction.js';

const HANDOFF_ROUTING_STATUS_QUARANTINE_DIRECTORY = 'handoff-routing-quarantine';
export const MAX_HANDOFF_ROUTING_STATUS_QUARANTINES = 16;
const MAX_HANDOFF_ROUTING_STATUS_QUARANTINE_FILES = MAX_HANDOFF_ROUTING_STATUS_QUARANTINES * 2 + 1;
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type HandoffRoutingStatusQuarantineArtifact = 'database' | 'wal';

export type HandoffRoutingStatusQuarantineEntry = Readonly<{
  id: string;
  quarantinePath: string;
  state: 'complete' | 'incomplete';
  artifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
}>;

export type HandoffRoutingStatusQuarantineList =
  | Readonly<{
      kind: 'listed';
      entries: readonly HandoffRoutingStatusQuarantineEntry[];
      overflow: boolean;
    }>
  | Readonly<{
      kind: 'undeterminable';
      cause: 'root-observation-failed' | 'directory-read-failed';
      errcode: number;
    }>;

export type HandoffRoutingStatusQuarantineAffectedArtifact = HandoffRoutingStatusQuarantineArtifact | 'shm';
export type HandoffRoutingStatusQuarantineSyncedDirectory = 'source' | 'quarantine';

type HandoffRoutingStatusQuarantineStorageEffects = Readonly<{
  quarantineId: string;
  quarantinePath: string;
  movedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
  observedMovedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
  removedArtifacts: readonly HandoffRoutingStatusQuarantineAffectedArtifact[];
  observedRemovedArtifacts: readonly HandoffRoutingStatusQuarantineAffectedArtifact[];
  syncedDirectories: readonly HandoffRoutingStatusQuarantineSyncedDirectory[];
}>;

type HandoffRoutingStatusQuarantineStorageFailureCause =
  | 'artifact-move-failed'
  | 'directory-sync-failed'
  | 'ownership-lost'
  | 'root-create-failed';

export type HandoffRoutingStatusQuarantineResult =
  | Readonly<{
      kind: 'quarantined';
      quarantineId: string;
      quarantinePath: string;
      retainedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
    }>
  | Readonly<{
      kind: 'quarantined-incomplete';
      quarantineId: string;
      quarantinePath: string;
      retainedArtifacts: readonly ['wal'];
    }>
  | Readonly<{ kind: 'incomplete-quarantine'; quarantineId: string }>
  | Readonly<{
      kind: 'quarantine-coordinate-occupied';
      quarantineId: string;
      quarantinePath: string;
      artifact: HandoffRoutingStatusQuarantineArtifact;
    }>
  | Extract<HandoffRoutingStatusQuarantineList, { kind: 'undeterminable' }>
  | Readonly<{ kind: 'undeterminable'; cause: 'artifact-observation-failed'; errcode: number }>
  | (HandoffRoutingStatusQuarantineStorageEffects &
      Readonly<{
        kind: 'quarantine-storage-failed';
        retainedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
        cause: HandoffRoutingStatusQuarantineStorageFailureCause;
      }>)
  | (HandoffRoutingStatusQuarantineStorageEffects &
      Readonly<{
        kind: 'quarantine-storage-failed';
        retainedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
        cause: 'artifact-observation-failed';
        errcode: number;
      }>)
  | (HandoffRoutingStatusQuarantineStorageEffects &
      Readonly<{
        kind: 'quarantine-retention-undeterminable';
        observedRetainedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
      }> &
      (
        | Readonly<{ cause: 'artifact-observation-failed'; errcode: number }>
        | Readonly<{ cause: 'directory-sync-failed' }>
        | Readonly<{ cause: 'ownership-lost' }>
      ));

export type HandoffRoutingStatusQuarantineClearStoreResult =
  | Readonly<{ kind: 'cleared'; entry: HandoffRoutingStatusQuarantineEntry }>
  | Readonly<{ kind: 'quarantine-not-found'; quarantineId: string }>
  | Readonly<{
      kind: 'quarantine-clear-undeterminable';
      quarantineId: string;
      quarantinePath: string;
      artifact: HandoffRoutingStatusQuarantineArtifact;
      errcode: number;
    }>
  | Readonly<{
      kind: 'quarantine-clear-storage-failed';
      quarantineId: string;
      quarantinePath: string;
      removedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
      observedRemovedArtifacts: readonly HandoffRoutingStatusQuarantineArtifact[];
      syncedDirectories: readonly HandoffRoutingStatusQuarantineSyncedDirectory[];
      cause: 'artifact-remove-failed' | 'directory-sync-failed' | 'ownership-lost';
    }>;

export class HandoffRoutingStatusQuarantineCapacityError extends Error {}

function quarantineRoot(path: string): string {
  return join(dirname(path), HANDOFF_ROUTING_STATUS_QUARANTINE_DIRECTORY);
}

function quarantineArtifact(
  fileName: string,
  databaseName: string,
): Readonly<{ id: string; artifact: HandoffRoutingStatusQuarantineArtifact }> | null {
  const prefix = `${databaseName}.`;
  if (!fileName.startsWith(prefix)) return null;
  const remainder = fileName.slice(prefix.length);
  const suffix = remainder.endsWith('-wal') ? '-wal' : '';
  const id = suffix === '' ? remainder : remainder.slice(0, -suffix.length);
  if (!CANONICAL_UUID_PATTERN.test(id)) return null;
  return { id, artifact: suffix === '-wal' ? 'wal' : 'database' };
}

export function listHandoffRoutingStoreQuarantines(
  storage: StoragePort,
  path: string,
): HandoffRoutingStatusQuarantineList {
  const root = quarantineRoot(path);
  const rootObservation = observeHandoffRoutingPath(storage, root);
  if (rootObservation.kind === 'absent') return { kind: 'listed', entries: [], overflow: false };
  if (rootObservation.kind === 'undeterminable' || !rootObservation.stat.isDirectory()) {
    return {
      kind: 'undeterminable',
      cause: 'root-observation-failed',
      errcode: rootObservation.kind === 'undeterminable' ? rootObservation.error.errcode : SQLITE_ERROR,
    };
  }
  let bounded: ReturnType<StoragePort['readDirectoryBoundedSync']>;
  try {
    bounded = storage.readDirectoryBoundedSync(root, MAX_HANDOFF_ROUTING_STATUS_QUARANTINE_FILES);
  } catch (error: unknown) {
    const repeatedObservation = observeHandoffRoutingPath(storage, root);
    if (repeatedObservation.kind === 'absent') return { kind: 'listed', entries: [], overflow: false };
    return {
      kind: 'undeterminable',
      cause: 'directory-read-failed',
      errcode:
        repeatedObservation.kind === 'undeterminable'
          ? repeatedObservation.error.errcode
          : errorNumber(error, SQLITE_ERROR),
    };
  }
  const artifactsById = new Map<string, Set<HandoffRoutingStatusQuarantineArtifact>>();
  for (const fileName of bounded.entries) {
    const parsed = quarantineArtifact(fileName, basename(path));
    if (parsed === null) continue;
    const artifacts = artifactsById.get(parsed.id) ?? new Set<HandoffRoutingStatusQuarantineArtifact>();
    artifacts.add(parsed.artifact);
    artifactsById.set(parsed.id, artifacts);
  }
  const artifactOrder: readonly HandoffRoutingStatusQuarantineArtifact[] = ['database', 'wal'];
  const entries = [...artifactsById.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([id, artifacts]): HandoffRoutingStatusQuarantineEntry => ({
        id,
        quarantinePath: join(root, `${basename(path)}.${id}`),
        state: artifacts.has('database') ? 'complete' : 'incomplete',
        artifacts: artifactOrder.filter((artifact) => artifacts.has(artifact)),
      }),
    );
  return { kind: 'listed', entries, overflow: bounded.overflow };
}

type HandoffRoutingStatusQuarantineMoveObservation =
  | Readonly<{ kind: 'moved' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'occupied' }>
  | Readonly<{
      kind: 'failed';
      cause: 'artifact-move-failed' | 'directory-sync-failed' | 'ownership-lost';
      retention: 'retained' | 'not-retained';
    }>
  | Readonly<{
      kind: 'undeterminable';
      error: HandoffRoutingStorePathObservationError;
      retention: 'retained' | 'not-retained' | 'unknown';
    }>;

type HandoffRoutingStatusMaintenanceState = { mutationAttempted: boolean };

type HandoffRoutingStatusMaintenancePaths = Readonly<{
  quarantineId: string;
  sourceDatabase: string;
  sourceWal: string;
  sourceShm: string;
  sourceDirectory: string;
  quarantineRoot: string;
  quarantineDatabase: string;
  quarantineWal: string;
}>;

type HandoffRoutingStatusDurabilityBarrierResult<Cause> =
  | Readonly<{ kind: 'durable' }>
  | Readonly<{ kind: 'failed'; cause: Cause }>;

type HandoffRoutingStatusArtifactEffects<Artifact> = Readonly<{
  durableArtifacts: ReadonlySet<Artifact>;
  observedArtifacts: ReadonlySet<Artifact>;
  recordObserved: (artifact: Artifact) => void;
  recordAfterBarrier: <Cause>(
    artifact: Artifact,
    barrier: () => HandoffRoutingStatusDurabilityBarrierResult<Cause>,
  ) => HandoffRoutingStatusDurabilityBarrierResult<Cause>;
}>;

type HandoffRoutingStatusQuarantineEffectLedgers = Readonly<{
  moved: HandoffRoutingStatusArtifactEffects<HandoffRoutingStatusQuarantineArtifact>;
  removed: HandoffRoutingStatusArtifactEffects<HandoffRoutingStatusQuarantineAffectedArtifact>;
  retained: Set<HandoffRoutingStatusQuarantineArtifact>;
}>;

type HandoffRoutingStatusQuarantineClearEffectLedgers = Readonly<{
  removed: HandoffRoutingStatusArtifactEffects<HandoffRoutingStatusQuarantineArtifact>;
}>;

type HandoffRoutingStatusMaintenanceContext<
  EffectLedgers extends HandoffRoutingStatusQuarantineEffectLedgers | HandoffRoutingStatusQuarantineClearEffectLedgers,
> = Readonly<{
  storage: StoragePort;
  paths: HandoffRoutingStatusMaintenancePaths;
  assertOwned: () => void;
  mutationState: HandoffRoutingStatusMaintenanceState;
  effectLedgers: EffectLedgers;
  syncedDirectories: Set<HandoffRoutingStatusQuarantineSyncedDirectory>;
}>;

type HandoffRoutingStatusQuarantineMaintenanceContext =
  HandoffRoutingStatusMaintenanceContext<HandoffRoutingStatusQuarantineEffectLedgers>;

type HandoffRoutingStatusQuarantineClearMaintenanceContext =
  HandoffRoutingStatusMaintenanceContext<HandoffRoutingStatusQuarantineClearEffectLedgers>;

function handoffRoutingStatusMaintenancePaths(
  path: string,
  quarantineId: string,
): HandoffRoutingStatusMaintenancePaths {
  const quarantineDatabase = join(quarantineRoot(path), `${basename(path)}.${quarantineId}`);
  return {
    quarantineId,
    sourceDatabase: path,
    sourceWal: `${path}-wal`,
    sourceShm: `${path}-shm`,
    sourceDirectory: dirname(path),
    quarantineRoot: quarantineRoot(path),
    quarantineDatabase,
    quarantineWal: `${quarantineDatabase}-wal`,
  };
}

function createHandoffRoutingStatusArtifactEffects<Artifact>(): HandoffRoutingStatusArtifactEffects<Artifact> {
  const durableArtifacts = new Set<Artifact>();
  const observedArtifacts = new Set<Artifact>();
  return {
    durableArtifacts,
    observedArtifacts,
    recordObserved: (artifact) => {
      observedArtifacts.add(artifact);
    },
    recordAfterBarrier: (artifact, barrier) => {
      const result = barrier();
      if (result.kind === 'durable') {
        durableArtifacts.add(artifact);
      } else {
        observedArtifacts.add(artifact);
      }
      return result;
    },
  };
}

type HandoffRoutingIdentityObservation =
  | Readonly<{ kind: 'present'; identity: Readonly<{ dev: bigint; ino: bigint }> }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'undeterminable'; error: HandoffRoutingStorePathObservationError }>;

type HandoffRoutingUnlinkObservation =
  | Readonly<{ kind: 'removed' }>
  | Readonly<{ kind: 'candidate-absent' }>
  | Readonly<{ kind: 'expected-absent' }>
  | Readonly<{ kind: 'occupied' }>
  | Readonly<{ kind: 'undeterminable'; error: HandoffRoutingStorePathObservationError }>;

function attemptHandoffRoutingStatusMutation<T>(
  context: HandoffRoutingStatusMaintenanceContext<
    HandoffRoutingStatusQuarantineEffectLedgers | HandoffRoutingStatusQuarantineClearEffectLedgers
  >,
  mutate: () => T,
): T {
  context.mutationState.mutationAttempted = true;
  return mutate();
}

function observeHandoffRoutingIdentity(storage: StoragePort, path: string): HandoffRoutingIdentityObservation {
  const observation = observeHandoffRoutingPath(storage, path);
  return observation.kind === 'present'
    ? { kind: 'present', identity: { dev: observation.stat.dev, ino: observation.stat.ino } }
    : observation;
}

function unlinkHandoffRoutingPathIfIdentityMatches(
  context: HandoffRoutingStatusMaintenanceContext<
    HandoffRoutingStatusQuarantineEffectLedgers | HandoffRoutingStatusQuarantineClearEffectLedgers
  >,
  path: string,
  expectedIdentity: () => HandoffRoutingIdentityObservation,
): HandoffRoutingUnlinkObservation {
  context.assertOwned();
  const expectedObservation = expectedIdentity();
  const candidateObservation = observeHandoffRoutingIdentity(context.storage, path);
  if (expectedObservation.kind === 'undeterminable') return expectedObservation;
  if (candidateObservation.kind === 'undeterminable') return candidateObservation;
  if (candidateObservation.kind === 'absent') return { kind: 'candidate-absent' };
  if (expectedObservation.kind === 'absent') return { kind: 'expected-absent' };
  if (
    expectedObservation.identity.dev !== candidateObservation.identity.dev ||
    expectedObservation.identity.ino !== candidateObservation.identity.ino
  ) {
    return { kind: 'occupied' };
  }
  try {
    // Constraint: the maintenance lease makes this operation the sole Coral mutator authorized to replace
    // or delete source or quarantine pathnames. Observational SQLite opens outside the lease may still create
    // or rewrite sidecars, so identity must be re-observed immediately before deletion.
    attemptHandoffRoutingStatusMutation(context, () => context.storage.unlinkSync(path));
    return { kind: 'removed' };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'candidate-absent' };
    throw error;
  }
}

function claimQuarantineArtifactCoordinate(
  context: HandoffRoutingStatusQuarantineMaintenanceContext,
  artifact: HandoffRoutingStatusQuarantineArtifact,
): HandoffRoutingStatusQuarantineMoveObservation {
  const source = artifact === 'database' ? context.paths.sourceDatabase : context.paths.sourceWal;
  const destination = artifact === 'database' ? context.paths.quarantineDatabase : context.paths.quarantineWal;
  const sourceObservation = observeHandoffRoutingPath(context.storage, source);
  if (sourceObservation.kind === 'undeterminable') {
    return { ...sourceObservation, retention: 'not-retained' };
  }
  if (sourceObservation.kind === 'absent') return sourceObservation;
  try {
    // POSIX link(2) fails with EEXIST instead of replacing the destination, so it can claim a quarantine
    // coordinate atomically where rename(2) cannot.
    attemptHandoffRoutingStatusMutation(context, () => context.storage.linkSync(source, destination));
  } catch {
    // A reported link failure does not decide whether the destination entry was created.
  }

  const repeatedSourceObservation = observeHandoffRoutingPath(context.storage, source);
  const repeatedDestinationObservation = observeHandoffRoutingPath(context.storage, destination);
  if (repeatedDestinationObservation.kind === 'undeterminable') {
    return { ...repeatedDestinationObservation, retention: 'unknown' };
  }
  if (repeatedDestinationObservation.kind === 'absent') {
    if (repeatedSourceObservation.kind === 'undeterminable') {
      return { ...repeatedSourceObservation, retention: 'not-retained' };
    }
    return { kind: 'failed', cause: 'artifact-move-failed', retention: 'not-retained' };
  }
  if (repeatedSourceObservation.kind === 'undeterminable') {
    return { ...repeatedSourceObservation, retention: 'unknown' };
  }
  const sourceAlreadyRemoved = repeatedSourceObservation.kind === 'absent';
  if (
    repeatedSourceObservation.kind === 'present' &&
    (repeatedSourceObservation.stat.dev !== repeatedDestinationObservation.stat.dev ||
      repeatedSourceObservation.stat.ino !== repeatedDestinationObservation.stat.ino)
  ) {
    return { kind: 'occupied' };
  }

  // The quarantine name must be durable before source removal so every crash point retains at least one
  // durable name for the payload.
  if (!syncQuarantineMoveDirectory(context, context.paths.quarantineRoot, 'quarantine')) {
    if (sourceAlreadyRemoved) context.effectLedgers.moved.recordObserved(artifact);
    return { kind: 'failed', cause: 'directory-sync-failed', retention: 'retained' };
  }
  if (sourceAlreadyRemoved) {
    const durability = context.effectLedgers.moved.recordAfterBarrier(
      artifact,
      (): HandoffRoutingStatusDurabilityBarrierResult<'directory-sync-failed'> =>
        syncQuarantineMoveDirectory(context, context.paths.sourceDirectory, 'source')
          ? { kind: 'durable' }
          : { kind: 'failed', cause: 'directory-sync-failed' },
    );
    if (durability.kind === 'failed') {
      return { kind: 'failed', cause: durability.cause, retention: 'retained' };
    }
    return { kind: 'moved' };
  }
  let unlinkObservation: HandoffRoutingUnlinkObservation;
  try {
    unlinkObservation = unlinkHandoffRoutingPathIfIdentityMatches(context, source, () =>
      observeHandoffRoutingIdentity(context.storage, destination),
    );
  } catch (error: unknown) {
    if (error instanceof DirectoryLockOwnershipLostError) {
      return { kind: 'failed', cause: 'ownership-lost', retention: 'retained' };
    }
    return { kind: 'failed', cause: 'artifact-move-failed', retention: 'retained' };
  }
  if (unlinkObservation.kind === 'undeterminable') {
    return { ...unlinkObservation, retention: 'unknown' };
  }
  if (unlinkObservation.kind === 'occupied') return unlinkObservation;
  if (unlinkObservation.kind === 'expected-absent') {
    return { kind: 'failed', cause: 'artifact-move-failed', retention: 'not-retained' };
  }
  const durability = context.effectLedgers.moved.recordAfterBarrier(
    artifact,
    (): HandoffRoutingStatusDurabilityBarrierResult<'directory-sync-failed'> =>
      syncQuarantineMoveDirectory(context, context.paths.sourceDirectory, 'source')
        ? { kind: 'durable' }
        : { kind: 'failed', cause: 'directory-sync-failed' },
  );
  if (durability.kind === 'failed') {
    return { kind: 'failed', cause: durability.cause, retention: 'retained' };
  }
  return { kind: 'moved' };
}

function syncQuarantineMoveDirectory(
  context: HandoffRoutingStatusMaintenanceContext<
    HandoffRoutingStatusQuarantineEffectLedgers | HandoffRoutingStatusQuarantineClearEffectLedgers
  >,
  directory: string,
  label: HandoffRoutingStatusQuarantineSyncedDirectory,
): boolean {
  try {
    const synced = attemptHandoffRoutingStatusMutation(context, () =>
      context.storage.syncDirectoryDurableSync(directory),
    );
    if (synced) context.syncedDirectories.add(label);
    return synced;
  } catch {
    return false;
  }
}

function sameWalStat(left: HandoffRoutingWalStatReceipt, right: HandoffRoutingWalStatReceipt): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function movedWalStat(storage: StoragePort, path: string): HandoffRoutingWalStatReceipt {
  const fd = storage.openSync(path, 'r');
  try {
    const stat = storage.fstatSync(fd, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs };
  } finally {
    storage.closeSync(fd);
  }
}

export type HandoffRoutingStatusQuarantineObservations = Readonly<{
  firstMainState: 'absent' | 'zero' | 'non-empty';
  firstWalReceipt: HandoffRoutingWalObservationReceipt;
  guardedMainState: 'absent' | 'zero' | 'non-empty';
  guardedWalReceipt: HandoffRoutingWalObservationReceipt;
}>;

function quarantineStorageFailure(
  context: HandoffRoutingStatusQuarantineMaintenanceContext,
  cause: HandoffRoutingStatusQuarantineStorageFailureCause | 'artifact-observation-failed',
  errcode?: number,
): HandoffRoutingStatusQuarantineResult {
  const effects = {
    quarantineId: context.paths.quarantineId,
    quarantinePath: context.paths.quarantineDatabase,
    movedArtifacts: [...context.effectLedgers.moved.durableArtifacts],
    observedMovedArtifacts: [...context.effectLedgers.moved.observedArtifacts],
    removedArtifacts: [...context.effectLedgers.removed.durableArtifacts],
    observedRemovedArtifacts: [...context.effectLedgers.removed.observedArtifacts],
    syncedDirectories: [...context.syncedDirectories],
  };
  const retainedEffects = {
    ...effects,
    kind: 'quarantine-storage-failed' as const,
    retainedArtifacts: [...context.effectLedgers.retained],
  };
  return cause === 'artifact-observation-failed'
    ? { ...retainedEffects, cause, errcode: errcode ?? SQLITE_ERROR }
    : { ...retainedEffects, cause };
}

function quarantineRetentionUndeterminable(
  context: HandoffRoutingStatusQuarantineMaintenanceContext,
  cause:
    | Readonly<{ kind: 'artifact-observation-failed'; error: HandoffRoutingStorePathObservationError }>
    | Readonly<{ kind: 'directory-sync-failed' | 'ownership-lost' }>,
): Extract<HandoffRoutingStatusQuarantineResult, { kind: 'quarantine-retention-undeterminable' }> {
  const effects = {
    kind: 'quarantine-retention-undeterminable' as const,
    quarantineId: context.paths.quarantineId,
    quarantinePath: context.paths.quarantineDatabase,
    observedRetainedArtifacts: [...context.effectLedgers.retained],
    movedArtifacts: [...context.effectLedgers.moved.durableArtifacts],
    observedMovedArtifacts: [...context.effectLedgers.moved.observedArtifacts],
    removedArtifacts: [...context.effectLedgers.removed.durableArtifacts],
    observedRemovedArtifacts: [...context.effectLedgers.removed.observedArtifacts],
    syncedDirectories: [...context.syncedDirectories],
  };
  return cause.kind === 'artifact-observation-failed'
    ? { ...effects, cause: cause.kind, errcode: cause.error.errcode }
    : { ...effects, cause: cause.kind };
}

function ownershipFailureCauseAfterMutation(
  context: HandoffRoutingStatusQuarantineMaintenanceContext | HandoffRoutingStatusQuarantineClearMaintenanceContext,
): 'ownership-lost' | null {
  try {
    context.assertOwned();
    return null;
  } catch (error: unknown) {
    if (!context.mutationState.mutationAttempted) throw error;
    if (error instanceof DirectoryLockOwnershipLostError) return 'ownership-lost';
    throw error;
  }
}

function assertOwnedAfterQuarantineMutation(
  context: HandoffRoutingStatusQuarantineMaintenanceContext,
): HandoffRoutingStatusQuarantineResult | null {
  const cause = ownershipFailureCauseAfterMutation(context);
  return cause === null ? null : quarantineStorageFailure(context, cause);
}

type HandoffRoutingStatusWalDisposition =
  | Readonly<{ kind: 'continued'; walMoved: boolean }>
  | Readonly<{ kind: 'finished'; result: HandoffRoutingStatusQuarantineResult }>;

function disposeQuarantineWal(
  context: HandoffRoutingStatusQuarantineMaintenanceContext,
  observations: HandoffRoutingStatusQuarantineObservations,
): HandoffRoutingStatusWalDisposition {
  let walMove: HandoffRoutingStatusQuarantineMoveObservation;
  try {
    walMove = claimQuarantineArtifactCoordinate(context, 'wal');
  } catch {
    return { kind: 'finished', result: quarantineStorageFailure(context, 'artifact-move-failed') };
  }
  if (walMove.kind === 'undeterminable') {
    if (walMove.retention === 'retained') context.effectLedgers.retained.add('wal');
    const result =
      walMove.retention === 'unknown'
        ? quarantineRetentionUndeterminable(context, {
            kind: 'artifact-observation-failed',
            error: walMove.error,
          })
        : quarantineStorageFailure(context, 'artifact-observation-failed', walMove.error.errcode);
    return { kind: 'finished', result };
  }
  if (walMove.kind === 'occupied') {
    return {
      kind: 'finished',
      result: {
        kind: 'quarantine-coordinate-occupied',
        quarantineId: context.paths.quarantineId,
        quarantinePath: context.paths.quarantineDatabase,
        artifact: 'wal',
      },
    };
  }
  if (walMove.kind === 'failed') {
    if (walMove.retention === 'retained') context.effectLedgers.retained.add('wal');
    return { kind: 'finished', result: quarantineStorageFailure(context, walMove.cause) };
  }
  const walMoved = walMove.kind === 'moved';
  if (!walMoved) return { kind: 'continued', walMoved };

  context.effectLedgers.retained.add('wal');
  const ownershipFailure = assertOwnedAfterQuarantineMutation(context);
  if (ownershipFailure !== null) return { kind: 'finished', result: ownershipFailure };
  try {
    const movedStat = movedWalStat(context.storage, context.paths.quarantineWal);
    const guardedReceipt = observations.guardedWalReceipt;
    if (
      observations.firstWalReceipt.kind === 'absent' &&
      guardedReceipt.kind === 'zero' &&
      movedStat.size === 0n &&
      sameWalStat(guardedReceipt.stat, movedStat)
    ) {
      const unlinkObservation = unlinkHandoffRoutingPathIfIdentityMatches(context, context.paths.quarantineWal, () => ({
        kind: 'present',
        identity: movedStat,
      }));
      if (unlinkObservation.kind === 'undeterminable') {
        return {
          kind: 'finished',
          result: quarantineRetentionUndeterminable(context, {
            kind: 'artifact-observation-failed',
            error: unlinkObservation.error,
          }),
        };
      }
      if (unlinkObservation.kind === 'occupied' || unlinkObservation.kind === 'expected-absent') {
        return {
          kind: 'finished',
          result: {
            kind: 'quarantine-coordinate-occupied',
            quarantineId: context.paths.quarantineId,
            quarantinePath: context.paths.quarantineDatabase,
            artifact: 'wal',
          },
        };
      }
      const removalDurability = context.effectLedgers.removed.recordAfterBarrier(
        'wal',
        (): HandoffRoutingStatusDurabilityBarrierResult<'directory-sync-failed' | 'ownership-lost'> => {
          const ownershipFailure = ownershipFailureCauseAfterMutation(context);
          if (ownershipFailure !== null) return { kind: 'failed', cause: ownershipFailure };
          return syncQuarantineMoveDirectory(context, context.paths.quarantineRoot, 'quarantine')
            ? { kind: 'durable' }
            : { kind: 'failed', cause: 'directory-sync-failed' };
        },
      );
      if (removalDurability.kind === 'failed') {
        return {
          kind: 'finished',
          result: quarantineRetentionUndeterminable(context, { kind: removalDurability.cause }),
        };
      }
      context.effectLedgers.retained.delete('wal');
    }
  } catch (error: unknown) {
    return {
      kind: 'finished',
      result:
        error instanceof DirectoryLockOwnershipLostError
          ? quarantineStorageFailure(context, 'ownership-lost')
          : quarantineStorageFailure(context, 'artifact-move-failed'),
    };
  }
  return { kind: 'continued', walMoved };
}

function removeQuarantineShm(
  context: HandoffRoutingStatusQuarantineMaintenanceContext,
): HandoffRoutingStatusQuarantineResult | null {
  const ownershipFailureBeforeShm = assertOwnedAfterQuarantineMutation(context);
  if (ownershipFailureBeforeShm !== null) return ownershipFailureBeforeShm;
  let shmRemoved: boolean;
  try {
    // Node 24 `node:sqlite` rewrote `-shm` on a read-only open whenever `-wal` was present, so it cannot
    // preserve evidence from before classification.
    shmRemoved = attemptHandoffRoutingStatusMutation(context, () =>
      unlinkIfPresent(context.storage, context.paths.sourceShm),
    );
  } catch {
    return quarantineStorageFailure(context, 'artifact-move-failed');
  }
  if (shmRemoved) {
    const removalDurability = context.effectLedgers.removed.recordAfterBarrier(
      'shm',
      (): HandoffRoutingStatusDurabilityBarrierResult<'directory-sync-failed' | 'ownership-lost'> => {
        const ownershipFailure = ownershipFailureCauseAfterMutation(context);
        if (ownershipFailure !== null) return { kind: 'failed', cause: ownershipFailure };
        return syncQuarantineMoveDirectory(context, context.paths.sourceDirectory, 'source')
          ? { kind: 'durable' }
          : { kind: 'failed', cause: 'directory-sync-failed' };
      },
    );
    if (removalDurability.kind === 'failed') {
      return quarantineStorageFailure(context, removalDurability.cause);
    }
  }
  return assertOwnedAfterQuarantineMutation(context);
}

function moveMainDatabaseToQuarantine(
  context: HandoffRoutingStatusQuarantineMaintenanceContext,
): HandoffRoutingStatusQuarantineResult {
  let databaseMove: HandoffRoutingStatusQuarantineMoveObservation;
  try {
    databaseMove = claimQuarantineArtifactCoordinate(context, 'database');
  } catch {
    return quarantineStorageFailure(context, 'artifact-move-failed');
  }
  if (databaseMove.kind === 'undeterminable') {
    if (databaseMove.retention === 'retained') context.effectLedgers.retained.add('database');
    return databaseMove.retention === 'unknown'
      ? quarantineRetentionUndeterminable(context, {
          kind: 'artifact-observation-failed',
          error: databaseMove.error,
        })
      : quarantineStorageFailure(context, 'artifact-observation-failed', databaseMove.error.errcode);
  }
  if (databaseMove.kind === 'occupied') {
    return {
      kind: 'quarantine-coordinate-occupied',
      quarantineId: context.paths.quarantineId,
      quarantinePath: context.paths.quarantineDatabase,
      artifact: 'database',
    };
  }
  if (databaseMove.kind === 'failed') {
    if (databaseMove.retention === 'retained') context.effectLedgers.retained.add('database');
    return quarantineStorageFailure(context, databaseMove.cause);
  }
  if (databaseMove.kind === 'absent') return quarantineStorageFailure(context, 'artifact-move-failed');
  context.effectLedgers.retained.add('database');
  const ownershipFailure = assertOwnedAfterQuarantineMutation(context);
  if (ownershipFailure !== null) return ownershipFailure;
  return {
    kind: 'quarantined',
    quarantineId: context.paths.quarantineId,
    quarantinePath: context.paths.quarantineDatabase,
    retainedArtifacts: [...context.effectLedgers.retained],
  };
}

export function quarantineHandoffRoutingStoreArtifact(
  storage: StoragePort,
  path: string,
  quarantineId: string,
  observations: HandoffRoutingStatusQuarantineObservations,
  assertOwned: () => void,
): HandoffRoutingStatusQuarantineResult {
  assertOwned();
  const retained = listHandoffRoutingStoreQuarantines(storage, path);
  assertOwned();
  if (retained.kind === 'undeterminable') return retained;
  const retainedCoordinate = retained.entries.find((entry) => entry.id === quarantineId);
  const incomplete = retained.entries.filter((entry) => entry.state === 'incomplete' && entry.id !== quarantineId);
  if (incomplete.length > 1 || retained.overflow) throw new HandoffRoutingStatusQuarantineCapacityError();
  const incompleteEntry = incomplete[0];
  if (incompleteEntry !== undefined) {
    assertOwned();
    return { kind: 'incomplete-quarantine', quarantineId: incompleteEntry.id };
  }
  if (retained.entries.length >= MAX_HANDOFF_ROUTING_STATUS_QUARANTINES && retainedCoordinate === undefined) {
    throw new HandoffRoutingStatusQuarantineCapacityError();
  }
  if (!CANONICAL_UUID_PATTERN.test(quarantineId)) {
    throw new Error('Routing-status quarantine ID must be a canonical lowercase UUID.');
  }

  const context: HandoffRoutingStatusQuarantineMaintenanceContext = {
    storage,
    paths: handoffRoutingStatusMaintenancePaths(path, quarantineId),
    assertOwned,
    mutationState: { mutationAttempted: false },
    effectLedgers: {
      moved: createHandoffRoutingStatusArtifactEffects<HandoffRoutingStatusQuarantineArtifact>(),
      removed: createHandoffRoutingStatusArtifactEffects<HandoffRoutingStatusQuarantineAffectedArtifact>(),
      retained: new Set<HandoffRoutingStatusQuarantineArtifact>(),
    },
    syncedDirectories: new Set<HandoffRoutingStatusQuarantineSyncedDirectory>(),
  };

  for (const [sourcePath, artifactPath, artifact] of [
    [context.paths.sourceDatabase, context.paths.quarantineDatabase, 'database'],
    [context.paths.sourceWal, context.paths.quarantineWal, 'wal'],
  ] as const) {
    const observation = observeHandoffRoutingPath(storage, artifactPath);
    assertOwned();
    if (observation.kind === 'undeterminable') {
      return { kind: 'undeterminable', cause: 'artifact-observation-failed', errcode: observation.error.errcode };
    }
    if (observation.kind === 'present') {
      const sourceObservation = observeHandoffRoutingPath(storage, sourcePath);
      assertOwned();
      if (sourceObservation.kind === 'undeterminable') {
        return {
          kind: 'undeterminable',
          cause: 'artifact-observation-failed',
          errcode: sourceObservation.error.errcode,
        };
      }
      if (
        sourceObservation.kind === 'present' &&
        sourceObservation.stat.dev === observation.stat.dev &&
        sourceObservation.stat.ino === observation.stat.ino
      ) {
        continue;
      }
      return {
        kind: 'quarantine-coordinate-occupied',
        quarantineId,
        quarantinePath: context.paths.quarantineDatabase,
        artifact,
      };
    }
  }

  try {
    attemptHandoffRoutingStatusMutation(context, () =>
      storage.mkdirSync(context.paths.quarantineRoot, { recursive: true, mode: 0o700 }),
    );
  } catch {
    return quarantineStorageFailure(context, 'root-create-failed');
  }
  if (!syncQuarantineMoveDirectory(context, context.paths.sourceDirectory, 'source')) {
    return quarantineStorageFailure(context, 'directory-sync-failed');
  }
  const ownershipFailureAfterRoot = assertOwnedAfterQuarantineMutation(context);
  if (ownershipFailureAfterRoot !== null) return ownershipFailureAfterRoot;

  const walDisposition = disposeQuarantineWal(context, observations);
  if (walDisposition.kind === 'finished') return walDisposition.result;

  const shmFailure = removeQuarantineShm(context);
  if (shmFailure !== null) return shmFailure;

  const detachedWalHadNoMain =
    observations.firstMainState === 'absent' &&
    observations.firstWalReceipt.kind === 'non-empty' &&
    observations.guardedMainState === 'absent' &&
    observations.guardedWalReceipt.kind === 'non-empty';
  if (detachedWalHadNoMain) {
    if (!walDisposition.walMoved) return quarantineStorageFailure(context, 'artifact-move-failed');
    return {
      kind: 'quarantined-incomplete',
      quarantineId,
      quarantinePath: context.paths.quarantineDatabase,
      retainedArtifacts: ['wal'],
    };
  }

  return moveMainDatabaseToQuarantine(context);
}

function unlinkIfPresent(storage: StoragePort, path: string): boolean {
  try {
    storage.unlinkSync(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

function syncQuarantineClear(context: HandoffRoutingStatusQuarantineClearMaintenanceContext): boolean {
  const synced = attemptHandoffRoutingStatusMutation(context, () =>
    context.storage.syncDirectoryDurableSync(context.paths.quarantineRoot),
  );
  if (synced) context.syncedDirectories.add('quarantine');
  return synced;
}

function quarantineClearStorageFailure(
  context: HandoffRoutingStatusQuarantineClearMaintenanceContext,
  cause: Extract<HandoffRoutingStatusQuarantineClearStoreResult, { kind: 'quarantine-clear-storage-failed' }>['cause'],
): HandoffRoutingStatusQuarantineClearStoreResult {
  return {
    kind: 'quarantine-clear-storage-failed',
    quarantineId: context.paths.quarantineId,
    quarantinePath: context.paths.quarantineDatabase,
    removedArtifacts: [...context.effectLedgers.removed.durableArtifacts],
    observedRemovedArtifacts: [...context.effectLedgers.removed.observedArtifacts],
    syncedDirectories: [...context.syncedDirectories],
    cause,
  };
}

function assertOwnedAfterQuarantineClearMutation(
  context: HandoffRoutingStatusQuarantineClearMaintenanceContext,
): HandoffRoutingStatusQuarantineClearStoreResult | null {
  const cause = ownershipFailureCauseAfterMutation(context);
  return cause === null ? null : quarantineClearStorageFailure(context, cause);
}

export function clearHandoffRoutingStoreQuarantine(
  storage: StoragePort,
  path: string,
  quarantineId: string,
  assertOwned: () => void,
): HandoffRoutingStatusQuarantineClearStoreResult {
  if (!CANONICAL_UUID_PATTERN.test(quarantineId)) return { kind: 'quarantine-not-found', quarantineId };
  const context: HandoffRoutingStatusQuarantineClearMaintenanceContext = {
    storage,
    paths: handoffRoutingStatusMaintenancePaths(path, quarantineId),
    assertOwned,
    mutationState: { mutationAttempted: false },
    effectLedgers: {
      removed: createHandoffRoutingStatusArtifactEffects<HandoffRoutingStatusQuarantineArtifact>(),
    },
    syncedDirectories: new Set<HandoffRoutingStatusQuarantineSyncedDirectory>(),
  };

  assertOwned();
  const artifacts: HandoffRoutingStatusQuarantineArtifact[] = [];
  for (const [artifactPath, artifact] of [
    [context.paths.quarantineDatabase, 'database'],
    [context.paths.quarantineWal, 'wal'],
  ] as const) {
    const observation = observeHandoffRoutingPath(storage, artifactPath);
    assertOwned();
    if (observation.kind === 'undeterminable') {
      return {
        kind: 'quarantine-clear-undeterminable',
        quarantineId,
        quarantinePath: context.paths.quarantineDatabase,
        artifact,
        errcode: observation.error.errcode,
      };
    }
    if (observation.kind === 'present') artifacts.push(artifact);
  }
  if (artifacts.length === 0) return { kind: 'quarantine-not-found', quarantineId };
  const entry: HandoffRoutingStatusQuarantineEntry = {
    id: quarantineId,
    quarantinePath: context.paths.quarantineDatabase,
    state: artifacts.includes('database') ? 'complete' : 'incomplete',
    artifacts,
  };
  for (const [artifactPath, artifact] of [
    [context.paths.quarantineWal, 'wal'],
    [context.paths.quarantineDatabase, 'database'],
  ] as const) {
    let removed: boolean;
    try {
      removed = attemptHandoffRoutingStatusMutation(context, () => unlinkIfPresent(storage, artifactPath));
    } catch {
      return quarantineClearStorageFailure(context, 'artifact-remove-failed');
    }
    if (removed) {
      const removalDurability = context.effectLedgers.removed.recordAfterBarrier(
        artifact,
        (): HandoffRoutingStatusDurabilityBarrierResult<'directory-sync-failed' | 'ownership-lost'> => {
          const ownershipFailure = ownershipFailureCauseAfterMutation(context);
          if (ownershipFailure !== null) return { kind: 'failed', cause: ownershipFailure };
          try {
            return syncQuarantineClear(context)
              ? { kind: 'durable' }
              : { kind: 'failed', cause: 'directory-sync-failed' };
          } catch {
            return { kind: 'failed', cause: 'directory-sync-failed' };
          }
        },
      );
      if (removalDurability.kind === 'failed') {
        return quarantineClearStorageFailure(context, removalDurability.cause);
      }
    }
    const ownershipFailure = assertOwnedAfterQuarantineClearMutation(context);
    if (ownershipFailure !== null) return ownershipFailure;
  }
  return { kind: 'cleared', entry };
}
