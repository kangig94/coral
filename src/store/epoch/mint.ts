import { type StoragePort } from '../../infra/port-types.js';
import { type FileLockLease, createSharedFileLockSync } from '../../infra/fs-lock.js';
import { type Runtime } from '../../runtime/ports.js';
import {
  type SuccessionWriterGeneration,
  observeSuccessionWriterGeneration,
  joinSuccessionWriterGeneration,
  withSuccessionAttemptMayAdvance,
  assertSuccessionAttemptMayAdvance,
  advanceSuccessionWriterGeneration,
  observeSuccessionServing,
} from '../succession-writer-generation.js';
import {
  reconcileProtectedEpochs,
  protectStoreEpoch,
  StoreEpochOpenerHeldError,
  resolveProtectedEpoch,
} from './protection.js';
import { observeStorePath } from '../path-observation.js';
import { errorMessage } from '../../infra/error-format.js';
import { join } from 'node:path';
import { openWritableStoreDatabase, classifyStoreFile } from '../db.js';
import { initializeCustodyLedger } from '../custody-ledger.js';
import { recordEpochCustodyCoverage } from './closure.js';
import { auditSweepFailure } from './sweep-audit.js';
import { errorCode } from './classification.js';
import {
  type StoreEpoch,
  type StoreEpochOptions,
  type StoreEpochClassification,
  type StoreEpochSettlement,
} from './types.js';
import {
  successorEpoch,
  epochDirectory,
  observeStoreEpochs,
  observeContainedDirectory,
  observeStoreEpochLock,
  resolvedStoreEpoch,
  decodeResolvedStoreEpoch,
} from './observation.js';
import { readPendingProtections, SUPERSEDED_OPENER_DRAIN_MS, recordPendingProtection } from './pending-protection.js';
import {
  STORE_LOCK_FILE_NAME,
  SQLITE_BUSY_ERRCODE,
  STORE_DATABASE_FILE_NAME,
  RETIREMENT_ATTEMPT_FILE_NAME,
  PRIVATE_MINT_CONSTRUCTION_PREFIX,
  MINT_PREPARATION_DIRECTORY_PREFIX,
  MINT_DIRECTORY_PREFIX,
} from './constants.js';
import { writeEpochMetadata, metadataFor } from './metadata.js';
import { openPublishedEpoch } from './published.js';
import { removeEpochEntry } from './sweep.js';

function cleanupMint(storage: StoragePort, mint: string): void {
  try {
    storage.rmSync(mint, { recursive: true, force: true });
  } catch (error: unknown) {
    auditSweepFailure(mint, error);
  }
}

type MintStageMoveResult = Readonly<{ kind: 'moved' }> | Readonly<{ kind: 'contended' | 'swept' }>;

function advanceMintStagingDirectory(
  storage: StoragePort,
  source: string,
  destination: string,
  lease: FileLockLease,
): MintStageMoveResult {
  try {
    storage.renameSync(source, destination);
    return { kind: 'moved' };
  } catch (error: unknown) {
    lease();
    cleanupMint(storage, source);
    const code = errorCode(error);
    if (code === 'ENOTDIR' || code === 'ENOTEMPTY' || code === 'EEXIST') return { kind: 'contended' };
    if (code === 'ENOENT') return { kind: 'swept' };
    throw error;
  }
}

export function selectSuccessor(
  runtime: Runtime,
  dbDir: string,
  current: StoreEpoch | null,
): Readonly<{ kind: 'selected'; epoch: StoreEpoch }> {
  let candidate = successorEpoch(current);
  const attempts = runtime.storage.readdirSync(dbDir).length + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      runtime.storage.lstatSync(epochDirectory(dbDir, candidate));
    } catch (error: unknown) {
      if (errorCode(error) === 'ENOENT') return { kind: 'selected', epoch: candidate };
      if (error instanceof Error) {
        error.message = `The lstat syscall for store epoch successor '${epochDirectory(dbDir, candidate)}' was refused with errno ${errorCode(error) ?? 'UNKNOWN'}: ${error.message}`;
      }
      throw error;
    }
    candidate = successorEpoch(candidate);
  }
  return { kind: 'selected', epoch: candidate };
}

type EpochMint = Readonly<{
  runtime: Runtime;
  options: StoreEpochOptions;
  dbDir: string;
  supersedes: StoreEpoch | null;
  successor: StoreEpoch;
  classification: StoreEpochClassification;
  retirement?: Readonly<{ attemptId: string; expectedGeneration: SuccessionWriterGeneration }>;
}>;

type MintPublication =
  | Readonly<{ kind: 'published'; lease: FileLockLease }>
  | Readonly<{ kind: 'contended' | 'swept' }>;

type MintStaging = Readonly<{ construction: string; preparation: string; mint: string }>;

