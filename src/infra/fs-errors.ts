import { unlinkSync } from 'node:fs';

type StorageUnlinkPort = {
  unlinkSync(path: string): void;
};

export function isNoEntryError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function unlinkIfExists(filePath: string, storage?: StorageUnlinkPort): void {
  try {
    if (storage) {
      storage.unlinkSync(filePath);
    } else {
      unlinkSync(filePath);
    }
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return;
    }
    throw error;
  }
}
