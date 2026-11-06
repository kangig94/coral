import { recordedHostFailureDomain } from './host-failure-domain.js';
import { durableCliFailureDomain } from '../durable-cli-failure-domain.js';
import type { FailureDomainContainment } from '../../../infra/failure-domain.js';
import { createBackgroundPhaseObserver, type RecoveryObservation } from '../../../recovery/phase-observation.js';
import { sameEpoch } from '../../../store/epoch/identity.js';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createMonotonicClock } from '../../../infra/monotonic-clock.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
} from '../../../infra/process-constants.js';
import {
  confirmRecordedGroupMemberAbsence,
  createFailureDomainContainmentObservation,
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

import { custodyBindsGroupMember, findCustodyProcessToken } from '../../../infra/custody-process-ticket.js';
import { readDurableCliPreReadyOwnershipEvidence } from '../../../jobs/runtime-meta-store.js';
import {
  bindCustodyIdentity,
  dischargeCustodyEntry,
  custodyLedgerDir,
  readCustodyLedger,
  readCustodyLedgerAsync,
  reconcileCustodyLedger,
  type CustodyEntry,
  type CompleteCustodyLedger,
  type CustodyIntent,
  type CustodyObservation,
} from '../../../store/custody-ledger.js';
import { readProviderOperations } from '../../../store/provider-operation-journal.js';
import { acquireStoreEpochReadLock } from '../../../store/epoch/index.js';
import type { Database } from '../../../store/db.js';
import type { Runtime } from '../../../runtime/ports.js';
import { closureCandidates } from './epoch-closure.js';

const CUSTODY_ABSENCE_GRACE_MS = 2_000;
/**
 * Reconciliation never signals, so a leader's deadline must fit the disappearance confirmation after observing its
 * group, plus one observation per recorded root.
 */
const ABSENCE_CONFIRMATION_DEADLINE_MS =
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS + 2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS;
const custodyClockScope = Symbol('custody-reconciliation');

type CustodyPassEntry = { entry: string; disposition: CustodyEntry['kind']; reason: string | null };
type CustodyPassReporter = { runDir: string; start: ReturnType<typeof createBackgroundPhaseObserver> };
const startupCustodyReporters = new WeakMap<Runtime, CustodyPassReporter>();
const finishedCustodyReporters = new WeakMap<Runtime, CustodyPassReporter>();
type FinishedCustodySweep = {
  runDir: string;
  afterId: string;
  entries: Map<string, CustodyPassEntry>;
  firstDamaged: Map<string, CustodyPassEntry>;
};
const finishedCustodySweeps = new WeakMap<Runtime, FinishedCustodySweep>();

function custodyPassEntry(runDir: string, entry: CustodyEntry): CustodyPassEntry {
  return {
    entry: entry.kind === 'unreadable' ? entry.path : join(custodyLedgerDir(runDir), entry.intent.id),
    disposition: entry.kind,
    reason:
      entry.kind === 'unreadable'
        ? entry.reason
        : entry.kind === 'holding'
          ? (entry.reason ?? null)
          : entry.kind === 'absent'
            ? entry.evidence
            : null,
  };
}

function reportCustodyDamage(
  pass: 'startup' | 'finished',
  ledgerRoot: string,
  entries: readonly CustodyPassEntry[],
  firstDamaged: readonly CustodyPassEntry[],
  log: ((message: string) => void) | undefined,
): void {
  if (log === undefined || firstDamaged.length === 0) return;
  const finalEntries = new Map(entries.map((entry) => [entry.entry, entry]));
  const rootReadable = !entries.some((entry) => entry.entry === ledgerRoot && entry.disposition === 'unreadable');
  const changedDamage = firstDamaged.flatMap((observed) => {
    const finalEntry = finalEntries.get(observed.entry);
    const rootRecovered = observed.entry === ledgerRoot && observed.disposition === 'unreadable' && rootReadable;
    const final = rootRecovered
      ? { scope: 'ledger-listing', readable: true }
      : finalEntry === undefined
        ? null
        : { disposition: finalEntry.disposition, reason: finalEntry.reason };
    if (final === null) return [];
    const cleared =
      rootRecovered ||
      (finalEntry !== undefined && finalEntry.disposition !== 'holding' && finalEntry.disposition !== 'unreadable');
    const readableAgain =
      observed.disposition === 'unreadable' &&
      (rootRecovered || (finalEntry !== undefined && finalEntry.disposition !== 'unreadable'));
    if (!cleared && !readableAgain) return [];
    return [
      {
        entry: observed.entry,
        observed: { disposition: observed.disposition, reason: observed.reason },
        final,
        cleared,
      },
    ];
  });
  if (changedDamage.length > 0) {
    try {
      log(
        `custody-damage ${JSON.stringify({ pass, counts: { reported: changedDamage.length, cleared: changedDamage.filter((entry) => entry.cleared).length }, entries: changedDamage.slice(0, 10) })}\n`,
      );
    } catch {
      // Diagnostic failures must not alter custody decisions.
    }
  }
}

function reportCustodyPass(
  runtime: Runtime,
  runDir: string,
  pass: 'startup' | 'finished',
  outcome: { entries: readonly CustodyPassEntry[]; firstDamaged: readonly CustodyPassEntry[] },
  observation: RecoveryObservation | undefined,
  log: ((message: string) => void) | undefined,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) return;
  const { entries, firstDamaged } = outcome;
  reportCustodyDamage(pass, custodyLedgerDir(runDir), entries, firstDamaged, log);
  const encodeHold = (entry: CustodyPassEntry): string =>
    JSON.stringify({
      identity: entry.entry,
      reason: JSON.stringify({ disposition: entry.disposition, reason: entry.reason }),
    });
  const holds = [
    ...new Set(
      entries.filter((entry) => entry.disposition === 'holding' || entry.disposition === 'unreadable').map(encodeHold),
    ),
  ].sort();
  const state = holds.length === 0 ? null : JSON.stringify(holds.map((hold) => JSON.parse(hold)));
  const rootUnreadable = entries.some(
    (entry) => entry.disposition === 'unreadable' && entry.entry === custodyLedgerDir(runDir),
  );
  const update = rootUnreadable
    ? (previous: string | null): string => {
        const finalIdentities = new Set(entries.map((entry) => entry.entry));
        const observedIdentities = new Set([...finalIdentities, ...firstDamaged.map((entry) => entry.entry)]);
        const prior = (previous === null ? [] : JSON.parse(previous)) as { identity: string; reason: string }[];
        const retained = prior
          .filter((hold) => !observedIdentities.has(hold.identity))
          .map((hold) => JSON.stringify(hold));
        const initial = firstDamaged.filter((entry) => !finalIdentities.has(entry.entry)).map(encodeHold);
        return JSON.stringify([...new Set([...retained, ...initial, ...holds])].sort().map((hold) => JSON.parse(hold)));
      }
    : state;
  if (observation?.reportState !== undefined) {
    observation.reportState(update);
    return;
  }
  if (log === undefined) return;
  const reporters = pass === 'startup' ? startupCustodyReporters : finishedCustodyReporters;
  let reporter = reporters.get(runtime);
  if (reporter?.runDir !== runDir) {
    reporter = {
      runDir,
      start: createBackgroundPhaseObserver({
        time: runtime.time,
        log,
        bootId: 'custody',
        phase: `custody-reconciliation.${pass}`,
      }),
    };
    reporters.set(runtime, reporter);
  }
  const phase = reporter.start(signal);
  phase.reportState(update);
  phase.finish();
}

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
  observation?: RecoveryObservation,
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
        observation?.record('custody-ledger', { subjects: 1 });
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
      observation?.record('custody-ledger', { subjects: 1 });
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
  observation?: RecoveryObservation,
  log?: (message: string) => void,
): CustodyEntry[] {
  type OperationScan = ReturnType<typeof readProviderOperations>;
  let operations: OperationScan | null;
  try {
    operations = readProviderOperations(db);
  } catch {
    operations = null;
  }
  const entries = readCustodyLedger(runtime, runDir, observation);
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
  recoverHoldingCustodyEntries(
    runtime,
    runDir,
    nowMs,
    db,
    currentEpoch,
    evidence,
    entries,
    publicationScan,
    observation,
  );
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
  const reconciled = reconcileCustodyLedger(runtime, runDir, nowMs, CUSTODY_ABSENCE_GRACE_MS, observe, observation);
  reportCustodyPass(
    runtime,
    runDir,
    'startup',
    {
      entries: reconciled.map((entry) => custodyPassEntry(runDir, entry)),
      firstDamaged: entries
        .filter((entry) => entry.kind === 'unreadable' || (entry.kind === 'holding' && entry.reason !== undefined))
        .map((entry) => custodyPassEntry(runDir, entry)),
    },
    observation,
    log,
  );
  return reconciled;
}

