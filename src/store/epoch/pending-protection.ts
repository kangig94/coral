import { type Runtime } from '../../runtime/ports.js';
import { join } from 'node:path';
import { writeAuditEvent } from '../../infra/audit-log.js';
import { observeStorePath } from '../path-observation.js';
import { protectStoreEpoch, StoreEpochOpenerHeldError } from './protection.js';
import { type StoreEpoch } from './types.js';
import { epochDirectory, compareEpoch, observeStoreEpochs, resolvedStoreEpoch } from './observation.js';
import { EPOCH_DIRECTORY_PATTERN } from './constants.js';
import { auditSweepFailure } from './sweep-audit.js';

/** A mint must wait only briefly for an opener; this wait blocks startup. */
export const SUPERSEDED_OPENER_DRAIN_MS = 2_000;

type PendingProtection = Readonly<{ storeRoot: string; epoch: StoreEpoch; reason: string; recordedAt: string }>;

type PendingProtectionRead = Readonly<{
  records: readonly PendingProtection[];
  unreadableNames: readonly string[];
  directoryUnreadable: boolean;
}>;

function pendingProtectionDirectory(runtime: Pick<Runtime, 'paths'>): string {
  return join(runtime.paths.coral.generation.dataRoot, 'store-epoch-protection-pending.v1');
}

function pendingProtectionPath(runtime: Pick<Runtime, 'paths' | 'ids'>, storeRoot: string, epoch: StoreEpoch): string {
  return join(pendingProtectionDirectory(runtime), `${runtime.ids.sha256(epochDirectory(storeRoot, epoch))}.json`);
}

/** Unknown keys are kept for a newer writer; a record this build cannot read is reported and never deleted. */
export function readPendingProtections(runtime: Pick<Runtime, 'paths' | 'storage'>): PendingProtectionRead {
  let names: string[];
  try {
    names = runtime.storage.readdirSync(pendingProtectionDirectory(runtime));
  } catch (error: unknown) {
    return {
      records: [],
      unreadableNames: [],
      directoryUnreadable: !(error instanceof Error && 'code' in error && error.code === 'ENOENT'),
    };
  }
  const records: PendingProtection[] = [];
  const unreadableNames: string[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(
        runtime.storage.readFileSync(join(pendingProtectionDirectory(runtime), name), 'utf-8'),
      ) as unknown;
      if (
        typeof value === 'object' &&
        value !== null &&
        'version' in value &&
        value.version === 'v1' &&
        'storeRoot' in value &&
        typeof value.storeRoot === 'string' &&
        'epoch' in value &&
        typeof value.epoch === 'string' &&
        EPOCH_DIRECTORY_PATTERN.test(`epoch-${value.epoch}`) &&
        'reason' in value &&
        typeof value.reason === 'string' &&
        'recordedAt' in value &&
        typeof value.recordedAt === 'string'
      ) {
        records.push({
          storeRoot: value.storeRoot,
          epoch: value.epoch,
          reason: value.reason,
          recordedAt: value.recordedAt,
        });
        continue;
      }
    } catch {
      // An undecodable record is retained for its writer to resolve.
    }
    unreadableNames.push(name);
  }
  return { records, unreadableNames, directoryUnreadable: false };
}

export function pendingProtectionUnreadable(
  runtime: Pick<Runtime, 'ids'>,
  read: PendingProtectionRead,
  storeRoot: string,
  epoch: StoreEpoch,
): boolean {
  return (
    read.directoryUnreadable ||
    read.unreadableNames.includes(`${runtime.ids.sha256(epochDirectory(storeRoot, epoch))}.json`)
  );
}

