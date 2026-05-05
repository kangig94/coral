import type { KbDiagnoseResult } from './entry-types.js';
import type { PendingRepair } from './curate/state/index.js';

function parseDiagnoseSignals(entry: PendingRepair): unknown {
  if (entry.signalsJson === undefined) {
    return null;
  }

  return JSON.parse(entry.signalsJson);
}

export function buildKbDiagnoseResult(entries: ReadonlyArray<PendingRepair>): KbDiagnoseResult {
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

  return {
    incidents,
  };
}
