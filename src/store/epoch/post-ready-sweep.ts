import { type StoragePort } from '../../infra/port-types.js';
import { type Runtime } from '../../runtime/ports.js';
import { attemptExclusiveFileLockSync, type FileLockLease } from '../../infra/fs-lock.js';
import { basename, join } from 'node:path';
import { readEpochKey, readOrCreateEpochKey } from './key.js';
import { observeStorePath } from '../path-observation.js';
import { closureCapability } from './closure.js';
import { reconcileProtectedEpochs, removeClosedProtectedEpoch, protectedDeletionResidues } from './protection.js';
import { STORE_RESET_QUARANTINE_DIRECTORY } from '../reset-incident.js';
import { treeStaysOnDeviceAsync, type LockedRemoval, renameForReaping, removeEpochEntry } from './sweep.js';
import { auditSweepFailure, auditSweepSkip } from './sweep-audit.js';
import { errorCode } from './classification.js';
import {
  observeContainedDirectoryAsync,
  observeContainedRegularFileAsync,
  resolvedStoreEpoch,
  epochDirectory,
  lineageJobEpochKey,
  type StoreEpochObservation,
  observeStoreEpochs,
  garbageStoreEpochs,
  compareEpoch,
} from './observation.js';
import {
  REAPING_DIRECTORY_PREFIX,
  STORE_DATABASE_FILE_NAME,
  STORE_LOCK_FILE_NAME,
  RETAINED_REAPING_DIRECTORY_PREFIX,
  EPOCH_DIRECTORY_PATTERN,
  EPOCH_HOLDER_PREFIX,
} from './constants.js';
import { type StoreEpoch, type StoreEpochSweepResult, type ResolvedStoreEpoch } from './types.js';
import { inspectStoreEpochHolderAsync } from './holder.js';
import { readEpochMetadata } from './metadata.js';
import { retryPendingProtections } from './pending-protection.js';
import { isStoreEpochResidue } from './residue.js';

async function yieldSweepTurn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}

async function removeDuringPostReadySweep(storage: StoragePort, dbDir: string, path: string): Promise<boolean> {
  try {
    const observed = await storage.lstat(path);
    const device = storage.lstatSync(dbDir, { bigint: true }).dev;
    if (!(await treeStaysOnDeviceAsync(storage, path, device))) {
      auditSweepFailure(path, new Error('Recursive removal crossed the store device boundary.'));
      return false;
    }
    if (observed.isDirectory() && !observed.isSymbolicLink()) {
      await storage.rm(path, { recursive: true, force: true });
    } else {
      await storage.unlink(path);
    }
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return true;
    auditSweepFailure(path, error);
    return false;
  }
}

async function removeWhileExclusivelyLockedAsync(
  runtime: Runtime,
  dbDir: string,
  lockPath: string,
  targetPath: string,
): Promise<LockedRemoval> {
  const attempt = attemptExclusiveFileLockSync(lockPath);
  if (attempt.kind === 'malformed') return removeAfterReapingRenameAsync(runtime, dbDir, targetPath);
  if (attempt.kind === 'unobservable') {
    auditSweepFailure(lockPath, attempt.cause);
    return 'target-failed';
  }
  if (attempt.kind === 'contended') return 'locked';
  const reapingPath = renameForReaping(runtime, dbDir, targetPath);
  const removal =
    reapingPath === null
      ? 'removed'
      : reapingPath === targetPath
        ? 'target-failed'
        : (await removeDuringPostReadySweep(runtime.storage, dbDir, reapingPath))
          ? 'removed'
          : 'target-failed';
  try {
    attempt.lease();
  } catch (error: unknown) {
    auditSweepFailure(lockPath, error);
    return 'lock-release-failed';
  }
  return removal;
}

async function removeAfterReapingRenameAsync(
  runtime: Runtime,
  dbDir: string,
  targetPath: string,
): Promise<LockedRemoval> {
  const reapingPath = renameForReaping(runtime, dbDir, targetPath);
  if (reapingPath === null) return 'removed';
  if (reapingPath === targetPath) return 'target-failed';
  return (await removeDuringPostReadySweep(runtime.storage, dbDir, reapingPath)) ? 'removed' : 'target-failed';
}

type ProvenSweepDirectory = Extract<Awaited<ReturnType<typeof observeContainedDirectoryAsync>>, { kind: 'proven' }>;
type AbandonedDirectoryRemoval = LockedRemoval | 'retained' | 'unobservable';

