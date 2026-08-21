import type { StorageBigIntStat, StoragePort } from './port-types.js';

const FILE_TYPE_BITS = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const PERMISSION_BITS = 0o777n;
const PRIVATE_DIRECTORY_MODE = 0o700n;

export type SocketDirectoryStorage = Pick<StoragePort, 'chmodSync' | 'mkdirSync'> & {
  lstatSync(path: string, options: { bigint: true }): StorageBigIntStat;
};

/**
 * Three answers, and the operator's next step differs for each: `foreign` needs that owner or root,
 * `unusable` needs the caller to clear their own path, and `unverified` decided nothing at all and must
 * not be reported as though it had — an operator told their permissions are wrong will go and change
 * permissions.
 */
export type SocketDirectoryRefusal = 'foreign' | 'unusable' | 'unverified';

export class SocketDirectoryError extends Error {
  readonly refusal: SocketDirectoryRefusal;
  readonly directory: string;
  readonly uid: number;

  constructor(refusal: SocketDirectoryRefusal, directory: string, uid: number, cause?: unknown) {
    const requirement = `a directory owned by uid ${uid} with mode 0700`;
    const reason =
      refusal === 'foreign'
        ? `belongs to another user, so it cannot be ${requirement}`
        : refusal === 'unusable'
          ? `is not ${requirement}`
          : `could not be verified as ${requirement}: ${cause instanceof Error ? cause.message : 'unknown cause'}`;
    super(`Socket directory '${directory}' ${reason}.`, { cause });
    this.name = 'SocketDirectoryError';
    this.refusal = refusal;
    this.directory = directory;
    this.uid = uid;
  }
}

/**
 * Establishes that the parent of a relocated socket is private to `uid`, tightening its mode when the entry
 * is already this uid's and refusing when it is not.
 *
 * Ownership and type come from the non-following `lstat` and from nothing else. A following `stat` describes
 * whatever the entry currently resolves to rather than the entry itself, so under a world-writable root it
 * can report a victim-owned directory for an entry an attacker still controls — and the later `bind` follows
 * the same swapped link. Once the entry itself is this uid's, the sticky bit on that shared root leaves no
 * other user able to replace it, which is what makes the subsequent `chmod` land on the object just observed.
 *
 * A recursive create does not tighten a directory that already exists, so an existing one carries whatever
 * mode its creator's umask gave it until this repairs it.
 */
export function ensurePrivateSocketDir(directory: string, uid: number, storage: SocketDirectoryStorage): void {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new SocketDirectoryError('unverified', directory, uid, new Error('The current uid is not a usable owner.'));
  }

  try {
    storage.mkdirSync(directory, { recursive: true, mode: Number(PRIVATE_DIRECTORY_MODE) });
  } catch (error: unknown) {
    // Something already occupies the path, which the `lstat` below can name; every other create failure
    // leaves this with nothing observed.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new SocketDirectoryError('unverified', directory, uid, error);
    }
  }

  let entry: StorageBigIntStat;
  try {
    entry = storage.lstatSync(directory, { bigint: true });
  } catch (error: unknown) {
    throw new SocketDirectoryError('unverified', directory, uid, error);
  }

  if (entry.uid === undefined || entry.uid !== BigInt(uid)) {
    throw new SocketDirectoryError('foreign', directory, uid);
  }
  if ((entry.mode & FILE_TYPE_BITS) !== DIRECTORY_TYPE) {
    throw new SocketDirectoryError('unusable', directory, uid);
  }
  if ((entry.mode & PERMISSION_BITS) === PRIVATE_DIRECTORY_MODE) return;

  try {
    storage.chmodSync(directory, Number(PRIVATE_DIRECTORY_MODE));
  } catch (error: unknown) {
    throw new SocketDirectoryError('unverified', directory, uid, error);
  }
}
