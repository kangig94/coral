import { sameEpoch } from '../../../store/epoch/identity.js';
import { dirname } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createMonotonicClock } from '../../../infra/monotonic-clock.js';
import {
  observeRecordedContainment,
  reapRecordedContainment,
  type RecordedProcessIdentity,
} from '../../../infra/process-containment.js';
import type { JobLocationIndex } from '../../../jobs/location-index.js';
import { hasReadableTerminalDetail } from '../../../jobs/terminal/identity.js';
import { inspectEpochKey } from '../../../store/epoch/key.js';
import { decodeResolvedStoreEpoch } from '../../../store/epoch/observation.js';
import type { ResolvedStoreEpoch } from '../../../store/epoch/types.js';
import type { RetentionRunBudget } from '../../../store/retention-outcome.js';
import { readDurableCliControllerReceipts } from '../durable-cli-transfer.js';

import { findCustodyProcessToken } from '../../../infra/custody-process-ticket.js';
import { readDurableCliPreReadyOwnershipEvidence } from '../../../jobs/runtime-meta-store.js';
import {
  bindCustodyIdentity,
  dischargeCustodyEntry,
  readCustodyLedger,
  reconcileCustodyLedger,
  type CustodyEntry,
  type CustodyIntent,
  type CustodyObservation,
} from '../../../store/custody-ledger.js';
import { readProviderOperations } from '../../../store/provider-operation-journal.js';
import { acquireStoreEpochReadLock } from '../../../store/epoch/index.js';
import type { Database } from '../../../store/db.js';
import type { Runtime } from '../../../runtime/ports.js';
import { closureCandidates } from './epoch-closure.js';

const CUSTODY_ABSENCE_GRACE_MS = 2_000;
const custodyClockScope = Symbol('custody-reconciliation');

type CustodyRecoveryEvidence = Readonly<{
  readProcessIncarnation(pid: number): string | null;
  capsuleExists(path: string): boolean;
}>;

function recoverHoldingCustodyEntries(
  runtime: Runtime,
  runDir: string,
  nowMs: number,
  db: Database,
  currentEpoch: string,
  evidence: CustodyRecoveryEvidence | undefined,
  entries: readonly CustodyEntry[],
  publicationScan: (intent: CustodyIntent) => ReturnType<typeof readProviderOperations> | null,
): void {
  for (const entry of entries) {
    if (entry.kind !== 'holding') continue;
    if (entry.intent.effect === 'provider-operation-publication') {
      if (
        publicationScan(entry.intent)?.records.some(
          (record) => record.operation.operationId === entry.intent.operationId,
        )
      ) {
        bindCustodyIdentity(
          runtime,
          runDir,
          entry.intent,
          {
            process: null,
            capsule: entry.intent.capsule,
            observedAtMs: nowMs,
          },
          'recovered',
        );
      }
      continue;
    }
    if (entry.intent.epoch !== currentEpoch) continue;
    if (entry.intent.owner !== 'durable-cli' || evidence === undefined || nowMs > entry.intent.bindDeadlineMs) continue;
    const token = findCustodyProcessToken(entry.intent.processToken);
    if (token.kind !== 'alive') continue;
    let runtimeEvidence: ReturnType<typeof readDurableCliPreReadyOwnershipEvidence>;
    try {
      runtimeEvidence = readDurableCliPreReadyOwnershipEvidence(db, entry.intent.operationId);
    } catch {
      continue;
    }
    let incarnation: string | null;
    try {
      incarnation = evidence.readProcessIncarnation(token.pid);
    } catch {
      continue;
    }
    if (
      (runtimeEvidence.kind === 'current' || runtimeEvidence.kind === 'provisional') &&
      runtimeEvidence.record.pid === token.pid &&
      incarnation === runtimeEvidence.record.incarnation
    ) {
      bindCustodyIdentity(
        runtime,
        runDir,
        entry.intent,
        {
          process: {
            pid: token.pid,
            incarnation: runtimeEvidence.record.incarnation,
            processGroupId: runtimeEvidence.record.processGroupId,
          },
          capsule: entry.intent.capsule,
          observedAtMs: nowMs,
        },
        'recovered',
      );
    }
  }
}

