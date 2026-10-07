import { sameEpoch } from './identity.js';
import { type Runtime } from '../../runtime/ports.js';
import { type StoreFormatDescription } from '../format-fingerprint.js';
import { type Database, openStoreDatabase, classifyStoreFile, openWritableStoreDatabase } from '../db.js';
import { dirname, join } from 'node:path';
import {
  joinSuccessionWriterGeneration,
  observeSuccessionWriterGeneration,
  handbackSuccessionWriterGeneration,
} from '../succession-writer-generation.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import { truncate } from '../../infra/text.js';
import { type FileLockLease } from '../../infra/fs-lock.js';
import { resolveProtectedEpoch, knownProtectedEpochAddresses, reconcileProtectedEpochs } from './protection.js';
import { readOrCreateEpochKey } from './key.js';
import { initializeCustodyLedger } from '../custody-ledger.js';
import { hasEpochCustodyCoverage } from './closure.js';
import { observeStorePath } from '../path-observation.js';
import {
  type ResolvedStoreEpoch,
  type StoreEpochClassification,
  type StoreEpochUnprovenCandidate,
  type StoreEpochOptions,
  type StoreEpochOpenFailureStage,
  type ExactStoreEpochOpen,
  type StoreEpochSettlement,
  type StoreEpoch,
} from './types.js';
import {
  resolveCurrentStore,
  observeContainedRegularFile,
  type StoreEpochObservation,
  type ProvenStoreEpochObservation,
  compareEpoch,
  resolveProvenStoreEpochAtPath,
  observeStoreEpochs,
  epochDirectory,
  observeContainedDirectory,
  epochPath,
  observeStoreEpochLock,
  resolvedStoreEpoch,
  inspectResolvedStoreEpochKey,
  encodeResolvedStoreEpoch,
  resolveStoreDbDir,
  currentProvenEpoch,
  resolveCurrentStoreEpoch,
} from './observation.js';
import { acquireStoreEpochReadLock, parkableEpochReadLease, registerStoreEpochHolder } from './holder.js';
import {
  STORE_EPOCH_CLASSIFICATION_STRING_MAX_LENGTH,
  STORE_EPOCH_CANDIDATE_DETAIL_LIMIT,
  STORE_EPOCH_OPEN_RETRY_BUDGET_MS,
  STORE_EPOCH_OPEN_RETRY_INTERVAL_MS,
} from './constants.js';
import {
  remainingStoreEpochRetryBudgetMs,
  unavailableClassification,
  classificationAfterLeaseRelease,
  logStoreEpochReplacement,
  storeEpochRetryDeadline,
  waitForStoreEpochRetry,
  isDecisiveStoreEpochFailure,
  classificationWithAttempts,
} from './classification.js';
import { assertProvenStoreOpenable, openPublishedEpoch, advanceWriterGenerationToProvenEpoch } from './published.js';
import { selectSuccessor, mintNextEpoch } from './mint.js';

export function openWritableStoreDbNoReset(
  runtime: Runtime,
  options: ({ readonly path?: string; readonly resolved?: never } | { readonly resolved: ResolvedStoreEpoch }) & {
    readonly busyTimeoutMs?: number;
    readonly storeFormat: StoreFormatDescription;
  },
): Database {
  const resolved =
    options.resolved === undefined
      ? resolveCurrentStore(runtime, options.path)
      : { path: options.resolved.path, epoch: options.resolved, epochCandidate: true };
  const lease = resolved.epoch === null ? null : acquireStoreEpochReadLock(runtime, resolved.epoch);
  const proof =
    resolved.path === ':memory:'
      ? { kind: 'disproven' as const }
      : resolved.epoch === null && !resolved.epochCandidate
        ? observeContainedRegularFile(runtime.storage, dirname(resolved.path), resolved.path, { kind: 'proven' })
        : lease !== null
          ? { kind: 'proven' as const }
          : { kind: 'disproven' as const };
  if (proof.kind === 'proven') {
    let heldLease = lease;
    try {
      const writerEntitlement =
        resolved.path === ':memory:'
          ? undefined
          : joinSuccessionWriterGeneration(
              runtime,
              resolved.epoch === null
                ? { storeRoot: dirname(resolved.path), epoch: 'legacy' }
                : {
                    storeRoot: resolved.epoch.canonicalStoreRoot ?? resolved.epoch.storeRoot,
                    epoch: resolved.epoch.epoch,
                  },
            );
      if (writerEntitlement !== undefined && resolved.epoch !== null && lease !== null) {
        heldLease = parkableEpochReadLease(runtime, resolved.epoch, lease, writerEntitlement);
      }
      const db = openStoreDatabase({
        path: resolved.path,
        storage: runtime.storage,
        storeFormat: options.storeFormat,
        flavor: runtime.flavor,
        busyTimeoutMs: options.busyTimeoutMs,
        writerEntitlement,
      });
      return resolved.epoch === null || heldLease === null
        ? db
        : registerStoreEpochHolder(runtime, resolved.epoch, db, heldLease);
    } catch (error: unknown) {
      heldLease?.();
      throw error;
    }
  }
  lease?.();
  throw documentedCoralSetupError('store_not_initialized', { path: resolved.path });
}

