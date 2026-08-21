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

/** `unverified` decided nothing: an operator told their permissions are wrong will go and change them. */
export type SocketDirectoryRefusal = 'foreign' | 'unusable' | 'unsecurable' | 'unverified';

export class SocketDirectoryError extends Error {
  readonly refusal: SocketDirectoryRefusal;
  readonly directory: string;
  readonly uid: number;
  /** The observation alone, for a caller that already names the directory in its own sentence. */
  readonly detail: string | undefined;

  constructor(refusal: SocketDirectoryRefusal, directory: string, uid: number, cause?: unknown) {
    const requirement = `a directory owned by uid ${uid} with mode 0700`;
    // One refusal covers several observations, and no reader downstream may be left to enumerate them.
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

const ENTRY_REFUSALS = {
  unowned: { refusal: 'unverified', observed: 'the directory reported no owner' },
  foreign: { refusal: 'foreign', observed: undefined },
  'not-a-directory': { refusal: 'unusable', observed: undefined },
} as const satisfies Record<
  Exclude<EntryKind, 'loose' | 'private'>,
  { refusal: SocketDirectoryRefusal; observed: string | undefined }
>;

function classifyEntry(entry: StorageBigIntStat, uid: number): EntryKind {
  if (entry.uid === undefined) return 'unowned';
  if (entry.uid !== BigInt(uid)) return 'foreign';
  if ((entry.mode & FILE_TYPE_BITS) !== DIRECTORY_TYPE) return 'not-a-directory';
  return (entry.mode & PERMISSION_BITS) === PRIVATE_DIRECTORY_MODE ? 'private' : 'loose';
}

function observe(directory: string, uid: number, read: () => StorageBigIntStat): StorageBigIntStat {
  try {
    return read();
  } catch (error: unknown) {
    throw new SocketDirectoryError('unverified', directory, uid, error);
  }
}

function refuseEntry(kind: Exclude<EntryKind, 'loose' | 'private'>, directory: string, uid: number): never {
  const { refusal, observed } = ENTRY_REFUSALS[kind];
  throw new SocketDirectoryError(refusal, directory, uid, observed === undefined ? undefined : new Error(observed));
}

function assertSecureParent(directory: string, uid: number, parent: StorageBigIntStat): void {
  if (parent.uid === undefined) {
    throw new SocketDirectoryError('unverified', directory, uid, new Error('the parent reported no owner'));
  }

  const parentPath = dirname(directory);
  const parentIsTrusted = parent.uid === BigInt(uid) || parent.uid === ROOT_UID;
  if (!parentIsTrusted) {
    throw new SocketDirectoryError(
      'unsecurable',
      directory,
      uid,
      new Error(`its parent '${parentPath}' belongs to uid ${parent.uid} rather than uid ${uid} or root`),
    );
  }

  const parentRestrictsDeletion = (parent.mode & RESTRICTED_DELETION) !== 0n;
  if ((parent.mode & WRITABLE_BY_OTHERS) !== 0n && !parentRestrictsDeletion) {
    throw new SocketDirectoryError(
      'unsecurable',
      directory,
      uid,
      new Error(`its parent '${parentPath}' is writable by other users and does not restrict deletion`),
    );
  }
}

/**
 * The entry's own owner and type must come from a non-following read: a following one describes whatever
 * the path resolves to, and `bind` resolves it again afterwards.
 *
 * Its enclosing directory must be read the following way round, because `/tmp` is a symlink on macOS and a
 * link's own mode says nothing about who may write where it points.
 *
 * `chmod` succeeding is not the mode being set — a CIFS mount without unix extensions accepts the call and
 * keeps its own permissions — so the result is read back.
 */
export function ensurePrivateSocketDir(directory: string, uid: number, storage: SocketDirectoryStorage): void {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new SocketDirectoryError('unverified', directory, uid, new Error('the current uid is not a usable owner'));
  }

  const parent = observe(directory, uid, () => storage.statSync(dirname(directory), { bigint: true }));
  assertSecureParent(directory, uid, parent);

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
    observe(directory, uid, () => storage.lstatSync(directory, { bigint: true })),
    uid,
  );
  if (entry === 'private') return;
  if (entry !== 'loose') refuseEntry(entry, directory, uid);

  const tightened = classifyEntry(
    observe(directory, uid, () => {
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
  refuseEntry(tightened, directory, uid);
}
