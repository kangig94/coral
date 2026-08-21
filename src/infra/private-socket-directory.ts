import { dirname } from 'node:path';

import type { StorageBigIntStat, StoragePort } from './port-types.js';

const FILE_TYPE_BITS = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const PERMISSION_BITS = 0o777n;
const PRIVATE_DIRECTORY_MODE = 0o700n;
const WRITABLE_BY_OTHERS = 0o022n;
const RESTRICTED_DELETION = 0o1000n;
const ROOT_UID = 0n;

export type SocketDirectoryStorage = Pick<StoragePort, 'chmodSync' | 'mkdirSync'> & {
  lstatSync(path: string, options: { bigint: true }): StorageBigIntStat;
  statSync(path: string, options: { bigint: true }): StorageBigIntStat;
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
  /** The observation alone, for a caller that already names the directory in its own sentence. */
  readonly detail: string | undefined;

  constructor(refusal: SocketDirectoryRefusal, directory: string, uid: number, cause?: unknown) {
    const requirement = `a directory owned by uid ${uid} with mode 0700`;
    // `unsecurable` and `unverified` each cover several observations, and which one it was decides what the
    // operator does next — so it travels in the message rather than as an enumeration a reader downstream
    // has to keep complete.
    const observed = cause instanceof Error ? cause.message : 'unknown cause';
    const reason =
      refusal === 'foreign'
        ? `belongs to another user, so it cannot be ${requirement}`
        : refusal === 'unusable'
          ? `is not ${requirement}`
          : refusal === 'unsecurable'
            ? `cannot be held as ${requirement}: ${observed}`
            : `could not be verified as ${requirement}: ${observed}`;
    super(`Socket directory '${directory}' ${reason}.`, { cause });
    this.name = 'SocketDirectoryError';
    this.refusal = refusal;
    this.directory = directory;
    this.uid = uid;
    this.detail = cause instanceof Error ? cause.message : undefined;
  }
}

type EntryKind = 'unowned' | 'foreign' | 'not-a-directory' | 'loose' | 'private';

function classifyEntry(entry: StorageBigIntStat, uid: number): EntryKind {
  if (entry.uid === undefined) return 'unowned';
  if (entry.uid !== BigInt(uid)) return 'foreign';
  if ((entry.mode & FILE_TYPE_BITS) !== DIRECTORY_TYPE) return 'not-a-directory';
  return (entry.mode & PERMISSION_BITS) === PRIVATE_DIRECTORY_MODE ? 'private' : 'loose';
}

/**
 * Establishes that the parent of a relocated socket is private to `uid`, tightening its mode when the entry
 * is already this uid's and refusing when it is not.
 *
 * Ownership and type of the directory itself come from the non-following `lstat` and from nothing else. A
 * following `stat` describes whatever the entry currently resolves to rather than the entry, so under a
 * shared root it can report a victim-owned directory for an entry an attacker still controls — and the later
 * `bind` follows the same swapped link.
 *
 * That observation only stays true while nobody but this uid can remove or rename the entry behind it, which
 * is a property of the parent and is established rather than assumed — an assumed premise is one nothing
 * fails on when it stops holding. It holds when the parent is writable by nobody else, or when it carries
 * the restricted-deletion bit *and* belongs to this uid or to root: that bit exempts the directory's own
 * owner as well as each entry's, so a sticky parent someone else owns protects nothing from them.
 *
 * The parent is read the other way round, with the following `stat`, because there the question is about a
 * location rather than an object: on a host where `/tmp` is a symlink, the link's own mode says nothing
 * about who may write in the directory it names.
 *
 * The mode is read back after `chmod` for the same reason the premise is checked: a filesystem may accept
 * the call and keep its own permissions, and `chmodSync` promises a return, not a postcondition.
 */
export function ensurePrivateSocketDir(directory: string, uid: number, storage: SocketDirectoryStorage): void {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new SocketDirectoryError('unverified', directory, uid, new Error('the current uid is not a usable owner'));
  }

  const observe = (read: () => StorageBigIntStat): StorageBigIntStat => {
    try {
      return read();
    } catch (error: unknown) {
      throw new SocketDirectoryError('unverified', directory, uid, error);
    }
  };
  // Exhaustive so a new entry kind cannot inherit another one's disposition, and its own observation, by
  // falling through a ternary.
  const REFUSALS = {
    unowned: { refusal: 'unverified', observed: 'the directory reported no owner' },
    foreign: { refusal: 'foreign', observed: undefined },
    'not-a-directory': { refusal: 'unusable', observed: undefined },
  } as const satisfies Record<
    Exclude<EntryKind, 'loose' | 'private'>,
    { refusal: SocketDirectoryRefusal; observed: string | undefined }
  >;
  const refuse = (kind: Exclude<EntryKind, 'loose' | 'private'>): never => {
    const { refusal, observed } = REFUSALS[kind];
    throw new SocketDirectoryError(refusal, directory, uid, observed === undefined ? undefined : new Error(observed));
  };

  const parent = observe(() => storage.statSync(dirname(directory), { bigint: true }));
  if (parent.uid === undefined) {
    throw new SocketDirectoryError('unverified', directory, uid, new Error('the parent reported no owner'));
  }
  const parentIsOurs = parent.uid === BigInt(uid) || parent.uid === ROOT_UID;
  const parentRestrictsDeletion = (parent.mode & RESTRICTED_DELETION) !== 0n;
  if ((parent.mode & WRITABLE_BY_OTHERS) !== 0n && !(parentRestrictsDeletion && parentIsOurs)) {
    const location = `its parent '${dirname(directory)}' is writable by other users`;
    throw new SocketDirectoryError(
      'unsecurable',
      directory,
      uid,
      new Error(
        parentRestrictsDeletion
          ? `${location} and belongs to uid ${parent.uid}, whom its restricted-deletion bit exempts`
          : parentIsOurs
            ? `${location} and does not restrict deletion`
            : `${location}, does not restrict deletion, and belongs to uid ${parent.uid}`,
      ),
    );
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

  const entry = classifyEntry(
    observe(() => storage.lstatSync(directory, { bigint: true })),
    uid,
  );
  if (entry === 'private') return;
  if (entry !== 'loose') refuse(entry);

  const tightened = classifyEntry(
    observe(() => {
      storage.chmodSync(directory, Number(PRIVATE_DIRECTORY_MODE));
      return storage.lstatSync(directory, { bigint: true });
    }),
    uid,
  );
  if (tightened === 'private') return;
  if (tightened === 'loose') {
    throw new SocketDirectoryError(
      'unsecurable',
      directory,
      uid,
      new Error('the filesystem accepted the mode change and kept its own permissions'),
    );
  }
  refuse(tightened);
}