function hasHigherUnobservableCandidate(
  observations: readonly StoreEpochObservation[],
  current: ProvenStoreEpochObservation | null,
): boolean {
  return observations.some(
    (observation) =>
      observation.proof.kind === 'unobservable' &&
      (current === null || compareEpoch(observation.epoch, current.epoch) > 0),
  );
}

function absentClassification(observations: readonly StoreEpochObservation[]): StoreEpochClassification {
  const candidates: StoreEpochUnprovenCandidate[] = [];
  for (const observation of observations) {
    if (observation.proof.kind === 'proven') continue;
    candidates.push({
      epoch: observation.epoch,
      proof:
        observation.proof.kind === 'unobservable'
          ? {
              kind: 'unobservable',
              cause: truncate(
                observation.proof.cause.replace(/\s+/gu, ' '),
                STORE_EPOCH_CLASSIFICATION_STRING_MAX_LENGTH,
              ),
            }
          : {
              kind: 'disproven',
              ...(observation.epochJson.kind === 'missing' ? { cause: 'epoch metadata is missing' } : {}),
            },
    });
  }
  candidates.sort((left, right) => compareEpoch(left.epoch, right.epoch));
  return candidates.length === 0
    ? { kind: 'absent' }
    : {
        kind: 'absent',
        candidateCount: candidates.length,
        candidates: candidates.slice(-STORE_EPOCH_CANDIDATE_DETAIL_LIMIT),
      };
}

function tryOpenCurrentEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  resolved: ResolvedStoreEpoch,
  deadline: bigint | null,
  requireCompatible = false,
):
  | { readonly kind: 'opened'; readonly db: Database }
  | { readonly kind: 'replace'; readonly classification: StoreEpochClassification } {
  let lease: FileLockLease | null;
  try {
    const startupBusyTimeoutMs = Math.max(1, options.startupBusyTimeoutMs ?? STORE_EPOCH_OPEN_RETRY_BUDGET_MS);
    const lockBusyTimeoutMs =
      deadline === null
        ? startupBusyTimeoutMs
        : Math.max(1, Math.min(startupBusyTimeoutMs, remainingStoreEpochRetryBudgetMs(runtime, deadline)));
    lease = acquireStoreEpochReadLock(runtime, resolved, lockBusyTimeoutMs);
  } catch (error: unknown) {
    return { kind: 'replace', classification: unavailableClassification('lock', error) };
  }
  if (lease === null) {
    return {
      kind: 'replace',
      classification: unavailableClassification(
        'lock',
        new Error(`Store epoch ${resolved.epoch} was no longer proven after acquiring its read lock.`),
      ),
    };
  }
  try {
    assertProvenStoreOpenable(runtime.storage, resolved.path);
  } catch (error: unknown) {
    return {
      kind: 'replace',
      classification: classificationAfterLeaseRelease(lease, unavailableClassification('openable-probe', error)),
    };
  }
  let stage: StoreEpochOpenFailureStage = 'writable-open';
  try {
    if (requireCompatible) {
      const classification = classifyStoreFile(resolved.path, runtime.storage, options.storeFormat);
      if (classification.kind !== 'compatible') {
        return {
          kind: 'replace',
          classification: classificationAfterLeaseRelease(
            lease,
            classification.kind === 'absent'
              ? unavailableClassification('openable-probe', new Error('Agreed store epoch is absent.'))
              : classification,
          ),
        };
      }
    }
    const decision = openWritableStoreDatabase({
      path: resolved.path,
      storage: runtime.storage,
      storeFormat: options.storeFormat,
      flavor: runtime.flavor,
      deferProductVersionRaise: options.deferProductVersionRaise,
      busyTimeoutMs: Math.max(1, options.startupBusyTimeoutMs ?? STORE_EPOCH_OPEN_RETRY_BUDGET_MS),
      writerEntitlement: joinSuccessionWriterGeneration(runtime, {
        storeRoot: resolved.canonicalStoreRoot ?? resolved.storeRoot,
        epoch: resolved.epoch,
      }),
      ...(deadline === null
        ? {}
        : {
            busyTimeoutDeadline: {
              expiresAt: deadline,
              monotonicNow: () => runtime.time.monotonicNow(),
            },
          }),
    });
    if (decision.kind !== 'opened') {
      return {
        kind: 'replace',
        classification: classificationAfterLeaseRelease(lease, decision.classification),
      };
    }
    stage = 'holder-registration';
    return { kind: 'opened', db: registerStoreEpochHolder(runtime, resolved, decision.db, lease) };
  } catch (error: unknown) {
    return {
      kind: 'replace',
      classification: classificationAfterLeaseRelease(lease, unavailableClassification(stage, error)),
    };
  }
}

/** An accepted epoch may never fall through to the successor-mint path. */
export function openExactStoreEpoch(
  runtime: Runtime,
  options: Omit<StoreEpochOptions, 'path'> & { readonly path?: never },
  expected: ResolvedStoreEpoch,
): ExactStoreEpochOpen {
  let proven: ResolvedStoreEpoch | null;
  let mapped: ResolvedStoreEpoch | null;
  try {
    mapped =
      expected.lineageKey === undefined
        ? null
        : resolveProtectedEpoch(runtime, expected.canonicalStoreRoot ?? expected.storeRoot, expected.lineageKey);
    const target = mapped ?? expected;
    proven = resolveProvenStoreEpochAtPath(runtime.storage, target.storeRoot, target.path);
  } catch {
    return { kind: 'holding', reason: 'epoch-unproven' };
  }
  if (proven === null) return { kind: 'holding', reason: 'epoch-unproven' };
  let identityMatches: boolean;
  try {
    identityMatches =
      expected.lineageKey !== undefined
        ? sameEpoch(readOrCreateEpochKey(runtime, proven), expected.lineageKey)
        : proven.storeRoot === expected.storeRoot && proven.path === expected.path;
  } catch {
    identityMatches = false;
  }
  if (!identityMatches) {
    return { kind: 'holding', reason: 'epoch-unproven' };
  }
  if (mapped !== null) {
    proven = { ...proven, canonicalStoreRoot: expected.canonicalStoreRoot ?? expected.storeRoot };
  }
  const opened = tryOpenCurrentEpoch(runtime, options, proven, null, true);
  if (opened.kind !== 'opened') {
    return { kind: 'holding', reason: 'open-failed', classification: opened.classification };
  }
  let adopted = false;
  try {
    if (!runtime.storage.syncDirectoryDurableSync(proven.storeRoot)) {
      return { kind: 'holding', reason: 'open-failed' };
    }
    recordUncoveredEpochUse(runtime, proven);
    opened.db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
    adopted = true;
    return {
      kind: 'opened',
      db: opened.db,
      store:
        mapped === null
          ? proven
          : {
              ...proven,
              lineageKey: expected.lineageKey,
              canonicalStoreRoot: expected.canonicalStoreRoot ?? expected.storeRoot,
            },
    };
  } catch {
    return { kind: 'holding', reason: 'open-failed' };
  } finally {
    if (!adopted) opened.db.close();
  }
}

