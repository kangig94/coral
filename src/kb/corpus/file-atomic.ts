import { dirname } from 'node:path';
import type { StoragePort } from '../../infra/port-types.js';
import type { IdPort } from '../../runtime/ports.js';

type FileAtomicStorage = Pick<StoragePort, 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'rmSync'>;
type FileAtomicIds = Pick<IdPort, 'uuid'>;

/**
 * The KbRuntime port slice that callers passing `kb` directly satisfy without
 * unpacking. Avoids `{ storage: kb.storagePort, ids: kb.ids }` boilerplate.
 */
export type FileAtomicHost = {
  readonly storagePort: FileAtomicStorage;
  readonly ids: FileAtomicIds;
};

export function writeFileAtomic(
  host: FileAtomicHost,
  filePath: string,
  payload: string,
  options?: { readonly mode?: number },
): void {
  const dir = dirname(filePath);
  host.storagePort.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${host.ids.uuid()}.tmp`;

  try {
    // An explicit mode must apply to the temp file; chmod after rename exposes the destination at its default mode.
    host.storagePort.writeFileSync(tmpPath, payload, {
      encoding: 'utf-8',
      ...(options?.mode === undefined ? {} : { mode: options.mode }),
    });
    host.storagePort.renameSync(tmpPath, filePath);
  } catch (error: unknown) {
    host.storagePort.rmSync(tmpPath, { force: true });
    throw error;
  }
}