async function retainUnmarkedReapingDirectory(
  runtime: Runtime,
  dbDir: string,
  path: string,
  root: ProvenSweepDirectory,
): Promise<AbandonedDirectoryRemoval> {
  const lockPath = join(path, STORE_LOCK_FILE_NAME);
  const lock = await observeContainedRegularFileAsync(runtime.storage, path, lockPath, root);
  if (lock.kind === 'unobservable') return 'unobservable';
  let release: FileLockLease | undefined;
  if (lock.kind === 'proven') {
    const attempt = attemptExclusiveFileLockSync(lockPath);
    if (attempt.kind === 'contended') return 'locked';
    if (attempt.kind === 'malformed') return 'unobservable';
    if (attempt.kind === 'unobservable') {
      auditSweepFailure(lockPath, attempt.cause);
      return 'target-failed';
    }
    release = attempt.lease;
  }
  const retained = join(dbDir, `${RETAINED_REAPING_DIRECTORY_PREFIX}${runtime.ids.uuid()}`);
  let outcome: LockedRemoval | 'retained';
  try {
    runtime.storage.renameSync(path, retained);
    outcome = runtime.storage.syncDirectoryDurableSync(dbDir) ? 'retained' : 'target-failed';
  } catch (error: unknown) {
    auditSweepFailure(path, error);
    outcome = 'target-failed';
  }
  if (release !== undefined) {
    try {
      release();
    } catch (error: unknown) {
      auditSweepFailure(lockPath, error);
      return 'lock-release-failed';
    }
  }
  return outcome;
}

function validClosedReapingMarker(marker: unknown): marker is { version: 'v1'; epoch: string; epochKey: string } {
  return !(
    typeof marker !== 'object' ||
    marker === null ||
    !('version' in marker) ||
    marker.version !== 'v1' ||
    !('epoch' in marker) ||
    typeof marker.epoch !== 'string' ||
    !EPOCH_DIRECTORY_PATTERN.test(`epoch-${marker.epoch}`) ||
    !('epochKey' in marker) ||
    typeof marker.epochKey !== 'string' ||
    !marker.epochKey.endsWith(`:${marker.epoch}`)
  );
}

