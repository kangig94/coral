import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

import { observeRecordedContainment, reapRecordedContainment } from '../../../infra/process-containment.js';
import { createMonotonicClock } from '../../../infra/monotonic-clock.js';
import { isProcessIncarnation, type ProcessIncarnation } from '../../../infra/node-process.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS, CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS, SIGTERM_GRACE_MS,
} from '../../../infra/process-constants.js';
import { custodyLedgerDir, readCustodyLedger, type CustodyEntry } from '../../../store/custody-ledger.js';
import { hasEpochCustodyCoverage, readEpochClosure, recordEpochClosure, type EpochClosureEvidence } from '../../../store/epoch-closure.js';
import { knownProtectedEpochAddresses, reconcileProtectedEpochs } from '../../../store/epoch-protection.js';
import { listStoreEpochs, type ResolvedStoreEpoch } from '../../../store/epoch.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { JobLocationIndex } from '../../../jobs/location-index.js';
import { readDurableCliControllerReceipts } from '../../succession/durable-cli-transfer.js';
import { defineRecoverySource, type RecoverySubject } from '../../../recovery/containment.js';
import type { RecoverySourceFactoryPlan } from '../../../recovery/source-registry.js';

type ClosureCandidate = Readonly<{ epoch: ResolvedStoreEpoch; epochKey: string; originalPath: string }>;
type CloseProxySet = (
  proxyInstanceId: string,
  guardian: Readonly<{ pid: number; incarnation: ProcessIncarnation }>,
  signal: AbortSignal,
) => Promise<boolean>;
const closureClockScope = Symbol('epoch-closure');
const REAP_DEADLINE_MS = SIGTERM_GRACE_MS + SIGKILL_GRACE_MS +
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS + 2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS;

function closureCandidates(runtime: Runtime): ClosureCandidate[] {
  let storeRoot = runtime.paths.coral.store.dbDir;
  try { storeRoot = runtime.storage.realpathSync(storeRoot); } catch { return []; }
  const canonical = listStoreEpochs(runtime)
    .filter((entry) => entry.role !== 'protected' && entry.resolved !== null && entry.epochKey !== null)
    .map((entry) => ({
      epoch: entry.resolved!, originalPath: dirname(entry.resolved!.path), epochKey: entry.epochKey!,
    }));
  const protectedEpochs = reconcileProtectedEpochs(storeRoot).map((address) => ({
    epoch: {
      storeRoot: dirname(address.protectedPath),
      epoch: address.epochKey.slice(address.epochKey.lastIndexOf(':') + 1),
      path: join(address.protectedPath, 'store.db'),
    },
    originalPath: address.originalPath,
    epochKey: address.epochKey,
  }));
  return [...canonical, ...protectedEpochs];
}

