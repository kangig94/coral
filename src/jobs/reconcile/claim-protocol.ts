import { isNoEntryError, isRecord } from '../../shared/utils.js';
import { parseJobStatusRecord } from '../records.js';
import type { Runtime } from '../../runtime/ports.js';
import type { JobStatusRecord } from '../records.js';

const ADOPTION_CLAIM_STALE_MS = 30_000;

export type AdoptionStatusSnapshot = {
  raw: string;
  record: JobStatusRecord;
};

export type AdoptionClaimRecord = {
  ownerId: string;
  claimedAt: number;
  stagedPath: string;
  verifiedStatusRaw: string;
};

type AdoptionClaimSnapshot = {
  raw: string;
  record: AdoptionClaimRecord | null;
  mtimeMs: number;
};

function isAdoptionClaimRecord(value: unknown): value is AdoptionClaimRecord {
  return (
    isRecord(value) &&
    typeof value.ownerId === 'string' &&
    value.ownerId.length > 0 &&
    typeof value.claimedAt === 'number' &&
    Number.isFinite(value.claimedAt) &&
    typeof value.stagedPath === 'string' &&
    value.stagedPath.length > 0 &&
    typeof value.verifiedStatusRaw === 'string'
  );
}

export function claimPathForStatus(statusPath: string): string {
  return `${statusPath}.adopt.lock`;
}

function stagedStatusPath(statusPath: string, ownerId: string): string {
  return `${statusPath}.adopt.stage.${ownerId}`;
}

function createAdoptionOwnerId(nowMs: number, ids: Pick<Runtime['ids'], 'randomBytes'>): string {
  return `${nowMs}-${ids.randomBytes(6).toString('hex')}`;
}

export function readAdoptionStatusSnapshot(
  statusPath: string,
  storage: Pick<Runtime['storage'], 'readFileSync'>,
): AdoptionStatusSnapshot | null {
  try {
    const raw = storage.readFileSync(statusPath, 'utf-8');
    const parsed = parseJobStatusRecord(JSON.parse(raw));
    if (parsed === null) return null;
    return {
      raw,
      record: parsed,
    };
  } catch {
    return null;
  }
}

