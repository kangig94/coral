import { dirname } from 'node:path';

import type { StorageBigIntStat, StoragePort } from './port-types.js';

const FILE_TYPE_BITS = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const PERMISSION_BITS = 0o777n;
const PRIVATE_DIRECTORY_MODE = 0o700n;
const WORLD_WRITABLE = 0o002n;
const RESTRICTED_DELETION = 0o1000n;

export type SocketDirectoryStorage = Pick<StoragePort, 'chmodSync' | 'mkdirSync'> & {
  lstatSync(path: string, options: { bigint: true }): StorageBigIntStat;
};

/**
 * Four answers, and the operator's next step differs for each: `foreign` needs that owner or an
 * administrator, `unusable` needs the caller to clear their own entry, `unsecurable` cannot be resolved at
 * this path at all, and `unverified` decided nothing and must not be reported as though it had — an operator
 * told their permissions are wrong will go and change permissions.
 */
export type SocketDirectoryRefusal = 'foreign' | 'unusable' | 'unsecurable' | 'unverified';

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
          : refusal === 'unsecurable'
            ? `cannot be held as ${requirement}`
            : `could not be verified as ${requirement}: ${cause instanceof Error ? cause.message : 'unknown cause'}`;
    super(`Socket directory '${directory}' ${reason}.`, { cause });
    this.name = 'SocketDirectoryError';
    this.refusal = refusal;
    this.directory = directory;
    this.uid = uid;
  }
}

function observe(directory: string, uid: number, path: string, storage: SocketDirectoryStorage): StorageBigIntStat {
  try {
    return storage.lstatSync(path, { bigint: true });
  } catch (error: unknown) {
    throw new SocketDirectoryError('unverified', directory, uid, error);
  }
}

/**
 * Establishes that the parent of a relocated socket is private to `uid`, tightening its mode when the entry
 * is already this uid's and refusing when it is not.
 *
 * Ownership and type come from the non-following `lstat` and from nothing else. A following `stat` describes
 * whatever the entry currently resolves to rather than the entry itself, so under a shared root it can report
 * a victim-owned directory for an entry an attacker still controls — and the later `bind` follows the same
 * swapped link.
 *
 * That observation only stays true while nobody else can replace the entry behind it, which is a property of
 * the *parent*: a world-writable parent without the restricted-deletion bit lets any user rename ours away.
 * The check is here rather than assumed, because an assumed premise is one nothing fails on when it stops
 * holding. For the same reason the mode is read back after `chmod`: a filesystem may accept the call and
 * keep its own permissions, and `chmodSync` promises a return, not a postcondition.
 */
export function ensurePrivateSocketDir(directory: string, uid: number, storage: SocketDirectoryStorage): void {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new SocketDirectoryError('unverified', directory, uid, new Error('The current uid is not a usable owner.'));
  }

  const parent = observe(directory, uid, dirname(directory), storage);
  if ((parent.mode & WORLD_WRITABLE) !== 0n && (parent.mode & RESTRICTED_DELETION) === 0n) {
    throw new SocketDirectoryError('unsecurable', directory, uid);
  }

  try {
    storage.mkdirSync(directory, { recursive: true, mode: Number(PRIVATE_DIRECTORY_MODE) });
  } catch (error: unknown) {
    // Something already occupies the path, which the observation below can name; every other create failure
    // leaves this with nothing observed.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new SocketDirectoryError('unverified', directory, uid, error);
    }
  }

  const entry = observe(directory, uid, directory, storage);
  if (entry.uid === undefined) {
    throw new SocketDirectoryError('unverified', directory, uid, new Error('The directory reported no owner.'));
  }
  if (entry.uid !== BigInt(uid)) {
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

  const tightened = observe(directory, uid, directory, storage);
  if (
    tightened.uid !== BigInt(uid) ||
    (tightened.mode & FILE_TYPE_BITS) !== DIRECTORY_TYPE ||
    (tightened.mode & PERMISSION_BITS) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new SocketDirectoryError('unsecurable', directory, uid);
  }
}
