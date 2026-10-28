import { dirname } from 'node:path';
import type { JobTerminal } from '../records.js';
import type { EventsRow } from '../../store/schema.js';
import type { StoragePort } from '../../infra/port-types.js';

export type DecodedResultArtifact = {
  accepted: EventsRow;
  terminal: JobTerminal;
  markdown: string | null;
  age: number | 'unknown' | 'regression';
};

export class ResultArtifactPublicationError extends Error {}

type DurabilityStorage = Pick<
  StoragePort,
  'openSync' | 'fstatSync' | 'fdatasyncSync' | 'syncDirectoryDurableSync' | 'closeSync'
>;

/** Every directory whose entry names a result artifact, up to the exports root that names the jobs root. */
function namingDirectories(resultPath: string, jobsRoot: string): string[] {
  const boundary = dirname(jobsRoot);
  const directories: string[] = [];
  for (let directory = dirname(resultPath); ; directory = dirname(directory)) {
    directories.push(directory);
    if (directory === boundary || directory === dirname(directory)) return directories;
  }
}

const provenArtifacts = new WeakMap<DurabilityStorage, Map<string, string>>();

/**
 * Forces one nonempty result artifact and every directory naming it to stable storage. Forced durability is not lost
 * while the file keeps its inode and change time, so a proof is remembered only under a stamp carrying both.
 */
export function proveResultArtifactDurable(storage: DurabilityStorage, resultPath: string, jobsRoot: string): boolean {
  let proven = provenArtifacts.get(storage);
  if (proven === undefined) provenArtifacts.set(storage, (proven = new Map()));
  const remembered = proven.get(resultPath);
  proven.delete(resultPath);
  const fd = storage.openSync(resultPath, 'r');
  try {
    const file = storage.fstatSync(fd, { bigint: true });
    if (!file.isFile() || file.size === 0n) return false;
    const stamp =
      file.ctimeNs === undefined
        ? null
        : [jobsRoot, file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join('\0');
    if (stamp === null || stamp !== remembered) {
      storage.fdatasyncSync(fd);
      if (!namingDirectories(resultPath, jobsRoot).every((directory) => storage.syncDirectoryDurableSync(directory)))
        return false;
    }
    if (stamp !== null) proven.set(resultPath, stamp);
    return true;
  } finally {
    storage.closeSync(fd);
  }
}

export function writeResultArtifact(
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicDurableSync' | 'syncDirectoryDurableSync'>,
  targetPath: string,
  markdown: string,
  beforeRename: () => boolean,
  jobsRoot: string,
): void {
  if (!markdown || !beforeRename()) return;
  storage.mkdirSync(dirname(targetPath), { recursive: true });
  let refused = false;
  const decideRename = (): boolean => {
    refused = !beforeRename();
    return !refused;
  };
  if (!storage.writeAtomicDurableSync(targetPath, markdown, { encoding: 'utf-8', beforeRename: decideRename })) {
    if (refused) return;
    throw new ResultArtifactPublicationError(`Failed to write result artifact: ${targetPath}`);
  }
  for (const directory of namingDirectories(targetPath, jobsRoot)) {
    if (!storage.syncDirectoryDurableSync(directory))
      throw new ResultArtifactPublicationError(`Failed to sync result artifact: ${targetPath}`);
  }
}
