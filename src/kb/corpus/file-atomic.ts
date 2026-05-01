import { dirname } from 'node:path';
import type { IdPort, StoragePort } from '../../runtime/ports.js';

export type FileAtomicStorage = Pick<StoragePort, 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'rmSync'>;
export type FileAtomicIds = Pick<IdPort, 'uuid'>;

/**
 * The KbRuntime port slice that callers passing `kb` directly satisfy without
 * unpacking. Avoids `{ storage: kb.storagePort, ids: kb.ids }` boilerplate.
 */
export type FileAtomicHost = {
  readonly storagePort: FileAtomicStorage;
  readonly ids: FileAtomicIds;
};

export function writeFileAtomic(host: FileAtomicHost, filePath: string, payload: string): void {
  const dir = dirname(filePath);
  host.storagePort.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${host.ids.uuid()}.tmp`;

  try {
    host.storagePort.writeFileSync(tmpPath, payload, { encoding: 'utf-8' });
    host.storagePort.renameSync(tmpPath, filePath);
  } catch (error: unknown) {
    host.storagePort.rmSync(tmpPath, { force: true });
    throw error;
  }
}