function readFinishedCarrierEvidence(
  runtime: Runtime,
  epoch: ResolvedStoreEpoch,
  jobId: string,
  identity: RecordedProcessIdentity | null,
) {
  const release = acquireStoreEpochReadLock(runtime, epoch, 0);
  if (release === null) return null;
  try {
    if (epoch.lineageKey === undefined || !sameEpoch(inspectEpochKey(runtime, epoch), epoch.lineageKey)) return null;
    const db = runtime.storage.openSqliteDatabaseSync(epoch.path, { readOnly: true });
    try {
      return {
        evidence: readDurableCliPreReadyOwnershipEvidence(db as unknown as Database, jobId),
        failureDomain: durableCliFailureDomain(runtime, db, jobId, identity ?? undefined),
      };
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
  entries?: CompleteCustodyLedger;
  budget: RetentionRunBudget;
  signal: AbortSignal;
  mutate<T>(operation: () => T): T;
  checkpoint?(id: string): void;
  log?(message: string): void;
}): Promise<string> {
  const { runtime, runDir, index, budget, signal, mutate } = input;
  const receipts = readDurableCliControllerReceipts(runtime, runDir);
  let cursor = input.afterId;
  let scanned = 0;
  const clock = createMonotonicClock(custodyClockScope, {
    readMilliseconds: () => runtime.time.monotonicNow(),
    sleep: (milliseconds) => runtime.time.sleep(milliseconds),
  });
  const entries = input.entries ?? (await readCustodyLedgerAsync(runtime, runDir, budget.observation));
  const reporting = input.log !== undefined || budget.observation?.reportState !== undefined;
  let sweep = reporting ? finishedCustodySweeps.get(runtime) : undefined;
  const continuingSweep = sweep?.runDir === runDir && sweep.afterId === input.afterId;
  if (reporting && input.afterId === '' && !continuingSweep) {
    sweep = { runDir, afterId: '', entries: new Map(), firstDamaged: new Map() };
    finishedCustodySweeps.set(runtime, sweep);
  } else if (!continuingSweep) {
    finishedCustodySweeps.delete(runtime);
    sweep = undefined;
  }
  const outcomes: CustodyPassEntry[] | undefined = sweep === undefined ? undefined : [];
  const hold = (entry: Extract<CustodyEntry, { kind: 'bound' }>, reason: string): void => {
    outcomes?.push({ ...custodyPassEntry(runDir, entry), disposition: 'holding', reason });
  };
  let completed = false;
  try {
    for (const entry of [...entries].sort((left, right) =>
      (left.kind === 'unreadable' ? left.path : left.intent.id).localeCompare(
        right.kind === 'unreadable' ? right.path : right.intent.id,
      ),
    )) {
      if (entry.kind === 'unreadable') {
        outcomes?.push(custodyPassEntry(runDir, entry));
        continue;
      }
      if (entry.intent.id <= input.afterId) continue;
      if (!budget.canContinue()) return cursor;
      outcomes?.push(custodyPassEntry(runDir, entry));
      if (entry.kind === 'bound') {
        try {
          if (
            !['durable-cli', 'provider-operation', 'provider-proxy-set', 'provider-host'].includes(entry.intent.owner)
          ) {
            const reason = 'custody-awaits-known-owner-discharge';
            hold(entry, reason);
            budget.record({ kind: 'kept', subject: entry.intent.id, reason });
            cursor = entry.intent.id;
            if (++scanned % 32 === 0) input.checkpoint?.(cursor);
            await setImmediate();
            continue;
          }
          const jobId = entry.intent.owner === 'durable-cli' ? entry.intent.operationId : entry.intent.jobId;
          const needsResult = entry.intent.effect === 'provider-operation-publication' || jobId !== undefined;
          let resultReady = !needsResult;
          const recordedRoots: RecordedProcessIdentity[] = [];
          let failureDomain: FailureDomainContainment | undefined;
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
              const finished =
                epoch === null || epoch === undefined
                  ? null
                  : readFinishedCarrierEvidence(runtime, epoch, jobId, entry.binding.process);
              const initial = finished?.evidence;
              failureDomain = finished?.failureDomain;
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
            const reason =
              'custody-awaits-exact-terminal-result-and-transfer; daily reconciliation retries after retained result durability and identity-bound runtime evidence are available';
            hold(entry, reason);
            budget.record({ kind: 'kept', subject: entry.intent.id, reason });
          } else {
            let absent = entry.intent.effect === 'provider-operation-publication';
            const identity = entry.binding.process;
            const durableLeaf = createFailureDomainContainmentObservation(failureDomain);
            let hostLeaf = createFailureDomainContainmentObservation<FailureDomainContainment>(undefined);
            if (identity !== null) {
              const hostDomain =
                entry.intent.owner === 'provider-host'
                  ? recordedHostFailureDomain(runtime, runDir, entry, entries)
                  : undefined;
              hostLeaf = createFailureDomainContainmentObservation(hostDomain);
              const hostAbsent = hostLeaf.permitsIndependentAbsenceDecision();
              const environment = {
                failureDomain: durableLeaf.failureDomain,
                process: runtime.process,
                platform: runtime.env.platform() as NodeJS.Platform,
                readProcessIncarnation: (pid: number, platform: NodeJS.Platform) =>
                  runtime.process.readProcessIncarnation(pid, platform),
              };
              if (hostAbsent && custodyBindsGroupMember(entry.intent.owner, identity)) {
                const confirmed = await confirmRecordedGroupMemberAbsence(identity, recordedRoots, {
                  ...environment,
                  clock,
                  signal,
                });
                absent = confirmed.kind === 'absent';
              } else if (
                hostAbsent &&
                observeRecordedContainment({ ...identity, childRoot: null }, environment).kind === 'absent' &&
                recordedRoots.every(
                  (root) => observeRecordedContainment({ ...identity, childRoot: root }, environment).kind === 'absent',
                )
              ) {
                const proof = await reapRecordedContainment(
                  identity,
                  recordedRoots,
                  clock.shiftMilliseconds(
                    clock.now(),
                    ABSENCE_CONFIRMATION_DEADLINE_MS + recordedRoots.length * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
                  ),
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
            if (
              absent &&
              hostLeaf.permitsIndependentAbsenceDecision() &&
              durableLeaf.permitsIndependentAbsenceDecision()
            ) {
              const discharged = dischargeCustodyEntry(
                runtime,
                runDir,
                entry,
                runtime.time.now(),
                'exact owner obligations discharged; retained terminal/result and matching transfers; recorded incarnation and containment absent',
                mutate,
              );
              if (discharged) {
                budget.observation?.record('custody-ledger', { subjects: 1 });
                outcomes?.push({
                  ...custodyPassEntry(runDir, entry),
                  disposition: 'absent',
                  reason:
                    'exact owner obligations discharged; retained terminal/result and matching transfers; recorded incarnation and containment absent',
                });
              } else {
                const reason = 'custody-discharge-lock-or-identity-changed; retry-after-reconciliation';
                hold(entry, reason);
                budget.record({ kind: 'kept', subject: entry.intent.id, reason });
              }
            } else {
              const reason = 'custody-awaits-recorded-incarnation-and-containment-absence';
              hold(entry, reason);
              budget.record({ kind: 'kept', subject: entry.intent.id, reason });
            }
          }
        } catch {
          const reason = 'custody-evidence-unreadable; retry-after-reconciliation';
          hold(entry, reason);
          budget.record({ kind: 'kept', subject: entry.intent.id, reason });
        }
      }
      cursor = entry.intent.id;
      if (++scanned % 32 === 0) input.checkpoint?.(cursor);
      await setImmediate();
    }
    completed = true;
    return '';
  } finally {
    if (sweep !== undefined && outcomes !== undefined) {
      for (const outcome of outcomes) {
        const damaged =
          outcome.disposition === 'unreadable' || (outcome.disposition === 'holding' && outcome.reason !== null);
        if (damaged && !sweep.firstDamaged.has(outcome.entry)) sweep.firstDamaged.set(outcome.entry, outcome);
        sweep.entries.set(outcome.entry, outcome);
      }
      if (completed) {
        finishedCustodySweeps.delete(runtime);
        reportCustodyPass(
          runtime,
          runDir,
          'finished',
          { entries: [...sweep.entries.values()], firstDamaged: [...sweep.firstDamaged.values()] },
          budget.observation,
          input.log,
          signal,
        );
      } else {
        sweep.afterId = cursor;
      }
    }
  }
}
