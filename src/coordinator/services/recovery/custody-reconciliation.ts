import { dirname } from 'node:path';

import { findCustodyProcessToken } from '../../../infra/custody-process-ticket.js';
import { readDurableCliPreReadyOwnershipEvidence } from '../../../jobs/runtime-meta-store.js';
import {
  bindCustodyIdentity,
  readCustodyLedger,
  reconcileCustodyLedger,
  type CustodyEntry,
  type CustodyIntent,
  type CustodyObservation,
} from '../../../store/custody-ledger.js';
import { readProviderOperations } from '../../../store/provider-operation-journal.js';
import { acquireStoreEpochReadLock } from '../../../store/epoch.js';
import type { Database } from '../../../store/db.js';
import type { Runtime } from '../../../runtime/ports.js';
import { closureCandidates } from './epoch-closure.js';

const CUSTODY_ABSENCE_GRACE_MS = 2_000;

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
        : intent.epochKey === candidate.epochKey,
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