async function certifyCustody(
  runtime: Runtime,
  index: JobLocationIndex,
  candidate: ClosureCandidate,
  entries: readonly CustodyEntry[],
  ambiguousOriginalPath: boolean,
  signal: AbortSignal,
  closeProxySet?: CloseProxySet,
): Promise<Pick<EpochClosureEvidence, 'executionDischarge' | 'obligations' | 'reason'>> {
  if (!hasEpochCustodyCoverage(dirname(candidate.epoch.path), runtime.paths.coral.coordinator.runDir)) {
    return { executionDischarge: 'undecidable', obligations: [], reason: 'this epoch predates complete pre-effect custody coverage' };
  }
  if (!existsSync(custodyLedgerDir(runtime.paths.coral.coordinator.runDir))) {
    return { executionDischarge: 'undecidable', obligations: [], reason: 'custody ledger root is missing' };
  }
  if (ambiguousOriginalPath && entries.some((entry) =>
    entry.kind !== 'unreadable' && entry.intent.epochKey === undefined &&
    entry.intent.epoch === candidate.originalPath)) {
    return {
      executionDischarge: 'undecidable', obligations: [],
      reason: 'path-only custody cannot distinguish reused epoch numbers',
    };
  }
  const matching = entries.filter((entry) =>
    entry.kind !== 'unreadable' &&
    (entry.intent.epochKey === undefined
      ? entry.intent.epoch === candidate.originalPath ||
        entry.intent.epoch === dirname(candidate.epoch.path) ||
        entry.intent.epoch === candidate.epochKey
      : entry.intent.epochKey === candidate.epochKey),
  );
  if (entries.some((entry) => entry.kind === 'unreadable')) {
    return { executionDischarge: 'undecidable', obligations: [], reason: 'custody ledger is unreadable; retry after evidence is readable' };
  }
  if (matching.length === 0) {
    return { executionDischarge: 'certified', obligations: [], reason: 'covered epoch has no recorded external effects' };
  }
  const receipts = readDurableCliControllerReceipts(runtime.paths.coral.coordinator.runDir);
  const obligations: EpochClosureEvidence['obligations'][number][] = [];
  for (const entry of matching) {
    if (entry.kind === 'holding') {
      return { executionDischarge: 'undecidable', obligations, reason: `custody intent ${entry.intent.id} awaits ${entry.exit}` };
    }
    if (entry.kind === 'absent') {
      obligations.push({ owner: entry.intent.owner, intentId: entry.intent.id, outcome: 'absent', evidence: entry.evidence });
      continue;
    }
    if (entry.intent.effect === 'provider-operation-publication') {
      let location: ReturnType<JobLocationIndex['read']> = null;
      try {
        if (entry.intent.jobId !== undefined) location = index.read(entry.intent.jobId);
      } catch {
        return { executionDischarge: 'undecidable', obligations, reason: `provider operation ${entry.intent.operationId} result is unreadable` };
      }
      if (location?.epochKey !== candidate.epochKey || location.disposition !== 'terminal') {
        return { executionDischarge: 'undecidable', obligations, reason: `provider operation ${entry.intent.operationId} awaits owner terminal result` };
      }
      obligations.push({
        owner: entry.intent.owner, intentId: entry.intent.id, outcome: 'terminal',
        evidence: `job ${entry.intent.jobId} has a retained terminal location`,
      });
      continue;
    }
    if (entry.binding.process === null) {
      return { executionDischarge: 'undecidable', obligations, reason: `custody intent ${entry.intent.id} has no process identity` };
    }
    if (entry.intent.owner === 'durable-cli') {
      let location: ReturnType<JobLocationIndex['read']>;
      try {
        location = index.read(entry.intent.operationId);
      } catch {
        return { executionDischarge: 'undecidable', obligations, reason: `durable-cli ${entry.intent.operationId} location is unreadable` };
      }
      const transfers = receipts?.filter((receipt) => receipt.jobId === entry.intent.operationId);
      if (location?.epochKey !== candidate.epochKey || location.disposition !== 'terminal' ||
          transfers === undefined || (transfers.length > 0 && !transfers.some((receipt) =>
            receipt.custodyIntentId === entry.intent.id && receipt.lineageEpochKey === candidate.epochKey))) {
        return { executionDischarge: 'undecidable', obligations, reason: `durable-cli ${entry.intent.operationId} awaits terminal result or matching controller receipt` };
      }
    }
    const process = entry.binding.process;
    if (!isProcessIncarnation(process.incarnation)) {
      return { executionDischarge: 'undecidable', obligations, reason: `custody process ${process.pid} has an invalid incarnation` };
    }
    const identity = { pid: process.pid, incarnation: process.incarnation, processGroupId: process.processGroupId };
    let absenceConfirmed: boolean;
    if (entry.intent.owner === 'durable-cli') {
      const clock = createMonotonicClock(closureClockScope, {
        readMilliseconds: () => runtime.time.monotonicNow(),
        sleep: (milliseconds) => runtime.time.sleep(milliseconds),
      });
      try {
        const outcome = await reapRecordedContainment(
          identity, [], clock.shiftMilliseconds(clock.now(), REAP_DEADLINE_MS),
          {
            maxRecordedRoots: 0, clock, process: runtime.process,
            platform: runtime.env.platform() as NodeJS.Platform,
            readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
            signal,
          },
        );
        absenceConfirmed = outcome.kind === 'containment-absent';
      } catch {
        absenceConfirmed = false;
      }
    } else {
      if (entry.intent.owner === 'provider-proxy-set' && closeProxySet !== undefined) {
        let resultsReady = false;
        try { resultsReady = index.resultsReleased(candidate.epochKey); } catch {}
        if (resultsReady) {
          const proxyInstanceId = entry.intent.operationId.endsWith(':guardian')
            ? entry.intent.operationId.slice(0, -':guardian'.length)
            : null;
          if (proxyInstanceId !== null) {
            try { await closeProxySet(proxyInstanceId, identity, signal); } catch {}
          }
        }
      }
      absenceConfirmed = observeRecordedContainment(
        { ...identity, childRoot: null },
        {
          process: runtime.process,
          platform: runtime.env.platform() as NodeJS.Platform,
          readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
        },
      ).kind === 'absent';
    }
    if (!absenceConfirmed) {
      return {
        executionDischarge: 'undecidable', obligations,
        reason: `${entry.intent.owner} ${entry.intent.operationId} awaits owner-controlled process discharge`,
      };
    }
    obligations.push({
      owner: entry.intent.owner, intentId: entry.intent.id,
      outcome: entry.intent.owner === 'durable-cli' ? 'terminal-and-absent' : 'absent',
      evidence: `recorded process ${process.pid}/${process.incarnation} and group ${process.processGroupId} absent`,
    });
  }
  return { executionDischarge: 'certified', obligations, reason: 'owners certified every recorded custody obligation' };
}