function readAdoptionClaimSnapshot(
  claimPath: string,
  storage: Pick<Runtime['storage'], 'readFileSync' | 'statSync'>,
): AdoptionClaimSnapshot | null {
  try {
    const raw = storage.readFileSync(claimPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return {
      raw,
      record: isAdoptionClaimRecord(parsed) ? parsed : null,
      mtimeMs: storage.statSync(claimPath).mtimeMs,
    };
  } catch (error: unknown) {
    if (isNoEntryError(error)) return null;
    throw error;
  }
}

export function unlinkIfPresent(path: string, storage: Pick<Runtime['storage'], 'unlinkSync'>): void {
  try {
    storage.unlinkSync(path);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

function restoreClaimFileIfMissing(
  fromPath: string,
  toPath: string,
  storage: Pick<Runtime['storage'], 'existsSync' | 'renameSync'>,
): void {
  if (storage.existsSync(toPath)) return;
  try {
    storage.renameSync(fromPath, toPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }
}

function rollbackUnexpectedStagedStatus(
  statusPath: string,
  stagedPath: string,
  storage: Pick<Runtime['storage'], 'existsSync' | 'renameSync' | 'unlinkSync'>,
): void {
  if (!storage.existsSync(stagedPath)) return;

  if (!storage.existsSync(statusPath)) {
    try {
      storage.renameSync(stagedPath, statusPath);
      return;
    } catch (error: unknown) {
      if (!isNoEntryError(error)) throw error;
    }
  }

  unlinkIfPresent(stagedPath, storage);
}

export function restoreVerifiedStagedStatus(
  statusPath: string,
  stagedPath: string,
  verifiedStatusRaw: string,
  storage: Pick<Runtime['storage'], 'existsSync' | 'readFileSync' | 'renameSync' | 'tryExclusiveWriteSync' | 'unlinkSync'>,
): void {
  let stagedRaw: string;
  try {
    stagedRaw = storage.readFileSync(stagedPath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }

  if (stagedRaw !== verifiedStatusRaw) {
    rollbackUnexpectedStagedStatus(statusPath, stagedPath, storage);
    return;
  }

  if (!storage.existsSync(statusPath)) {
    storage.tryExclusiveWriteSync(statusPath, stagedRaw, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  unlinkIfPresent(stagedPath, storage);
}

export function stageVerifiedStatusSnapshot(
  statusPath: string,
  stagedPath: string,
  verifiedStatusRaw: string,
  storage: Pick<Runtime['storage'], 'readFileSync' | 'renameSync' | 'existsSync' | 'unlinkSync'>,
): boolean {
  try {
    storage.renameSync(statusPath, stagedPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return false;
    throw error;
  }

  let stagedRaw: string;
  try {
    stagedRaw = storage.readFileSync(stagedPath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) return false;
    throw error;
  }

  if (stagedRaw === verifiedStatusRaw) return true;

  rollbackUnexpectedStagedStatus(statusPath, stagedPath, storage);
  return false;
}

export function removeAdoptionClaimIfOwner(
  claimPath: string,
  ownerId: string,
  storage: Pick<Runtime['storage'], 'existsSync' | 'readFileSync' | 'renameSync' | 'unlinkSync'>,
): void {
  const stagePath = `${claimPath}.removing.${ownerId}`;

  try {
    storage.renameSync(claimPath, stagePath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return;
    throw error;
  }

  try {
    const raw = storage.readFileSync(stagePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isAdoptionClaimRecord(parsed) || parsed.ownerId !== ownerId) {
      restoreClaimFileIfMissing(stagePath, claimPath, storage);
      return;
    }
    storage.unlinkSync(stagePath);
  } catch (error: unknown) {
    unlinkIfPresent(stagePath, storage);
    if (isNoEntryError(error) || error instanceof SyntaxError) return;
    throw error;
  }
}

function reapStaleAdoptionClaim(
  statusPath: string,
  runtime: Pick<Runtime, 'storage' | 'time' | 'ids'>,
): boolean {
  const claimPath = claimPathForStatus(statusPath);
  const snapshot = readAdoptionClaimSnapshot(claimPath, runtime.storage);
  if (snapshot === null) return true;

  const claimedAt = snapshot.record?.claimedAt ?? snapshot.mtimeMs;
  if (runtime.time.now() - claimedAt < ADOPTION_CLAIM_STALE_MS) {
    return false;
  }

  const reapingPath = `${claimPath}.reaping.${createAdoptionOwnerId(runtime.time.now(), runtime.ids)}`;
  try {
    runtime.storage.renameSync(claimPath, reapingPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) return true;
    throw error;
  }

  try {
    const reapedRaw = runtime.storage.readFileSync(reapingPath, 'utf-8');
    if (reapedRaw !== snapshot.raw) {
      restoreClaimFileIfMissing(reapingPath, claimPath, runtime.storage);
      return false;
    }

    if (snapshot.record !== null) {
      restoreVerifiedStagedStatus(
        statusPath,
        snapshot.record.stagedPath,
        snapshot.record.verifiedStatusRaw,
        runtime.storage,
      );
    }

    runtime.storage.unlinkSync(reapingPath);
    return true;
  } catch (error: unknown) {
    unlinkIfPresent(reapingPath, runtime.storage);
    if (isNoEntryError(error)) return true;
    throw error;
  }
}

export function tryAcquireAdoptionClaim(
  statusPath: string,
  verifiedStatusRaw: string,
  runtime: Pick<Runtime, 'storage' | 'time' | 'ids'>,
): AdoptionClaimRecord | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ownerId = createAdoptionOwnerId(runtime.time.now(), runtime.ids);
    const claimRecord: AdoptionClaimRecord = {
      ownerId,
      claimedAt: runtime.time.now(),
      stagedPath: stagedStatusPath(statusPath, ownerId),
      verifiedStatusRaw,
    };

    const acquired = runtime.storage.tryExclusiveWriteSync(claimPathForStatus(statusPath), JSON.stringify(claimRecord), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    if (acquired) return claimRecord;
    if (!reapStaleAdoptionClaim(statusPath, runtime)) return null;
  }

  return null;
}
