import type { StorageData, StoragePort } from './port-types.js';

export type StorageActuator = Readonly<{
  readWholeFile(path: string, encoding: 'utf-8'): string;
  readWholeFileAsync(path: string, encoding: 'utf-8'): Promise<string>;
  writeWholeFile(
    path: string,
    data: StorageData,
    options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
  ): void;
  rename(oldPath: string, newPath: string): void;
  link(existingPath: string, newPath: string): void;
  makeDirectory(path: string, options?: { recursive?: boolean; mode?: number }): void;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  createFile(path: string, flags: string, mode?: number): number;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  write(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  syncFile(fd: number): void;
  appendWholeFile(path: string, data: string): void;
  appendWholeFileDurable(path: string, data: string): boolean;
  appendWholeFileCanonical(
    path: string,
    data: string,
    options: { canonicalPath: string; maxRetries?: number },
  ): { ok: boolean; retries: number; orphanPath?: string };
  removeDirectory(path: string): void;
  unlink(path: string): void;
  tryCreateWholeFile(path: string, data: StorageData, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  writeWholeFileAtomic(
    path: string,
    data: StorageData,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): boolean;
  writeWholeFileDurable(
    path: string,
    data: StorageData,
    options?: { encoding?: BufferEncoding; mode?: number },
  ): boolean;
  syncDirectory(path: string): boolean;
  setMode(path: string, mode: number): void;
}>;

export function createStorageActuator(storage: StoragePort, prove: () => void): StorageActuator {
  return {
    readWholeFile(path, encoding) {
      prove();
      return storage.readFileSync(path, encoding);
    },
    readWholeFileAsync(path, encoding) {
      prove();
      return storage.readFile(path, encoding);
    },
    writeWholeFile(path, data, options) {
      prove();
      storage.writeFileSync(path, data, options);
    },
    rename(oldPath, newPath) {
      prove();
      storage.renameSync(oldPath, newPath);
    },
    link(existingPath, newPath) {
      prove();
      storage.linkSync(existingPath, newPath);
    },
    makeDirectory(path, options) {
      prove();
      storage.mkdirSync(path, options);
    },
    remove(path, options) {
      prove();
      storage.rmSync(path, options);
    },
    createFile(path, flags, mode) {
      prove();
      return storage.openSync(path, flags, mode);
    },
    read(fd, buffer, offset, length, position) {
      prove();
      return storage.readSync(fd, buffer, offset, length, position);
    },
    write(fd, buffer, offset, length, position) {
      prove();
      return storage.writeSync(fd, buffer, offset, length, position);
    },
    syncFile(fd) {
      prove();
      storage.fdatasyncSync(fd);
    },
    appendWholeFile(path, data) {
      prove();
      storage.appendFileSync(path, data);
    },
    appendWholeFileDurable(path, data) {
      prove();
      return storage.appendFileDurableSync(path, data);
    },
    appendWholeFileCanonical(path, data, options) {
      prove();
      return storage.appendFileWithCanonicalCheckSync(path, data, options);
    },
    removeDirectory(path) {
      prove();
      storage.rmdirSync(path);
    },
    unlink(path) {
      prove();
      storage.unlinkSync(path);
    },
    tryCreateWholeFile(path, data, options) {
      prove();
      return storage.tryExclusiveWriteSync(path, data, options);
    },
    writeWholeFileAtomic(path, data, options) {
      prove();
      return storage.writeAtomicSync(path, data, options);
    },
    writeWholeFileDurable(path, data, options) {
      prove();
      return storage.writeAtomicDurableSync(path, data, options);
    },
    syncDirectory(path) {
      prove();
      return storage.syncDirectoryDurableSync(path);
    },
    setMode(path, mode) {
      prove();
      storage.chmodSync(path, mode);
    },
  };
}