export async function settleSupersededEpochClosures(
  runtime: Runtime,
  index: JobLocationIndex,
  signal?: AbortSignal,
  subjectKey?: string,
  activeEpochKey?: string,
  closeProxySet?: CloseProxySet,
): Promise<EpochClosureEvidence[]> {
  const stateRoot = runtime.paths.coral.generation.dataRoot;
  const selectedKey = activeEpochKey ?? listStoreEpochs(runtime).find((entry) => entry.role === 'current')?.epochKey;
  const custody = readCustodyLedger(runtime.paths.coral.coordinator.runDir);
  const evidence: EpochClosureEvidence[] = [];
  const candidates = closureCandidates(runtime);
  if (candidates.length === 0) return evidence;
  let historicalAddresses: ReturnType<typeof knownProtectedEpochAddresses>;
  try {
    historicalAddresses = knownProtectedEpochAddresses(runtime.storage.realpathSync(runtime.paths.coral.store.dbDir));
  } catch {
    for (const candidate of candidates) {
      if (candidate.epochKey === selectedKey) continue;
      evidence.push(recordEpochClosure(stateRoot, {
        version: 'v1', epochKey: candidate.epochKey,
        disposition: 'unrecoverable-retained', dataOutcome: 'unreadable', executionDischarge: 'undecidable',
        obligations: [], reason: 'protected address map is unreadable', observedAtMs: runtime.time.now(),
      }));
    }
    return evidence;
  }
  for (const candidate of candidates) {
    if (signal?.aborted) break;
    if (subjectKey !== undefined && subjectKey !== candidate.epochKey) continue;
    if (candidate.epochKey === selectedKey) continue;
    let previous: EpochClosureEvidence | null;
    try { previous = readEpochClosure(stateRoot, candidate.epochKey); } catch { continue; }
    let dataOutcome: EpochClosureEvidence['dataOutcome'];
    try {
      dataOutcome = index.resultsReleased(candidate.epochKey) ? 'retained' :
        index.unknownLocationHold(candidate.epochKey) !== null ? 'unreadable' : 'unknown';
    } catch {
      dataOutcome = 'unreadable';
    }
    if (previous?.disposition === 'closed') {
      evidence.push(previous.dataOutcome === dataOutcome ? previous : recordEpochClosure(stateRoot, {
        ...previous, dataOutcome, observedAtMs: runtime.time.now(),
      }));
      continue;
    }
    const ambiguousOriginalPath = candidates.some((other) =>
      other.epochKey !== candidate.epochKey && other.originalPath === candidate.originalPath) ||
      historicalAddresses.some((address) =>
        address.epochKey !== candidate.epochKey && address.originalPath === candidate.originalPath);
    const settlement = await certifyCustody(
      runtime, index, candidate, custody, ambiguousOriginalPath, signal ?? new AbortController().signal,
      closeProxySet,
    );
    const record = recordEpochClosure(stateRoot, {
      version: 'v1', epochKey: candidate.epochKey,
      disposition: settlement.executionDischarge === 'certified' ? 'closed' : 'unrecoverable-retained',
      dataOutcome, ...settlement, observedAtMs: runtime.time.now(),
    });
    evidence.push(record);
  }
  return evidence;
}

export function createEpochClosureRetryPlan(
  runtime: Runtime,
  index: JobLocationIndex,
  subject: RecoverySubject,
  signal: AbortSignal,
  activeEpochKey: string | null,
  closeProxySet?: CloseProxySet,
): RecoverySourceFactoryPlan<ClosureCandidate, ClosureCandidate> {
  const selectedKey = activeEpochKey ?? listStoreEpochs(runtime).find((entry) => entry.role === 'current')?.epochKey;
  return {
    source: defineRecoverySource({
      boundary: 'epoch-closure',
      scanSubject: subject,
      scan: () => closureCandidates(runtime).filter((candidate) =>
        candidate.epochKey === subject.key && candidate.epochKey !== selectedKey),
      subject: (candidate) => ({ key: candidate.epochKey, revision: { kind: 'until-cleared' } }),
    }),
    policy: {
      processLocalCleanup: { kind: 'not-required' },
      hydrate: (raw) => raw,
      requiredObligations: () => [],
      settle: async (candidate) => {
        const records = await settleSupersededEpochClosures(
          runtime, index, signal, candidate.epochKey, activeEpochKey ?? undefined, closeProxySet,
        );
        return records[0]?.disposition === 'closed'
          ? { kind: 'advanced', outcome: 'settled', facts: [], detail: 'Epoch execution discharge certified.' }
          : { kind: 'quarantine', detail: records[0]?.reason ?? 'Epoch closure remains undecidable.' };
      },
      onFault: (fault) => ({ kind: 'quarantine', detail: String(fault.error) }),
    },
  };
}