function protectMintPredecessors(context: EpochMint): void {
  const { runtime, dbDir, supersedes, classification } = context;
  reconcileProtectedEpochs(runtime, dbDir);
  const writerGeneration = observeSuccessionWriterGeneration(runtime);
  const pendingProtections = readPendingProtections(runtime).records.filter((pending) => pending.storeRoot === dbDir);
  for (const observation of observeStoreEpochs(runtime.storage, dbDir)) {
    const directory = epochDirectory(dbDir, observation.epoch);
    const directoryProof = observeContainedDirectory(runtime.storage, dbDir, directory);
    if (directoryProof.kind !== 'proven') continue;
    if (observeStoreEpochLock(runtime.storage, dbDir, observation.epoch, directoryProof).kind !== 'proven') continue;
    const unavailableWriterEpoch =
      classification.kind === 'unavailable' &&
      observation.epoch === supersedes &&
      (writerGeneration === null || (writerGeneration.storeRoot === dbDir && writerGeneration.epoch === supersedes));
    try {
      protectStoreEpoch(runtime, resolvedStoreEpoch(dbDir, observation.epoch), SUPERSEDED_OPENER_DRAIN_MS);
    } catch (error: unknown) {
      if (observeStorePath(runtime.storage, directory) === 'absent') continue;
      if (
        !unavailableWriterEpoch &&
        !(error instanceof StoreEpochOpenerHeldError) &&
        !pendingProtections.some((pending) => pending.epoch === observation.epoch)
      ) {
        throw error;
      }
      const pending = recordPendingProtection(runtime, dbDir, observation.epoch, errorMessage(error));
      if (pending.kind === 'unrecorded') {
        throw pending.cause;
      }
    }
  }
}

function acquireMintStagingLease(
  runtime: Runtime,
  staging: MintStaging,
): Readonly<{ kind: 'held'; lease: FileLockLease }> | Readonly<{ kind: 'contended' | 'swept' }> {
  const { construction, preparation, mint } = staging;
  let mintLease: FileLockLease;
  try {
    mintLease = createSharedFileLockSync(join(construction, STORE_LOCK_FILE_NAME));
  } catch (error: unknown) {
    let observation: ReturnType<typeof observeStorePath>;
    try {
      observation = observeStorePath(runtime.storage, construction);
    } finally {
      cleanupMint(runtime.storage, construction);
    }
    if (observation === 'absent') return { kind: 'swept' };
    if (error instanceof Error && 'errcode' in error && error.errcode === SQLITE_BUSY_ERRCODE) {
      return { kind: 'contended' };
    }
    throw error;
  }
  const preparationMove = advanceMintStagingDirectory(runtime.storage, construction, preparation, mintLease);
  if (preparationMove.kind !== 'moved') return preparationMove;
  const mintMove = advanceMintStagingDirectory(runtime.storage, preparation, mint, mintLease);
  if (mintMove.kind !== 'moved') return mintMove;
  return { kind: 'held', lease: mintLease };
}

