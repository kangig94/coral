import type { KbDiagnoseResult } from './entry-types.js';
import type { CurateConflictQuarantineEntry } from './curate/conflict-quarantine.js';
import type { PendingRepair } from './curate/state/index.js';

function parseDiagnoseSignals(entry: PendingRepair): unknown {
  if (entry.signalsJson === undefined) {
    return null;
  }

  return JSON.parse(entry.signalsJson);
}

function quarantineSignals(entry: CurateConflictQuarantineEntry): Record<string, string> {
  return {
    recovery_ref: entry.recoveryRef,
    path: entry.path,
    detected_at: entry.detectedAt,
  };
}

function quarantineRepairHint(entry: CurateConflictQuarantineEntry): string {
  return [
    `Recover local work from ${entry.recoveryRef}.`,
    `Inspect it with 'git show ${entry.recoveryRef}:${entry.path}' or 'git log ${entry.recoveryRef}'.`,
    `After landing or discarding the recovered work, delete the ref with 'git update-ref -d ${entry.recoveryRef}'.`,
  ].join(' ');
}

export function buildKbDiagnoseResult(
  entries: ReadonlyArray<PendingRepair>,
  quarantinedEntries: ReadonlyArray<CurateConflictQuarantineEntry> = [],
): KbDiagnoseResult {
  const incidents: KbDiagnoseResult['incidents'] = [];
  for (const entry of entries) {
    incidents.push({
      entry_id: entry.entryId,
      locus: entry.locus ?? null,
      canonical_incident: entry.canonicalIncident ?? null,
      repair_hint: entry.repairHint ?? null,
      signals: parseDiagnoseSignals(entry),
      retry_count: entry.retryCount ?? 0,
      retry_not_before: entry.retryNotBefore ?? entry.detectedAt,
    });
  }

  for (const entry of quarantinedEntries) {
    incidents.push({
      entry_id: entry.entryId,
      locus: 'kb.curate.conflict_quarantine',
      canonical_incident: 'git/body-prose-conflict',
      repair_hint: quarantineRepairHint(entry),
      signals: quarantineSignals(entry),
      retry_count: 0,
      retry_not_before: entry.detectedAt,
    });
  }

  return {
    incidents,
  };
}
