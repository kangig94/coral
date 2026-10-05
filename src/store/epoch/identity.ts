import { createHash } from 'node:crypto';

function epochIdentity(key: string): string {
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

/** Released hold directories hash the full stored key, rather than its lineage. */
export function epochHoldDirectory(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
