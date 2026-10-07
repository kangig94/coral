import { createHash } from 'node:crypto';

export function epochIdentity(key: string): string {
  if (!key.startsWith('{')) return key;
  try {
    const value: unknown = JSON.parse(key);
    if (typeof value === 'object' && value !== null && 'lineageKey' in value && typeof value.lineageKey === 'string')
      return value.lineageKey;
  } catch {
    // Unrecognized keys retain their literal identity.
  }
  return key;
}

type EpochIdentity = string | Readonly<{ directory: string }> | null | undefined;

export function sameEpoch(left: EpochIdentity, right: EpochIdentity): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (typeof left === 'object') {
    return left.directory === (typeof right === 'object' ? right.directory : epochHoldDirectory(right));
  }
  if (typeof right === 'object') return epochHoldDirectory(left) === right.directory;
  return epochIdentity(left) === epochIdentity(right);
}

/** Tokens label an accepted epoch in messages; they cannot reconstruct filesystem paths. */
export function epochToken(epochKey: string): string {
  return createHash('sha256').update(epochIdentity(epochKey)).digest().subarray(0, 16).toString('hex');
}

/** Released hold directories hash the full stored key, rather than its lineage. */
export function epochHoldDirectory(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function addressFields(key: string | undefined): { storeRoot?: unknown; epoch?: unknown; lineageKey?: unknown } | null {
  if (!key?.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(key);
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}

/** A hold recorded before an address's lineage was readable names the epoch at that store root and number. */
export function sameEpochOrFallbackAddress(holdKey: string | undefined, epochKey: string): boolean {
  if (sameEpoch(holdKey, epochKey)) return true;
  const hold = addressFields(holdKey);
  const epoch = addressFields(epochKey);
  return (
    hold !== null &&
    epoch !== null &&
    hold.lineageKey === undefined &&
    typeof hold.storeRoot === 'string' &&
    hold.storeRoot === epoch.storeRoot &&
    typeof hold.epoch === 'string' &&
    hold.epoch === epoch.epoch
  );
}
