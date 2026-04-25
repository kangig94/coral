import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import { readPendingRepairRows, type PendingRepairRetryCandidate } from '../../curate/retry.js';

type PendingRepairRetryRuntime = {
  db: BetterSqlite3.Database;
  notePath(note: string): string;
  sourcePath(source: string): string;
};

function pendingRepairPath(runtime: PendingRepairRetryRuntime, entry: PendingRepairRetryCandidate): string | null {
  if (entry.entryId.startsWith('note:')) {
    return runtime.notePath(entry.entryId.slice('note:'.length));
  }
  if (entry.entryId.startsWith('source:')) {
    return runtime.sourcePath(entry.entryId.slice('source:'.length));
  }

  return null;
}

function readPendingRepairContentHash(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path, 'utf-8'), 'utf8').digest('hex');
  } catch {
    return null;
  }
}

export function pendingRepairNeedsRetry(runtime: PendingRepairRetryRuntime): boolean {
  const pendingRepair = readPendingRepairRows(runtime);
  if (pendingRepair.length === 0) {
    return false;
  }

  return pendingRepair.some((entry) => {
    const path = pendingRepairPath(runtime, entry);
    if (path === null) {
      return false;
    }
    if (entry.observedContentHash === undefined) {
      return (entry.reason ?? 'pending-repair') === 'pending-repair';
    }

    const currentHash = readPendingRepairContentHash(path);
    return currentHash === null || currentHash !== entry.observedContentHash;
  });
}