export function reconcileStartupCustody(
  runtime: Runtime,
  runDir: string,
  nowMs: number,
  db: Database,
  currentEpoch: string,
  evidence?: CustodyRecoveryEvidence,
): CustodyEntry[] {
  type OperationScan = ReturnType<typeof readProviderOperations>;
  let operations: OperationScan | null;
  try {
    operations = readProviderOperations(db);
  } catch {
    operations = null;
  }
  const entries = readCustodyLedger(runtime, runDir);
  let candidates: ReturnType<typeof closureCandidates> = [];
  if (entries.some((entry) => entry.kind === 'holding' && entry.intent.effect === 'provider-operation-publication')) {
    try {
      candidates = closureCandidates(runtime);
    } catch {
      // An unreadable epoch address cannot prove publication absence.
    }
  }
  const historicalScans = new Map<string, OperationScan | null>();
  const publicationScan = (intent: CustodyIntent): OperationScan | null => {
    const matching = candidates.filter((candidate) =>
      intent.epochKey === undefined
        ? intent.epoch === candidate.originalPath || intent.epoch === dirname(candidate.epoch.path)
        : sameEpoch(intent.epochKey, candidate.epochKey),
    );
    if (matching.length !== 1) {
      return matching.length === 0 && intent.epochKey === undefined && intent.epoch === currentEpoch
        ? operations
        : null;
    }
    const candidate = matching[0];
    if (dirname(candidate.epoch.path) === currentEpoch) return operations;
    if (historicalScans.has(candidate.epochKey)) return historicalScans.get(candidate.epochKey) ?? null;
    let scan: OperationScan | null = null;
    let release: (() => void) | null = null;
    let historicalDb: ReturnType<typeof runtime.storage.openSqliteDatabaseSync> | null = null;
    try {
      release = acquireStoreEpochReadLock(runtime, candidate.epoch, 0);
      if (release !== null) {
        historicalDb = runtime.storage.openSqliteDatabaseSync(candidate.epoch.path, { readOnly: true });
        scan = readProviderOperations(historicalDb as unknown as Database);
      }
    } catch {
      scan = null;
    } finally {
      try {
        historicalDb?.close();
      } catch {
        scan = null;
      }
      try {
        release?.();
      } catch {
        scan = null;
      }
    }
    historicalScans.set(candidate.epochKey, scan);
    return scan;
  };
  recoverHoldingCustodyEntries(runtime, runDir, nowMs, db, currentEpoch, evidence, entries, publicationScan);
  const observe = (intent: CustodyIntent): CustodyObservation => {
    if (intent.effect === 'provider-operation-publication') {
      const scan = publicationScan(intent);
      return scan === null
        ? { kind: 'unreadable', reason: 'recorded epoch provider-operation journal is unreadable' }
        : scan.unreadableKeys.length === 0
          ? {
              kind: 'absent',
              processToken: intent.processToken,
              evidence: 'complete provider-operation scan found no publication',
            }
          : { kind: 'unreadable', reason: 'recorded epoch provider-operation journal has unreadable rows' };
    }
    const process = findCustodyProcessToken(intent.processToken);
    if (process.kind !== 'absent') return { kind: process.kind };
    let capsule = 'none';
    if (intent.capsule !== null && evidence !== undefined) {
      try {
        capsule = evidence.capsuleExists(intent.capsule) ? 'present' : 'absent';
      } catch {
        capsule = 'unreadable';
      }
    }
    return {
      kind: 'absent',
      processToken: intent.processToken,
      evidence: `complete same-user process-token scan found no process; capsule=${capsule}`,
    };
  };
  return reconcileCustodyLedger(runtime, runDir, nowMs, CUSTODY_ABSENCE_GRACE_MS, observe);
}

function readFinishedCarrierEvidence(runtime: Runtime, epoch: ResolvedStoreEpoch, jobId: string) {
  const release = acquireStoreEpochReadLock(runtime, epoch, 0);
  if (release === null) return null;
  try {
    if (epoch.lineageKey === undefined || !sameEpoch(inspectEpochKey(runtime, epoch), epoch.lineageKey)) return null;
    const db = runtime.storage.openSqliteDatabaseSync(epoch.path, { readOnly: true });
    try {
      return readDurableCliPreReadyOwnershipEvidence(db as unknown as Database, jobId);
    } finally {
      db.close();
    }
  } finally {
    release();
  }
}