function populateEpochMint(context: EpochMint, mint: string): void {
  const { runtime, options, dbDir, supersedes, successor, classification, retirement } = context;
  const opened = openWritableStoreDatabase({
    path: join(mint, STORE_DATABASE_FILE_NAME),
    storage: runtime.storage,
    storeFormat: options.storeFormat,
    flavor: runtime.flavor,
    busyTimeoutMs: options.startupBusyTimeoutMs,
    writerEntitlement: joinSuccessionWriterGeneration(
      runtime,
      observeSuccessionWriterGeneration(runtime) ?? { storeRoot: dbDir, epoch: supersedes ?? successor },
    ),
  });
  if (opened.kind !== 'opened') {
    throw new Error(`A private store mint was classified as ${opened.classification.kind}.`);
  }
  opened.db.close();
  writeEpochMetadata(
    runtime.storage,
    mint,
    metadataFor(supersedes, classification, options.build, new Date(runtime.time.now()).toISOString()),
  );
  if (
    retirement !== undefined &&
    !runtime.storage.writeAtomicDurableSync(
      join(mint, RETIREMENT_ATTEMPT_FILE_NAME),
      `${JSON.stringify({ version: 'v1', attemptId: retirement.attemptId })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  )
    throw new Error('Retirement mint attempt could not be recorded durably.');
  const ledgerId = initializeCustodyLedger(runtime, runtime.paths.coral.coordinator.runDir);
  recordEpochCustodyCoverage(runtime, mint, ledgerId);
}

export function mintNextEpoch(context: EpochMint): MintPublication {
  const { runtime, dbDir, successor, retirement } = context;
  protectMintPredecessors(context);
  const id = runtime.ids.uuid();
  const construction = join(dbDir, `${PRIVATE_MINT_CONSTRUCTION_PREFIX}${id}`);
  const preparation = join(dbDir, `${MINT_PREPARATION_DIRECTORY_PREFIX}${id}`);
  const mint = join(dbDir, `${MINT_DIRECTORY_PREFIX}${id}`);
  const staging = acquireMintStagingLease(runtime, { construction, preparation, mint });
  if (staging.kind !== 'held') return staging;
  let leaseTransferred = false;
  try {
    populateEpochMint(context, mint);
    try {
      const publish = () => {
        runtime.storage.renameSync(mint, epochDirectory(dbDir, successor));
        if (!runtime.storage.syncDirectoryDurableSync(dbDir)) {
          throw new Error(`Failed to durably sync store epoch root '${dbDir}'.`);
        }
      };
      if (retirement === undefined) publish();
      else withSuccessionAttemptMayAdvance(runtime, retirement.expectedGeneration, retirement.attemptId, publish);
      leaseTransferred = true;
      return { kind: 'published', lease: staging.lease };
    } catch (error: unknown) {
      const code = errorCode(error);
      if (code === 'ENOTDIR' || code === 'ENOTEMPTY' || code === 'EEXIST') return { kind: 'contended' };
      if (code === 'ENOENT') return { kind: 'swept' };
      throw error;
    }
  } finally {
    cleanupMint(runtime.storage, construction);
    cleanupMint(runtime.storage, preparation);
    cleanupMint(runtime.storage, mint);
    if (!leaseTransferred) staging.lease();
  }
}

/**
 * `beforeGenerationTransfer` runs after the successor epoch is published and before the writer generation moves to
 * it; a throw there must release the published mint exactly as a failed transfer does.
 */
export async function mintRetiredStoreEpoch(
  runtime: Runtime,
  options: Omit<StoreEpochOptions, 'path'> & { readonly path?: never },
  incumbentEpochKey: string,
  attemptId: string,
  expectedGeneration: SuccessionWriterGeneration,
  beforeGenerationTransfer: () => void | Promise<void>,
): Promise<StoreEpochSettlement & { generation: SuccessionWriterGeneration }> {
  const expected = decodeResolvedStoreEpoch(runtime, incumbentEpochKey);
  if (expected === undefined || expected.path === ':memory:' || expected.lineageKey === undefined) {
    throw new Error('Retiring epoch is unproven.');
  }
  const dbDir = runtime.storage.realpathSync(runtime.paths.coral.store.dbDir);
  const protectedEpoch = resolveProtectedEpoch(runtime, dbDir, expected.lineageKey);
  if (protectedEpoch === null || protectedEpoch.epoch !== expected.epoch) {
    throw new Error('Retiring epoch has no protected address.');
  }
  const classification = classifyStoreFile(protectedEpoch.path, runtime.storage, options.storeFormat);
  if (classification.kind !== 'older-incompatible' && classification.kind !== 'newer-incompatible') {
    throw new Error('Retirement mint requires a readable incompatible incumbent format.');
  }
  const successor = successorEpoch(expected.epoch);
  assertSuccessionAttemptMayAdvance(runtime, expectedGeneration, attemptId);
  const published = mintNextEpoch({
    runtime,
    options,
    dbDir,
    supersedes: expected.epoch,
    successor,
    classification,
    retirement: { attemptId, expectedGeneration },
  });
  if (published.kind !== 'published') throw new Error(`Retirement mint was ${published.kind}.`);
  let generation: SuccessionWriterGeneration;
  try {
    await beforeGenerationTransfer();
    generation = advanceSuccessionWriterGeneration(
      runtime,
      expectedGeneration,
      { storeRoot: dbDir, epoch: successor },
      attemptId,
    );
  } catch (error: unknown) {
    published.lease();
    discardUnservedRetirementMint(runtime, incumbentEpochKey, attemptId);
    throw error;
  }
  return { ...openPublishedEpoch(runtime, options, dbDir, expected.epoch, successor, published.lease), generation };
}

export type UnservedMintDiscard =
  | Readonly<{ kind: 'discarded' | 'absent' | 'serving' }>
  | Readonly<{ kind: 'held'; reason: string }>;

export function discardUnservedRetirementMint(
  runtime: Runtime,
  incumbentEpochKey: string,
  attemptId: string,
): UnservedMintDiscard {
  if (observeSuccessionServing(runtime, attemptId) !== null) return { kind: 'serving' };
  const incumbent = decodeResolvedStoreEpoch(runtime, incumbentEpochKey);
  if (incumbent === undefined) return { kind: 'held', reason: 'retirement source is unproven' };
  let marker: unknown;
  let dbDir: string;
  let successor: StoreEpoch;
  try {
    dbDir = runtime.storage.realpathSync(runtime.paths.coral.store.dbDir);
    successor = successorEpoch(incumbent.epoch);
    marker = JSON.parse(
      runtime.storage.readFileSync(join(epochDirectory(dbDir, successor), RETIREMENT_ATTEMPT_FILE_NAME), 'utf-8'),
    ) as unknown;
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { kind: 'absent' };
    return { kind: 'held', reason: `retirement mint marker is unreadable: ${errorMessage(error)}` };
  }

  if (typeof marker !== 'object' || marker === null || !('attemptId' in marker) || marker.attemptId !== attemptId) {
    return { kind: 'absent' };
  }
  const removed = removeEpochEntry(runtime, dbDir, successor);
  return removed === 'removed' ? { kind: 'discarded' } : { kind: 'held', reason: `removal was ${removed}` };
}
