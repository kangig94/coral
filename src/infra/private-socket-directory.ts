import type { StorageBigIntStat, StoragePort } from './port-types.js';

const FILE_TYPE_BITS = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const PERMISSION_BITS = 0o777n;
const PRIVATE_DIRECTORY_MODE = 0o700n;

export type SocketDirectoryStorage = Pick<StoragePort, 'chmodSync' | 'mkdirSync'> & {
  lstatSync(path: string, options: { bigint: true }): StorageBigIntStat;
};

/**
 * `foreign` is a decided observation: this directory is not ours and never will be without an owner acting.
 * `unverified` decided nothing, and must not be reported as though it had — an operator told their
 * permissions are wrong will go and change permissions.
 */
export type SocketDirectoryRefusal = 'foreign' | 'unverified';

export class SocketDirectoryError extends Error {
  readonly refusal: SocketDirectoryRefusal;
  readonly directory: string;
  readonly uid: number;

  constructor(refusal: SocketDirectoryRefusal, directory: string, uid: number, cause?: unknown) {
    const requirement = `a directory owned by uid ${uid} with mode 0700`;
    const reason =
      refusal === 'foreign'
        ? `is not ${requirement}`
        : `could not be verified as ${requirement}: ${cause instanceof Error ? cause.message : 'unknown cause'}`;
    super(`Socket directory '${directory}' ${reason}.`, { cause });
    this.name = 'SocketDirectoryError';
    this.refusal = refusal;
    this.directory = directory;
    this.uid = uid;
  }
}

function requirePrivateEntry(entry: StorageBigIntStat, uid: number, directory: string): boolean {
  if ((entry.mode & FILE_TYPE_BITS) !== DIRECTORY_TYPE || entry.uid === undefined || entry.uid !== BigInt(uid)) {
    throw new SocketDirectoryError('foreign', directory, uid);
  }
  return (entry.mode & PERMISSION_BITS) === PRIVATE_DIRECTORY_MODE;
}

/**
 * Establishes that the parent of a relocated socket is private to `uid`, tightening its mode when it is ours
 * and refusing when it is not.
 *
 * Ownership and type come from the non-following `lstat` and from nothing else. A following `stat` describes
 * whatever the entry currently resolves to rather than the entry itself, so under a world-writable root it can
 * report a victim-owned directory for an entry the attacker still controls — and the later `bind` follows the
 * same swapped link. Once the entry itself is ours, a sticky root leaves no one else able to replace it.
 *
 * A recursive create does not tighten a directory that already exists, so an existing one carries whatever
 * mode its creator's umask gave it until this repairs it.
 */
export function ensurePrivateSocketDir(directory: string, uid: number, storage: SocketDirectoryStorage): void {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new SocketDirectoryError('unverified', directory, uid, new Error('The current uid is not a usable owner.'));
  }

  let entry: StorageBigIntStat;
  try {
    storage.mkdirSync(directory, { recursive: true, mode: Number(PRIVATE_DIRECTORY_MODE) });
    entry = storage.lstatSync(directory, { bigint: true });
  } catch (error: unknown) {
    throw new SocketDirectoryError('unverified', directory, uid, error);
  }
  if (requirePrivateEntry(entry, uid, directory)) return;

  let repaired: StorageBigIntStat;
  try {
    storage.chmodSync(directory, Number(PRIVATE_DIRECTORY_MODE));
    repaired = storage.lstatSync(directory, { bigint: true });
  } catch (error: unknown) {
    throw new SocketDirectoryError('unverified', directory, uid, error);
  }
  if (!requirePrivateEntry(repaired, uid, directory)) {
    throw new SocketDirectoryError('foreign', directory, uid);
  }
}