/** A superseded epoch must remain reachable to shipped older sweeps until protection succeeds. */
export function recordPendingProtection(
  runtime: Runtime,
  storeRoot: string,
  epoch: StoreEpoch,
  reason: string,
): Readonly<{ kind: 'recorded' }> | Readonly<{ kind: 'unrecorded'; cause: Error }> {
  writeAuditEvent('store_epoch_protection_deferred', { path: epochDirectory(storeRoot, epoch), cause: reason }, 'warn');
  try {
    runtime.storage.mkdirSync(pendingProtectionDirectory(runtime), { recursive: true, mode: 0o700 });
    if (!runtime.storage.syncDirectoryDurableSync(runtime.paths.coral.generation.dataRoot)) {
      throw new Error('Pending protection directory could not be linked durably.');
    }
    const path = pendingProtectionPath(runtime, storeRoot, epoch);
    let previous: Record<string, unknown> = {};
    try {
      const candidate = JSON.parse(runtime.storage.readFileSync(path, 'utf-8')) as unknown;
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        Array.isArray(candidate) ||
        !('version' in candidate) ||
        candidate.version !== 'v1' ||
        !('storeRoot' in candidate) ||
        candidate.storeRoot !== storeRoot ||
        !('epoch' in candidate) ||
        candidate.epoch !== epoch ||
        !('reason' in candidate) ||
        typeof candidate.reason !== 'string' ||
        !('recordedAt' in candidate) ||
        typeof candidate.recordedAt !== 'string'
      )
        throw new Error('Existing pending protection record is unreadable.');
      previous = candidate as Record<string, unknown>;
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const record = {
      ...previous,
      version: 'v1',
      storeRoot,
      epoch,
      reason,
      recordedAt: new Date(runtime.time.now()).toISOString(),
    };
    if (!runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 }))
      throw new Error('Pending protection record could not be written durably.');
    return { kind: 'recorded' };
  } catch (cause: unknown) {
    writeAuditEvent('store_epoch_protection_unrecorded', { path: epochDirectory(storeRoot, epoch) }, 'error');
    return { kind: 'unrecorded', cause: cause instanceof Error ? cause : new Error(String(cause)) };
  }
}

function clearPendingProtection(runtime: Runtime, pending: PendingProtection): void {
  const current = readPendingProtections(runtime).records.find(
    (record) => record.storeRoot === pending.storeRoot && record.epoch === pending.epoch,
  );
  if (current === undefined || JSON.stringify(current) !== JSON.stringify(pending)) return;
  try {
    runtime.storage.rmSync(pendingProtectionPath(runtime, pending.storeRoot, pending.epoch), { force: true });
  } catch (error: unknown) {
    auditSweepFailure(epochDirectory(pending.storeRoot, pending.epoch), error);
  }
}

/** Only an epoch older than the one this process opened may be protected; an epoch already gone needs nothing. */
export function retryPendingProtections(runtime: Runtime, storeRoot: string, openEpoch: StoreEpoch): void {
  const pendingRead = readPendingProtections(runtime);
  for (const pending of pendingRead.records) {
    if (pending.storeRoot !== storeRoot || compareEpoch(pending.epoch, openEpoch) >= 0) continue;
    const directory = epochDirectory(storeRoot, pending.epoch);
    if (observeStorePath(runtime.storage, directory) === 'absent') {
      clearPendingProtection(runtime, pending);
    }
  }
  const retryRead = readPendingProtections(runtime);
  const pendingEpochs = new Map(
    retryRead.records.filter((pending) => pending.storeRoot === storeRoot).map((pending) => [pending.epoch, pending]),
  );
  for (const observation of observeStoreEpochs(runtime.storage, storeRoot)) {
    if (
      observation.proof.kind !== 'proven' ||
      compareEpoch(observation.epoch, openEpoch) >= 0 ||
      (!pendingEpochs.has(observation.epoch) &&
        !pendingProtectionUnreadable(runtime, retryRead, storeRoot, observation.epoch))
    )
      continue;
    const directory = epochDirectory(storeRoot, observation.epoch);
    try {
      protectStoreEpoch(runtime, resolvedStoreEpoch(storeRoot, observation.epoch));
      const pending = pendingEpochs.get(observation.epoch);
      if (pending !== undefined) clearPendingProtection(runtime, pending);
    } catch (error: unknown) {
      if (!(error instanceof StoreEpochOpenerHeldError)) auditSweepFailure(directory, error);
    }
  }
}
