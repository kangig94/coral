import { dirname, resolve } from 'node:path';

import type { StorageBigIntStat, StoragePort } from './port-types.js';

const FILE_TYPE_BITS = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const PERMISSION_BITS = 0o7777n;
const REQUIRED_POSIX_MODE = 0o700n;
const WRITABLE_BY_OTHERS = 0o022n;
const RESTRICTED_DELETION = 0o1000n;
const ROOT_UID = 0n;
const MAX_FILESYSTEM_UID = 0xffff_fffe;
const NO_STORAGE_OBSERVATION = 'the storage adapter threw without an observation';

export type SocketDirectoryStorage = Pick<StoragePort, 'chmodSync' | 'mkdirSync'> & {
  lstatSync(path: string, options: { bigint: true }): StorageBigIntStat;
  statSync(path: string, options: { bigint: true }): StorageBigIntStat;
};

export type SocketDirectoryRefusal = 'foreign' | 'unusable' | 'unsecurable' | 'unverified';

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function thrownDetail(value: unknown): string {
  if (value instanceof Error) {
    return nonEmptyText(value.message) ?? nonEmptyText((value as NodeJS.ErrnoException).code) ?? NO_STORAGE_OBSERVATION;
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const error = value as { readonly code?: unknown; readonly message?: unknown };
    return nonEmptyText(error.code) ?? nonEmptyText(error.message) ?? NO_STORAGE_OBSERVATION;
  }

  switch (typeof value) {
    case 'string':
      return nonEmptyText(value) ?? NO_STORAGE_OBSERVATION;
    case 'number':
    case 'bigint':
    case 'boolean':
    case 'symbol':
      return String(value);
    default:
      return NO_STORAGE_OBSERVATION;
  }
}

export class SocketDirectoryError extends Error {
  readonly refusal: SocketDirectoryRefusal;
  readonly directory: string;
  readonly uid: number;
  readonly detail: string | undefined;

  constructor(refusal: SocketDirectoryRefusal, directory: string, uid: number, ...causes: [] | [unknown]) {
    const requirement = `a directory owned by uid ${uid} with mode 0700`;
    const causeWasProvided = causes.length === 1;
    const cause = causes[0];
    const detail = causeWasProvided ? thrownDetail(cause) : undefined;
    const observed = detail ?? 'unknown cause';
    const reason =
      refusal === 'foreign'
        ? `belongs to another user, so it cannot be ${requirement}`
        : refusal === 'unusable'
          ? `is not ${requirement}`
          : refusal === 'unsecurable'
            ? `cannot be held as ${requirement}: ${observed}`
            : `could not be verified as ${requirement}: ${observed}`;
    super(`Socket directory '${directory}' ${reason}.`, causeWasProvided ? { cause } : undefined);
    this.name = 'SocketDirectoryError';
    this.refusal = refusal;
    this.directory = directory;
    this.uid = uid;
    this.detail = detail;
  }
}

type EntryKind = 'unowned' | 'foreign' | 'not-a-directory' | 'loose' | 'matching-posix-owner-and-mode';

const ENTRY_REFUSALS = {
  unowned: { refusal: 'unverified', observed: 'the directory reported no owner' },
  foreign: { refusal: 'foreign', observed: undefined },
  'not-a-directory': { refusal: 'unusable', observed: undefined },
} as const satisfies Record<
  Exclude<EntryKind, 'loose' | 'matching-posix-owner-and-mode'>,
  { refusal: SocketDirectoryRefusal; observed: string | undefined }
>;

function classifyEntry(entry: StorageBigIntStat, uid: number): EntryKind {
  if (entry.uid !== undefined && entry.uid !== BigInt(uid)) return 'foreign';
  if ((entry.mode & FILE_TYPE_BITS) !== DIRECTORY_TYPE) return 'not-a-directory';
  if (entry.uid === undefined) return 'unowned';
  return (entry.mode & PERMISSION_BITS) === REQUIRED_POSIX_MODE ? 'matching-posix-owner-and-mode' : 'loose';
}

function observe(directory: string, uid: number, read: () => StorageBigIntStat): StorageBigIntStat {
  try {
    return read();
  } catch (error: unknown) {
    throw new SocketDirectoryError('unverified', directory, uid, error);
  }
}

type OperationResult = { readonly failed: false } | { readonly failed: true; readonly error: unknown };