function closedReapingDirectoryRemovable(
  runtime: Runtime,
  dbDir: string,
  path: string,
  markerPath: string,
  resultsReleased: (epochKey: string) => boolean,
): boolean {
  try {
    const marker = JSON.parse(runtime.storage.readFileSync(markerPath, 'utf-8')) as unknown;
    if (
      !validClosedReapingMarker(marker) ||
      readEpochKey(runtime, {
        ...resolvedStoreEpoch(dbDir, marker.epoch),
        path: join(path, STORE_DATABASE_FILE_NAME),
      }) !== marker.epochKey ||
      observeStorePath(runtime.storage, epochDirectory(dbDir, marker.epoch)) !== 'absent' ||
      closureCapability(runtime, runtime.paths.coral.generation.dataRoot, marker.epochKey) === null ||
      !resultsReleased(lineageJobEpochKey(dbDir, marker.epochKey))
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

async function removeReapingStoreDirectory(
  runtime: Runtime,
  dbDir: string,
  path: string,
  root: ProvenSweepDirectory,
  resultsReleased: ((epochKey: string) => boolean) | undefined,
): Promise<AbandonedDirectoryRemoval> {
  const database = await observeContainedRegularFileAsync(
    runtime.storage,
    path,
    join(path, STORE_DATABASE_FILE_NAME),
    root,
  );
  if (database.kind === 'disproven') return removeAfterReapingRenameAsync(runtime, dbDir, path);
  const markerPath = join(path, '.coral-closed-reaping.v1.json');
  const markerProof = await observeContainedRegularFileAsync(runtime.storage, path, markerPath, root);
  if (markerProof.kind === 'disproven') return retainUnmarkedReapingDirectory(runtime, dbDir, path, root);
  if (markerProof.kind !== 'proven' || resultsReleased === undefined) return 'unobservable';
  if (!closedReapingDirectoryRemovable(runtime, dbDir, path, markerPath, resultsReleased)) return 'unobservable';
  const lockPath = join(path, STORE_LOCK_FILE_NAME);
  const lock = await observeContainedRegularFileAsync(runtime.storage, path, lockPath, root);
  return lock.kind === 'proven' ? removeWhileExclusivelyLockedAsync(runtime, dbDir, lockPath, path) : 'unobservable';
}

async function removeOrdinaryStoreDirectory(
  runtime: Runtime,
  dbDir: string,
  path: string,
  root: ProvenSweepDirectory,
): Promise<AbandonedDirectoryRemoval> {
  const lockPath = join(path, STORE_LOCK_FILE_NAME);
  const lock = await observeContainedRegularFileAsync(runtime.storage, path, lockPath, root);
  if (lock.kind === 'unobservable') return 'unobservable';
  if (lock.kind === 'disproven') {
    try {
      runtime.storage.rmdirSync(path);
      return 'removed';
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === 'ENOENT') return 'removed';
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return 'unobservable';
      auditSweepFailure(path, error);
      return 'target-failed';
    }
  }
  return removeWhileExclusivelyLockedAsync(runtime, dbDir, lockPath, path);
}

async function removeAbandonedStoreDirectory(
  runtime: Runtime,
  dbDir: string,
  path: string,
  resultsReleased?: (epochKey: string) => boolean,
): Promise<AbandonedDirectoryRemoval> {
  const root = await observeContainedDirectoryAsync(runtime.storage, dbDir, path);
  if (root.kind === 'unobservable') return 'unobservable';
  if (root.kind === 'disproven') return removeAfterReapingRenameAsync(runtime, dbDir, path);
  return basename(path).startsWith(REAPING_DIRECTORY_PREFIX)
    ? removeReapingStoreDirectory(runtime, dbDir, path, root, resultsReleased)
    : removeOrdinaryStoreDirectory(runtime, dbDir, path, root);
}

async function syncDirectoryDurable(storage: StoragePort, path: string): Promise<boolean> {
  try {
    return await storage.syncDirectoryDurable(path);
  } catch (error: unknown) {
    auditSweepFailure(path, error);
    return false;
  }
}

type PostReadyStoreEpochSweepContext = Readonly<{
  runtime: Runtime;
  dbDir: string;
  openEpoch: StoreEpoch;
  signal: AbortSignal | undefined;
}>;

type PostReadySweepMutationState = { pending: boolean };

async function syncPostReadySweepMutations(
  runtime: Runtime,
  dbDir: string,
  mutations: PostReadySweepMutationState,
): Promise<boolean> {
  if (!mutations.pending) return true;
  if (!(await syncDirectoryDurable(runtime.storage, dbDir))) return false;
  mutations.pending = false;
  return true;
}

type PostReadyHolderCleanupResult =
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{
      kind: 'cleaned';
      deletionFailed: boolean;
      lockReleaseFailed: boolean;
      unobservableHolder: boolean;
    }>;

async function cleanPostReadyStoreEpochHolders(
  context: PostReadyStoreEpochSweepContext,
  entries: readonly string[],
  mutations: PostReadySweepMutationState,
): Promise<PostReadyHolderCleanupResult> {
  const { runtime, dbDir, signal } = context;
  let deletionFailed = false;
  let lockReleaseFailed = false;
  let unobservableHolder = false;
  for (const entry of entries) {
    if (signal?.aborted) return { kind: 'cancelled' };
    if (!entry.startsWith(EPOCH_HOLDER_PREFIX)) {
      await yieldSweepTurn();
      continue;
    }
    if (!entry.endsWith('.json') && !entry.endsWith('.json.tmp')) {
      unobservableHolder = true;
      continue;
    }
    const holder = await inspectStoreEpochHolderAsync(runtime, dbDir, entry);
    if (holder?.state === 'live') continue;
    if (holder?.state === 'unobservable' && !holder.removable) {
      unobservableHolder = true;
      continue;
    }
    try {
      if (holder?.path !== undefined) {
        mutations.pending = true;
        const removed = await removeDuringPostReadySweep(runtime.storage, dbDir, holder.path);
        deletionFailed ||= !removed;
      }
    } finally {
      try {
        holder?.proof?.();
      } catch (error: unknown) {
        auditSweepFailure(holder?.path ?? join(dbDir, entry), error);
        lockReleaseFailed = true;
      }
    }
    await yieldSweepTurn();
  }
  return { kind: 'cleaned', deletionFailed, lockReleaseFailed, unobservableHolder };
}

type PostReadyEpochReapingResult =
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{
      kind: 'reaped';
      complete: boolean;
      liveHolder: boolean;
      lockReleaseFailed: boolean;
      unobservableResidue: boolean;
    }>;

async function reapPostReadyStoreEpochEntries(
  context: PostReadyStoreEpochSweepContext,
  entries: readonly string[],
  residueEntries: ReadonlySet<string>,
  mutations: PostReadySweepMutationState,
  resultsReleased?: (epochKey: string) => boolean,
): Promise<PostReadyEpochReapingResult> {
  const { runtime, dbDir, signal } = context;
  let complete = true;
  let liveHolder = false;
  let lockReleaseFailed = false;
  let unobservableResidue = false;
  for (const entry of entries) {
    if (signal?.aborted) return { kind: 'cancelled' };
    if (residueEntries.has(entry)) {
      const wasPending = mutations.pending;
      mutations.pending = true;
      const removal = await removeAbandonedStoreDirectory(runtime, dbDir, join(dbDir, entry), resultsReleased);
      if (removal === 'unobservable') {
        mutations.pending = wasPending;
        unobservableResidue = true;
        await yieldSweepTurn();
        continue;
      }
      if (removal === 'locked') {
        liveHolder = true;
        auditSweepSkip(join(dbDir, entry));
        await yieldSweepTurn();
        continue;
      }
      lockReleaseFailed ||= removal === 'lock-release-failed';
      complete = (removal === 'removed' || removal === 'retained') && complete;
    }
    await yieldSweepTurn();
  }
  return { kind: 'reaped', complete, liveHolder, lockReleaseFailed, unobservableResidue };
}

async function finishPostReadyStoreEpochSweep(
  runtime: Runtime,
  dbDir: string,
  mutations: PostReadySweepMutationState,
  result: StoreEpochSweepResult,
): Promise<StoreEpochSweepResult> {
  return (await syncPostReadySweepMutations(runtime, dbDir, mutations)) ? result : 'durability-sync-failed';
}

function postReadyProtectedRetentionBoundary(
  runtime: Runtime,
  dbDir: string,
  proven: readonly string[],
  protectedAddresses: ReturnType<typeof reconcileProtectedEpochs>,
): number | null {
  const allPublishedAt = [
    ...proven.map((epoch) => readEpochMetadata(runtime.storage, epochDirectory(dbDir, epoch))),
    ...protectedAddresses.map((address) => readEpochMetadata(runtime.storage, address.protectedPath)),
  ].map((metadata) => (metadata.kind === 'valid' ? Date.parse(metadata.value.publishedAt) : NaN));
  if (allPublishedAt.length < 3 || !allPublishedAt.every(Number.isFinite)) return null;
  const latestTwo = [...allPublishedAt].sort((left, right) => right - left).slice(0, 2);
  return Math.min(...latestTwo);
}

async function preparePostReadyStoreEpochSweep(
  context: PostReadyStoreEpochSweepContext,
  mutations: PostReadySweepMutationState,
): Promise<{ kind: 'ready'; entries: readonly string[] } | { kind: 'interrupted'; result: StoreEpochSweepResult }> {
  const { runtime, dbDir, openEpoch, signal } = context;
  if (signal?.aborted) return { kind: 'interrupted', result: 'cancelled' };
  retryPendingProtections(runtime, dbDir, openEpoch);
  let entries: readonly string[];
  try {
    entries = await runtime.storage.readdir(dbDir);
  } catch (error: unknown) {
    auditSweepFailure(dbDir, error);
    return { kind: 'interrupted', result: 'unobservable-metadata' };
  }
  if (signal?.aborted) return { kind: 'interrupted', result: 'cancelled' };

  const holderCleanup = await cleanPostReadyStoreEpochHolders(context, entries, mutations);
  if (holderCleanup.kind === 'cancelled') {
    return {
      kind: 'interrupted',
      result: await finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'cancelled'),
    };
  }
  if (!(await syncPostReadySweepMutations(runtime, dbDir, mutations))) {
    return { kind: 'interrupted', result: 'durability-sync-failed' };
  }
  if (holderCleanup.lockReleaseFailed) return { kind: 'interrupted', result: 'lock-release-failed' };
  if (holderCleanup.deletionFailed) return { kind: 'interrupted', result: 'deletion-failed' };
  if (holderCleanup.unobservableHolder) return { kind: 'interrupted', result: 'unobservable-holder' };
  return { kind: 'ready', entries };
}

export async function sweepStoreEpochsPostReady(
  runtime: Runtime,
  openStore: ResolvedStoreEpoch,
  options: { readonly signal?: AbortSignal; readonly resultsReleased?: (epochKey: string) => boolean } = {},
): Promise<StoreEpochSweepResult> {
  const context: PostReadyStoreEpochSweepContext = {
    runtime,
    dbDir: openStore.storeRoot,
    openEpoch: openStore.epoch,
    signal: options.signal,
  };
  const { dbDir, openEpoch, signal } = context;
  const mutations: PostReadySweepMutationState = { pending: false };

  const preparation = await preparePostReadyStoreEpochSweep(context, mutations);
  if (preparation.kind === 'interrupted') return preparation.result;
  const { entries } = preparation;

  const residueEntries = new Set(entries.filter((entry) => isStoreEpochResidue(entry)));
  const reaping = await reapPostReadyStoreEpochEntries(
    context,
    entries,
    residueEntries,
    mutations,
    options.resultsReleased,
  );
  if (reaping.kind === 'cancelled') {
    return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'cancelled');
  }

  if (signal?.aborted) {
    return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'cancelled');
  }
  let complete = reaping.complete;
  let unobservableEpoch = false;
  if (options.resultsReleased !== undefined) {
    let observations: readonly StoreEpochObservation[];
    try {
      observations = observeStoreEpochs(runtime.storage, dbDir);
    } catch {
      return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'unobservable-metadata');
    }
    const proven = observations.filter((entry) => entry.proof.kind === 'proven').map((entry) => entry.epoch);
    for (const epoch of garbageStoreEpochs(proven)) {
      if (signal?.aborted) return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'cancelled');
      const resolved = resolvedStoreEpoch(dbDir, epoch);
      let epochKey: string;
      try {
        epochKey = readOrCreateEpochKey(runtime, resolved);
      } catch (error: unknown) {
        auditSweepFailure(resolved.path, error);
        unobservableEpoch = true;
        continue;
      }
      if (
        closureCapability(runtime, runtime.paths.coral.generation.dataRoot, epochKey) === null ||
        !options.resultsReleased(lineageJobEpochKey(dbDir, epochKey))
      )
        continue;
      mutations.pending = true;
      const removal = removeEpochEntry(runtime, dbDir, epoch, epochKey);
      complete = removal === 'removed' && complete;
      await yieldSweepTurn();
    }
    const protectedAddresses = reconcileProtectedEpochs(runtime, dbDir);
    const retentionBoundary = postReadyProtectedRetentionBoundary(runtime, dbDir, proven, protectedAddresses);
    if (retentionBoundary !== null) {
      for (const address of protectedAddresses) {
        if (signal?.aborted) return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'cancelled');
        const metadata = readEpochMetadata(runtime.storage, address.protectedPath);
        if (metadata.kind !== 'valid' || Date.parse(metadata.value.publishedAt) >= retentionBoundary) continue;
        if (
          closureCapability(runtime, runtime.paths.coral.generation.dataRoot, address.epochKey) === null ||
          !options.resultsReleased(lineageJobEpochKey(dbDir, address.epochKey))
        )
          continue;
        const removal = removeClosedProtectedEpoch(runtime, address);
        complete = removal === 'removed' && complete;
        await yieldSweepTurn();
      }
    }
    for (const address of protectedDeletionResidues(runtime, dbDir)) {
      if (signal?.aborted) return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, 'cancelled');
      if (
        closureCapability(runtime, runtime.paths.coral.generation.dataRoot, address.epochKey) === null ||
        !options.resultsReleased(lineageJobEpochKey(dbDir, address.epochKey))
      )
        continue;
      complete = removeClosedProtectedEpoch(runtime, address) === 'removed' && complete;
      await yieldSweepTurn();
    }
  }
  if (compareEpoch(openEpoch, '1') >= 0) {
    mutations.pending = true;
    const removed = await removeDuringPostReadySweep(
      runtime.storage,
      dbDir,
      join(dbDir, STORE_RESET_QUARANTINE_DIRECTORY),
    );
    complete = removed && complete;
  }
  const result: StoreEpochSweepResult = reaping.lockReleaseFailed
    ? 'lock-release-failed'
    : !complete
      ? 'deletion-failed'
      : reaping.unobservableResidue || unobservableEpoch
        ? 'unobservable-metadata'
        : reaping.liveHolder
          ? 'live-holder'
          : 'complete';
  return finishPostReadyStoreEpochSweep(runtime, dbDir, mutations, result);
}