function recordUncoveredEpochUse(runtime: Runtime, epoch: ResolvedStoreEpoch): void {
  const runDir = runtime.paths.coral.coordinator.runDir;
  const ledgerId = initializeCustodyLedger(runtime, runDir);
  const directory = dirname(epoch.path);
  if (hasEpochCustodyCoverage(runtime, directory, runDir)) return;
  const usedPath = join(directory, '.coral-used-after-custody-start.v1.json');
  if (
    observeStorePath(runtime.storage, usedPath) === 'absent' &&
    !runtime.storage.writeAtomicDurableSync(usedPath, `${JSON.stringify({ version: 'v1', ledgerId })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  )
    throw new Error(`Failed to record use of uncovered store epoch ${epoch.epoch}.`);
}

function openProtectedStoreEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  dbDir: string,
  protectedIncumbent: ResolvedStoreEpoch,
):
  | { kind: 'opened'; settlement: StoreEpochSettlement }
  | { kind: 'classified'; classification: StoreEpochClassification } {
  const classification = classifyStoreFile(protectedIncumbent.path, runtime.storage, options.storeFormat);
  if (classification.kind !== 'compatible') return { kind: 'classified', classification };
  const generation = observeSuccessionWriterGeneration(runtime);
  if (generation !== null && generation.storeRoot === dbDir && generation.epoch !== protectedIncumbent.epoch) {
    handbackSuccessionWriterGeneration(runtime, generation, {
      storeRoot: dbDir,
      epoch: protectedIncumbent.epoch,
    });
  }
  const opened = openExactStoreEpoch(
    runtime,
    {
      storeFormat: options.storeFormat,
      build: options.build,
      startupBusyTimeoutMs: options.startupBusyTimeoutMs,
      steadyStateBusyTimeoutMs: options.steadyStateBusyTimeoutMs,
      authorizeMint: options.authorizeMint,
    },
    protectedIncumbent,
  );
  if (opened.kind === 'holding') {
    throw new Error(
      `Protected epoch exact open held: ${opened.reason}${opened.classification === undefined ? '' : ` (${opened.classification.kind})`}.`,
    );
  }
  return { kind: 'opened', settlement: { db: opened.db, store: opened.store } };
}

type StoreEpochSelection = Readonly<{
  dbDir: string;
  observations: ReturnType<typeof observeStoreEpochs>;
  current: ProvenStoreEpochObservation | null;
  protectedIncumbent: ResolvedStoreEpoch | null;
  protectedAddresses: ReturnType<typeof knownProtectedEpochAddresses>;
}>;

function latestUnprovenStoreIncumbent(
  runtime: Runtime,
  { dbDir, observations }: StoreEpochSelection,
): StoreEpochObservation | null {
  return observations
    .filter((observation) => {
      if (observation.proof.kind === 'proven') return false;
      const directory = epochDirectory(dbDir, observation.epoch);
      const contained = observeContainedDirectory(runtime.storage, dbDir, directory);
      return (
        contained.kind === 'proven' &&
        observeContainedRegularFile(runtime.storage, directory, epochPath(dbDir, observation.epoch), contained).kind ===
          'proven' &&
        observeStoreEpochLock(runtime.storage, dbDir, observation.epoch, contained).kind === 'proven'
      );
    })
    .reduce<StoreEpochObservation | null>(
      (latest, observation) =>
        latest === null || compareEpoch(observation.epoch, latest.epoch) > 0 ? observation : latest,
      null,
    );
}

function resolveStoreMintPredecessor(runtime: Runtime, selection: StoreEpochSelection) {
  const { dbDir, current, protectedIncumbent } = selection;
  const unprovenCurrent = current === null ? latestUnprovenStoreIncumbent(runtime, selection) : null;
  const predecessor = current === null ? protectedIncumbent : resolvedStoreEpoch(dbDir, current.epoch);
  const incumbent = predecessor ?? (unprovenCurrent === null ? null : resolvedStoreEpoch(dbDir, unprovenCurrent.epoch));
  return { predecessor, incumbent };
}

function identifyStoreMintIncumbent(
  runtime: Runtime,
  incumbent: ResolvedStoreEpoch | null,
  classification: StoreEpochClassification,
): string | null {
  let incumbentEpochKey: string | null = null;
  if (incumbent !== null) {
    if (classification.kind === 'unavailable') {
      incumbentEpochKey = inspectResolvedStoreEpochKey(runtime, incumbent);
      if (incumbentEpochKey === null) {
        try {
          incumbentEpochKey = encodeResolvedStoreEpoch(runtime, incumbent);
        } catch {
          // A missing lineage marker cannot be created while its opener remains unavailable.
        }
      }
    } else {
      incumbentEpochKey = encodeResolvedStoreEpoch(runtime, incumbent);
    }
  }
  if (incumbent !== null && incumbentEpochKey === null) {
    throw new Error('Store epoch mint cannot identify its unavailable predecessor.');
  }
  return incumbentEpochKey;
}

function authorizeStoreMintDisposition(
  options: StoreEpochOptions,
  incumbent: ResolvedStoreEpoch | null,
  incumbentEpochKey: string | null,
  classification: StoreEpochClassification,
  observedEpochCount: number,
): void {
  const disposition =
    options.authorizeMint?.({
      incumbent,
      incumbentEpochKey,
      classification,
      observedEpochCount,
    }) ?? null;
  if (options.path === undefined && disposition === null) {
    throw new Error('Store epoch mint has no coordinator retirement disposition.');
  }
  if (disposition !== null) {
    if (
      disposition.incumbentEpochKey !== incumbentEpochKey ||
      (incumbent === null && observedEpochCount === 0 && disposition.kind !== 'initial') ||
      (incumbent === null && observedEpochCount > 0 && disposition.kind !== 'unopenable') ||
      (incumbent !== null && disposition.kind === 'initial')
    ) {
      throw new Error('Store epoch mint disposition does not match the observed predecessor.');
    }
  }
}

function mintSelectedStoreEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  selection: StoreEpochSelection,
  classification: StoreEpochClassification,
): StoreEpochSettlement | null {
  const { dbDir, observations, protectedAddresses } = selection;
  const { predecessor, incumbent } = resolveStoreMintPredecessor(runtime, selection);
  const incumbentEpochKey = identifyStoreMintIncumbent(runtime, incumbent, classification);
  authorizeStoreMintDisposition(
    options,
    incumbent,
    incumbentEpochKey,
    classification,
    observations.length + protectedAddresses.length,
  );
  const highestProtectedEpoch = protectedAddresses.reduce<StoreEpoch | null>((highest, address) => {
    const epoch = address.epochKey.slice(address.epochKey.lastIndexOf(':') + 1);
    return highest === null || compareEpoch(epoch, highest) > 0 ? epoch : highest;
  }, null);
  const successor = selectSuccessor(runtime, dbDir, predecessor?.epoch ?? highestProtectedEpoch);
  const published = mintNextEpoch({
    runtime,
    options,
    dbDir,
    supersedes: predecessor?.epoch ?? null,
    successor: successor.epoch,
    classification,
  });
  if (published.kind === 'published') {
    if (predecessor !== null || observations.length > 0) {
      logStoreEpochReplacement(predecessor?.epoch ?? null, classification);
    }
    return openPublishedEpoch(runtime, options, dbDir, predecessor?.epoch ?? null, successor.epoch, published.lease);
  }
  return null;
}

type StoreEpochRetryState = {
  deadline: bigint | null;
  attempts: number;
  lastFailure: Readonly<{ epoch: StoreEpoch; classification: StoreEpochClassification }> | null;
};

function storeEpochRetryDeadlineForEvidence(runtime: Runtime, retry: StoreEpochRetryState): bigint {
  retry.deadline ??= storeEpochRetryDeadline(runtime);
  return retry.deadline;
}

function rememberStoreEpochRetryFailure(
  retry: StoreEpochRetryState,
  epoch: StoreEpoch,
  classification: StoreEpochClassification,
): StoreEpochClassification {
  if (retry.lastFailure?.epoch === epoch) return retry.lastFailure.classification;
  retry.lastFailure = { epoch, classification };
  return classification;
}

function adoptProvenStoreEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  dbDir: string,
  current: ProvenStoreEpochObservation,
  resolved: ResolvedStoreEpoch,
  db: Database,
): StoreEpochSettlement {
  if (!runtime.storage.syncDirectoryDurableSync(dbDir)) {
    db.close();
    throw new Error(`Failed to durably adopt store epoch ${current.epoch} in '${dbDir}'.`);
  }
  try {
    recordUncoveredEpochUse(runtime, resolved);
  } catch (error: unknown) {
    db.close();
    throw error;
  }
  db.exec(`PRAGMA busy_timeout = ${options.steadyStateBusyTimeoutMs ?? 5_000}`);
  return { db, store: resolved };
}

function openProvenStoreEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  dbDir: string,
  current: ProvenStoreEpochObservation,
  shouldReobserve: boolean,
  minimumAttemptMs: number,
  retry: StoreEpochRetryState,
  absent: StoreEpochClassification,
):
  | { kind: 'settled'; settlement: StoreEpochSettlement }
  | { kind: 'retry' }
  | { kind: 'classified'; classification: StoreEpochClassification } {
  const deadline = storeEpochRetryDeadlineForEvidence(runtime, retry);
  const resolved = resolvedStoreEpoch(dbDir, current.epoch);
  advanceWriterGenerationToProvenEpoch(runtime, dbDir, current.epoch);
  retry.attempts += 1;
  const opened = tryOpenCurrentEpoch(runtime, options, resolved, deadline);
  let classification = absent;
  if (opened.kind === 'opened') {
    if (!shouldReobserve) {
      return {
        kind: 'settled',
        settlement: adoptProvenStoreEpoch(runtime, options, dbDir, current, resolved, opened.db),
      };
    }
    opened.db.close();
    if (waitForStoreEpochRetry(runtime, deadline, minimumAttemptMs)) return { kind: 'retry' };
  } else if (isDecisiveStoreEpochFailure(opened.classification)) {
    classification = classificationWithAttempts(opened.classification, retry.attempts);
  } else {
    rememberStoreEpochRetryFailure(retry, current.epoch, opened.classification);
    if (waitForStoreEpochRetry(runtime, deadline, minimumAttemptMs)) return { kind: 'retry' };
  }

  if (!isDecisiveStoreEpochFailure(classification)) {
    retry.attempts += 1;
    const finalAttempt = tryOpenCurrentEpoch(runtime, options, resolved, null);
    if (finalAttempt.kind === 'opened') {
      return {
        kind: 'settled',
        settlement: adoptProvenStoreEpoch(runtime, options, dbDir, current, resolved, finalAttempt.db),
      };
    }
    classification = isDecisiveStoreEpochFailure(finalAttempt.classification)
      ? finalAttempt.classification
      : rememberStoreEpochRetryFailure(retry, current.epoch, finalAttempt.classification);
    classification = classificationWithAttempts(classification, retry.attempts);
  }
  return { kind: 'classified', classification };
}

function openInMemoryStoreEpoch(runtime: Runtime, options: StoreEpochOptions): StoreEpochSettlement {
  const opened = openWritableStoreDatabase({
    path: ':memory:',
    storage: runtime.storage,
    storeFormat: options.storeFormat,
    flavor: runtime.flavor,
    busyTimeoutMs: options.startupBusyTimeoutMs,
  });
  if (opened.kind !== 'opened') throw new Error('An in-memory store cannot be incompatible before opening.');
  return { db: opened.db, store: { storeRoot: ':memory:', epoch: '1', path: ':memory:' } };
}

function selectStoreEpoch(runtime: Runtime, options: StoreEpochOptions, dbDir: string): StoreEpochSelection {
  const observations = observeStoreEpochs(runtime.storage, dbDir);
  const current = currentProvenEpoch(observations);
  const protectedAddresses = knownProtectedEpochAddresses(runtime, dbDir);
  const selectedKey =
    current === null
      ? protectedAddresses.length === 1
        ? protectedAddresses[0].epochKey
        : (options.selectProtectedPredecessor?.(protectedAddresses) ?? null)
      : null;
  const selectedProtected = protectedAddresses.find((address) => sameEpoch(address.epochKey, selectedKey));
  const protectedIncumbent =
    selectedProtected === undefined ? null : resolveProtectedEpoch(runtime, dbDir, selectedProtected.epochKey);
  return { dbDir, observations, current, protectedAddresses, protectedIncumbent };
}

function openSelectedStoreEpoch(
  runtime: Runtime,
  options: StoreEpochOptions,
  selection: StoreEpochSelection,
  minimumAttemptMs: number,
  retry: StoreEpochRetryState,
): ReturnType<typeof openProvenStoreEpoch> {
  const { dbDir, observations, current, protectedIncumbent } = selection;
  const shouldReobserve = hasHigherUnobservableCandidate(observations, current);
  let classification = absentClassification(observations);
  if (current !== null) {
    const proven = openProvenStoreEpoch(
      runtime,
      options,
      dbDir,
      current,
      shouldReobserve,
      minimumAttemptMs,
      retry,
      classification,
    );
    if (proven.kind === 'settled') return proven;
    if (proven.kind === 'retry') return proven;
    classification = proven.classification;
  } else if (shouldReobserve) {
    retry.attempts += 1;
    if (waitForStoreEpochRetry(runtime, storeEpochRetryDeadlineForEvidence(runtime, retry), minimumAttemptMs))
      return { kind: 'retry' };
  }
  if (current === null && retry.attempts > 0) {
    classification = classificationWithAttempts(classification, retry.attempts);
  }
  if (protectedIncumbent !== null) {
    const protectedOpen = openProtectedStoreEpoch(runtime, options, dbDir, protectedIncumbent);
    if (protectedOpen.kind === 'opened') return { kind: 'settled', settlement: protectedOpen.settlement };
    classification = protectedOpen.classification;
  }
  return { kind: 'classified', classification };
}

export function settleStoreEpoch(runtime: Runtime, options: StoreEpochOptions): StoreEpochSettlement {
  const configuredDbDir = resolveStoreDbDir(runtime, options.path);
  if (configuredDbDir === ':memory:') return openInMemoryStoreEpoch(runtime, options);
  runtime.storage.mkdirSync(configuredDbDir, { recursive: true, mode: 0o700 });
  const dbDir = runtime.storage.realpathSync(configuredDbDir);
  reconcileProtectedEpochs(runtime, dbDir);
  const retry: StoreEpochRetryState = { deadline: null, attempts: 0, lastFailure: null };
  const minimumAttemptMs = Math.max(1, options.startupBusyTimeoutMs ?? STORE_EPOCH_OPEN_RETRY_INTERVAL_MS);
  for (;;) {
    const selection = selectStoreEpoch(runtime, options, dbDir);
    const opened = openSelectedStoreEpoch(runtime, options, selection, minimumAttemptMs, retry);
    if (opened.kind === 'settled') return opened.settlement;
    if (opened.kind === 'retry') continue;
    const minted = mintSelectedStoreEpoch(runtime, options, selection, opened.classification);
    if (minted !== null) return minted;
    retry.deadline = null;
    retry.attempts = 0;
    retry.lastFailure = null;
  }
}

export function discardCurrentStoreEpoch(runtime: Runtime, options: StoreEpochOptions): StoreEpochSettlement {
  const configuredDbDir = resolveStoreDbDir(runtime, options.path);
  if (configuredDbDir === ':memory:') throw new Error('Cannot discard an in-memory store epoch.');
  runtime.storage.mkdirSync(configuredDbDir, { recursive: true, mode: 0o700 });
  const dbDir = runtime.storage.realpathSync(configuredDbDir);
  for (;;) {
    const current = resolveCurrentStoreEpoch(runtime.storage, dbDir);
    const successor = selectSuccessor(runtime, dbDir, current);
    const published = mintNextEpoch({
      runtime,
      options,
      dbDir,
      supersedes: current,
      successor: successor.epoch,
      classification: { kind: 'operator-discard' },
    });
    if (published.kind === 'published') {
      return openPublishedEpoch(runtime, options, dbDir, current, successor.epoch, published.lease);
    }
  }
}
