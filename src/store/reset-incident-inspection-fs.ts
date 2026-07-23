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