/** Reconciliation observes finished owners; retention never signals a live process to manufacture absence. */
export async function reconcileFinishedCustody(input: {
  runtime: Runtime;
  runDir: string;
  index: JobLocationIndex;
  afterId: string;
  budget: RetentionRunBudget;
  signal: AbortSignal;
  mutate<T>(operation: () => T): T;
  checkpoint?(id: string): void;
}): Promise<string> {
  const { runtime, runDir, index, budget, signal, mutate } = input;
  const receipts = readDurableCliControllerReceipts(runtime, runDir);
  let cursor = input.afterId;
  let scanned = 0;
  const clock = createMonotonicClock(custodyClockScope, {
    readMilliseconds: () => runtime.time.monotonicNow(),
    sleep: (milliseconds) => runtime.time.sleep(milliseconds),
  });
  for (const entry of readCustodyLedger(runtime, runDir).sort((left, right) =>
    (left.kind === 'unreadable' ? left.path : left.intent.id).localeCompare(
      right.kind === 'unreadable' ? right.path : right.intent.id,
    ),
  )) {
    if (entry.kind === 'unreadable' || entry.intent.id <= input.afterId) continue;
    if (!budget.canContinue()) return cursor;
    if (entry.kind === 'bound') {
      try {
        if (
          !['durable-cli', 'provider-operation', 'provider-proxy-set', 'provider-host'].includes(entry.intent.owner)
        ) {
          budget.record({ kind: 'kept', subject: entry.intent.id, reason: 'custody-awaits-known-owner-discharge' });
          cursor = entry.intent.id;
          if (++scanned % 32 === 0) input.checkpoint?.(cursor);
          await setImmediate();
          continue;
        }
        const jobId = entry.intent.owner === 'durable-cli' ? entry.intent.operationId : entry.intent.jobId;
        const needsResult = entry.intent.effect === 'provider-operation-publication' || jobId !== undefined;
        let resultReady = !needsResult;
        const recordedRoots: RecordedProcessIdentity[] = [];
        if (jobId !== undefined) {
          const location = index.read(jobId);
          const epoch = location === null ? null : decodeResolvedStoreEpoch(runtime, location.epochKey);
          resultReady =
            location !== null &&
            hasReadableTerminalDetail(location) &&
            index.resultDurable(jobId) &&
            epoch !== null &&
            epoch !== undefined &&
            (entry.intent.epochKey === undefined
              ? entry.intent.epoch === dirname(epoch.path)
              : sameEpoch(entry.intent.epochKey, epoch.lineageKey));
          if (entry.intent.owner === 'durable-cli') {
            const initial =
              epoch === null || epoch === undefined ? null : readFinishedCarrierEvidence(runtime, epoch, jobId);
            const identity = entry.binding.process;
            const initialMatches =
              initial?.kind === 'current' &&
              identity !== null &&
              initial.record.pid === identity.pid &&
              initial.record.incarnation === identity.incarnation &&
              initial.record.processGroupId === identity.processGroupId;
            resultReady &&= initialMatches;
            if (initialMatches) recordedRoots.push(initial.record.childRoot);
            const transfers = receipts.receipts.filter((receipt) => receipt.jobId === jobId);
            resultReady &&=
              receipts.unreadable.length === 0 &&
              transfers.every(
                (receipt) =>
                  receipt.custodyIntentId === entry.intent.id &&
                  sameEpoch(receipt.lineageEpochKey, entry.intent.epochKey) &&
                  entry.binding.process !== null &&
                  receipt.runtimeMeta.pid === entry.binding.process.pid &&
                  receipt.runtimeMeta.incarnation === entry.binding.process.incarnation &&
                  receipt.runtimeMeta.processGroupId === entry.binding.process.processGroupId,
              );
            for (const receipt of transfers) {
              const root = receipt.runtimeMeta.childRoot;
              if (
                !recordedRoots.some(
                  (existing) => existing.pid === root.pid && existing.incarnation === root.incarnation,
                )
              )
                recordedRoots.push(root);
            }
          }
        }
        if (!resultReady) {
          budget.record({
            kind: 'kept',
            subject: entry.intent.id,
            reason:
              'custody-awaits-exact-terminal-result-and-transfer; daily reconciliation retries after retained result durability and identity-bound runtime evidence are available',
          });
        } else {
          let absent = entry.intent.effect === 'provider-operation-publication';
          const identity = entry.binding.process;
          if (identity !== null) {
            const environment = {
              process: runtime.process,
              platform: runtime.env.platform() as NodeJS.Platform,
              readProcessIncarnation: (pid: number, platform: NodeJS.Platform) =>
                runtime.process.readProcessIncarnation(pid, platform),
            };
            const observed = observeRecordedContainment({ ...identity, childRoot: null }, environment);
            if (
              observed.kind === 'absent' &&
              recordedRoots.every(
                (root) => observeRecordedContainment({ ...identity, childRoot: root }, environment).kind === 'absent',
              )
            ) {
              const proof = await reapRecordedContainment(
                identity,
                recordedRoots,
                clock.shiftMilliseconds(clock.now(), 1000),
                {
                  ...environment,
                  clock,
                  maxRecordedRoots: recordedRoots.length,
                  signal,
                  assertSignalAuthorized: () => {
                    throw new Error('custody reconciliation only observes absence');
                  },
                },
              );
              absent = proof.kind === 'containment-absent';
            }
          }
          if (signal.aborted || budget.canMutate?.() === false) return cursor;
          if (absent) {
            const discharged = dischargeCustodyEntry(
              runtime,
              runDir,
              entry,
              runtime.time.now(),
              'exact owner obligations discharged; retained terminal/result and matching transfers; recorded incarnation and containment absent',
              mutate,
            );
            if (!discharged)
              budget.record({
                kind: 'kept',
                subject: entry.intent.id,
                reason: 'custody-discharge-lock-or-identity-changed; retry-after-reconciliation',
              });
          } else
            budget.record({
              kind: 'kept',
              subject: entry.intent.id,
              reason: 'custody-awaits-recorded-incarnation-and-containment-absence',
            });
        }
      } catch {
        budget.record({
          kind: 'kept',
          subject: entry.intent.id,
          reason: 'custody-evidence-unreadable; retry-after-reconciliation',
        });
      }
    }
    cursor = entry.intent.id;
    if (++scanned % 32 === 0) input.checkpoint?.(cursor);
    await setImmediate();
  }
  return '';
}
