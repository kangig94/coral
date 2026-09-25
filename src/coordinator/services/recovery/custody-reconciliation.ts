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
import type { Database } from '../../../store/db.js';

const CUSTODY_ABSENCE_GRACE_MS = 2_000;

export function reconcileStartupCustody(
  runDir: string,
  nowMs: number,
  db: Database,
  currentEpoch: string,
  evidence?: Readonly<{
    readProcessIncarnation(pid: number): string | null;
    capsuleExists(path: string): boolean;
  }>,
): CustodyEntry[] {
  let operations: ReturnType<typeof readProviderOperations> | null;
  try {
    operations = readProviderOperations(db);
  } catch {
    operations = null;
  }
  for (const entry of readCustodyLedger(runDir)) {
    if (entry.kind !== 'holding' || entry.intent.epoch !== currentEpoch) continue;
    if (entry.intent.effect === 'provider-operation-publication') {
      if (operations?.records.some((record) => record.operation.operationId === entry.intent.operationId)) {
        bindCustodyIdentity(
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
    if (entry.intent.owner !== 'durable-cli' || evidence === undefined || nowMs > entry.intent.bindDeadlineMs) continue;
    const token = findCustodyProcessToken(entry.intent.processToken);
    if (token.kind !== 'alive') continue;
    let runtime: ReturnType<typeof readDurableCliPreReadyOwnershipEvidence>;
    try {
      runtime = readDurableCliPreReadyOwnershipEvidence(db, entry.intent.operationId);
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
      (runtime.kind === 'current' || runtime.kind === 'provisional') &&
      runtime.record.pid === token.pid &&
      incarnation === runtime.record.incarnation
    ) {
      bindCustodyIdentity(
        runDir,
        entry.intent,
        {
          process: {
            pid: token.pid,
            incarnation: runtime.record.incarnation,
            processGroupId: runtime.record.processGroupId,
          },
          capsule: entry.intent.capsule,
          observedAtMs: nowMs,
        },
        'recovered',
      );
    }
  }
  const observe = (intent: CustodyIntent): CustodyObservation => {
    if (intent.effect === 'provider-operation-publication') {
      if (intent.epoch !== currentEpoch) return { kind: 'unknown' };
      return operations !== null && operations.unreadableKeys.length === 0
        ? {
            kind: 'absent',
            processToken: intent.processToken,
            evidence: 'complete provider-operation scan found no publication',
          }
        : { kind: 'unknown' };
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
  return reconcileCustodyLedger(runDir, nowMs, CUSTODY_ABSENCE_GRACE_MS, observe);
}
