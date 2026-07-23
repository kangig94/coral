import type {
  StoreResetDirectoryCursor,
  StoreResetFileDescriptor,
  StoreResetInspectionFs,
  StoreResetInspectionStat,
} from '#src/store/reset-incident-inspection-fs.js';

export type StoreResetInspectionFaultScript = {
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
  readonly zeroReadCall?: number;
  readonly zeroWriteCall?: number;
  readonly failFileClose?: boolean;
  readonly failDirectoryClose?: boolean;
  readonly lstat?: (
    path: string,
    call: number,
    current: StoreResetInspectionStat | null,
  ) => StoreResetInspectionStat | null;
};

export function scriptedStoreResetInspectionFs(
  base: StoreResetInspectionFs,
  script: StoreResetInspectionFaultScript,
): StoreResetInspectionFs {
  let readCalls = 0;
  let writeCalls = 0;
  let lstatCalls = 0;
  return {
    openFlags: base.openFlags,
    lstat(path) {
      lstatCalls += 1;
      const current = base.lstat(path);
      return script.lstat === undefined ? current : script.lstat(path, lstatCalls, current);
    },
    fstat(descriptor) {
      return base.fstat(descriptor);
    },
    realpath(path) {
      return base.realpath(path);
    },
    openDirectory(path) {
      return base.openDirectory(path);
    },
    readDirectory(cursor) {
      return base.readDirectory(cursor);
    },
    closeDirectory(cursor: StoreResetDirectoryCursor) {
      base.closeDirectory(cursor);
      if (script.failDirectoryClose) throw new Error('scripted directory close failure');
    },
    open(path, flags, mode) {
      return base.open(path, flags, mode);
    },
    read(descriptor: StoreResetFileDescriptor, buffer, offset, length, position) {
      readCalls += 1;
      if (script.zeroReadCall === readCalls) return 0;
      return base.read(descriptor, buffer, offset, Math.min(length, script.maxReadBytes ?? length), position);
    },
    write(descriptor: StoreResetFileDescriptor, buffer, offset, length, position) {
      writeCalls += 1;
      if (script.zeroWriteCall === writeCalls) return 0;
      return base.write(descriptor, buffer, offset, Math.min(length, script.maxWriteBytes ?? length), position);
    },
    close(descriptor: StoreResetFileDescriptor) {
      base.close(descriptor);
      if (script.failFileClose) throw new Error('scripted file close failure');
    },
    mkdtemp(prefix) {
      return base.mkdtemp(prefix);
    },
    removeTreeGuarded(path, expected) {
      return base.removeTreeGuarded(path, expected);
    },
  };
}