function attempt(operation: () => void): OperationResult {
  try {
    operation();
    return { failed: false };
  } catch (error: unknown) {
    return { failed: true, error };
  }
}

function refuseEntry(
  kind: Exclude<EntryKind, 'loose' | 'matching-posix-owner-and-mode'>,
  directory: string,
  uid: number,
): never {
  const { refusal, observed } = ENTRY_REFUSALS[kind];
  if (observed === undefined) throw new SocketDirectoryError(refusal, directory, uid);
  throw new SocketDirectoryError(refusal, directory, uid, new Error(observed));
}

function assertSecureParent(directory: string, uid: number, parent: StorageBigIntStat): void {
  const parentPath = dirname(directory);
  if (parent.uid !== undefined && parent.uid !== BigInt(uid) && parent.uid !== ROOT_UID) {
    throw new SocketDirectoryError(
      'unsecurable',
      directory,
      uid,
      new Error(`its parent '${parentPath}' belongs to uid ${parent.uid} rather than uid ${uid} or root`),
    );
  }

  if ((parent.mode & FILE_TYPE_BITS) !== DIRECTORY_TYPE) {
    throw new SocketDirectoryError(
      'unsecurable',
      directory,
      uid,
      new Error(`its parent '${parentPath}' is not a directory`),
    );
  }

  if (parent.uid === undefined) {
    throw new SocketDirectoryError(
      'unverified',
      directory,
      uid,
      new Error(`its parent '${parentPath}' reported no owner`),
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
 * Its enclosing directory must be read the following way round, because `/tmp` is a symlink on macOS and a
 * link's own mode says nothing about who may write where it points.
 *
 * `chmod` succeeding is not the mode being set — a CIFS mount without unix extensions accepts the call and
 * keeps its own permissions — so the result is read back.
 */
export function ensurePrivateSocketDir(target: string, uid: number, storage: SocketDirectoryStorage): void {
  // A trailing separator makes `lstat` follow a symlink, so the non-following read below is only
  // non-following on a canonical path.
  const directory = resolve(target);
  if (!Number.isSafeInteger(uid) || uid < 0 || uid > MAX_FILESYSTEM_UID) {
    throw new SocketDirectoryError(
      'unverified',
      directory,
      uid,
      new Error('the owner uid named by the socket address is not usable'),
    );
  }

  const parent = observe(directory, uid, () => storage.statSync(dirname(directory), { bigint: true }));
  assertSecureParent(directory, uid, parent);

  // A create that fails is never the last word while the entry can still be read: an occupied path fails
  // `EEXIST`, a dangling link at the same position fails `ENOENT`, and both are entries the read below
  // names. Only a path the read cannot reach either leaves this having observed nothing.
  const creation = attempt(() => storage.mkdirSync(directory, { recursive: true, mode: Number(REQUIRED_POSIX_MODE) }));

  let observed: StorageBigIntStat;
  try {
    observed = storage.lstatSync(directory, { bigint: true });
  } catch (error: unknown) {
    throw new SocketDirectoryError('unverified', directory, uid, creation.failed ? creation.error : error);
  }

  const entry = classifyEntry(observed, uid);
  if (entry === 'matching-posix-owner-and-mode') return;
  if (entry !== 'loose') refuseEntry(entry, directory, uid);

  const tightening = attempt(() => storage.chmodSync(directory, Number(REQUIRED_POSIX_MODE)));
  let tightenedObservation: StorageBigIntStat;
  try {
    tightenedObservation = storage.lstatSync(directory, { bigint: true });
  } catch (error: unknown) {
    throw new SocketDirectoryError('unverified', directory, uid, tightening.failed ? tightening.error : error);
  }

  const tightened = classifyEntry(tightenedObservation, uid);
  if (tightened === 'matching-posix-owner-and-mode') return;
  if (tightened === 'loose') {
    const operation = tightening.failed
      ? `the mode change failed (${thrownDetail(tightening.error)}) and`
      : 'the filesystem accepted the mode change and kept its own permissions;';
    throw new SocketDirectoryError(
      'unsecurable',
      directory,
      uid,
      new Error(`${operation} the directory still reported mode 0${tightenedObservation.mode.toString(8)}`),
    );
  }
  refuseEntry(tightened, directory, uid);
}
