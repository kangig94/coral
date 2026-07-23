import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmSync,
  type BigIntStats,
  type Dir,
  writeSync,
} from 'node:fs';

export type StoreResetInspectionStat = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly mode: bigint;
  readonly kind: 'file' | 'directory' | 'symbolic-link' | 'other';
};

export type StoreResetDirectoryEntry = {
  readonly name: string;
};

export type StoreResetDirectoryCursor = unknown;
export type StoreResetFileDescriptor = unknown;

export interface StoreResetInspectionFs {
  readonly openFlags: {
    readonly readOnly: number;
    readonly createExclusiveWrite: number;
  };
  lstat(path: string): StoreResetInspectionStat | null;
  fstat(descriptor: StoreResetFileDescriptor): StoreResetInspectionStat;
  realpath(path: string): string;
  openDirectory(path: string): StoreResetDirectoryCursor;
  readDirectory(cursor: StoreResetDirectoryCursor): StoreResetDirectoryEntry | null;
  closeDirectory(cursor: StoreResetDirectoryCursor): void;
  open(path: string, flags: number, mode?: number): StoreResetFileDescriptor;
  read(
    descriptor: StoreResetFileDescriptor,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  write(
    descriptor: StoreResetFileDescriptor,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  close(descriptor: StoreResetFileDescriptor): void;
  mkdtemp(prefix: string): string;
  removeTreeGuarded(path: string, expected: StoreResetInspectionStat): boolean;
}

function kindOf(stat: BigIntStats): StoreResetInspectionStat['kind'] {
  if (stat.isSymbolicLink()) return 'symbolic-link';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

function inspectionStat(stat: BigIntStats): StoreResetInspectionStat {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    mode: stat.mode,
    kind: kindOf(stat),
  };
}

function isNoEntryError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function sameIdentity(left: StoreResetInspectionStat, right: StoreResetInspectionStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.mode === right.mode &&
    left.kind === right.kind
  );
}

export function createStoreResetInspectionFs(): StoreResetInspectionFs {
  return {
    openFlags: {
      readOnly: constants.O_RDONLY,
      createExclusiveWrite: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    },
    lstat(path) {
      try {
        return inspectionStat(lstatSync(path, { bigint: true }));
      } catch (error: unknown) {
        if (isNoEntryError(error)) return null;
        throw error;
      }
    },
    fstat(descriptor) {
      return inspectionStat(fstatSync(descriptor as number, { bigint: true }));
    },
    realpath(path) {
      return realpathSync(path);
    },
    openDirectory(path) {
      return opendirSync(path);
    },
    readDirectory(cursor) {
      const entry = (cursor as Dir).readSync();
      return entry === null ? null : { name: entry.name };
    },
    closeDirectory(cursor) {
      (cursor as Dir).closeSync();
    },
    open(path, flags, mode) {
      return openSync(path, flags, mode);
    },
    read(descriptor, buffer, offset, length, position) {
      return readSync(descriptor as number, buffer, offset, length, position);
    },
    write(descriptor, buffer, offset, length, position) {
      return writeSync(descriptor as number, buffer, offset, length, position);
    },
    close(descriptor) {
      closeSync(descriptor as number);
    },
    mkdtemp(prefix) {
      return mkdtempSync(prefix);
    },
    removeTreeGuarded(path, expected) {
      let current: StoreResetInspectionStat | null;
      try {
        current = inspectionStat(lstatSync(path, { bigint: true }));
      } catch (error: unknown) {
        return isNoEntryError(error);
      }
      if (!sameIdentity(current, expected) || current.kind !== 'directory') {
        return false;
      }
      rmSync(path, { recursive: true, force: false });
      try {
        lstatSync(path);
        return false;
      } catch (error: unknown) {
        return isNoEntryError(error);
      }
    },
  };
}
