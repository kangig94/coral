import { dirname } from 'node:path';

import type { StoragePort } from '../../runtime/ports.js';

/** Persisted install metadata for the needle engine: `{version, method}` JSON. */
export type InstallMeta = {
  version: string;
  method: string;
};

/** Read install metadata from the first candidate path that parses successfully. */
export function readInstallMeta(
  storage: Pick<StoragePort, 'readFileSync'>,
  candidates: readonly string[],
): InstallMeta | null {
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(storage.readFileSync(path, 'utf-8')) as Partial<InstallMeta>;
      if (typeof parsed.version === 'string' && typeof parsed.method === 'string') {
        return {
          version: parsed.version,
          method: parsed.method,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/** Atomically write install metadata, creating the parent directory if missing. */
export function writeInstallMeta(
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  filePath: string,
  value: InstallMeta,
): void {
  storage.mkdirSync(dirname(filePath), { recursive: true });
  if (!storage.writeAtomicSync(filePath, JSON.stringify(value), { encoding: 'utf-8' })) {
    throw new Error(`Atomic write failed: ${filePath}`);
  }
}
