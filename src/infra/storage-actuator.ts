import type { StorageData } from './port-types.js';

declare const STORAGE_ACTUATOR_BRAND: unique symbol;

export type StorageActuator = Readonly<{
  readonly [STORAGE_ACTUATOR_BRAND]: true;
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
