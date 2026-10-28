import { dirname } from 'node:path';
import type { JobTerminal } from '../records.js';
import type { EventsRow } from '../../store/schema.js';
import type { StorageBigIntStat, StoragePort } from '../../infra/port-types.js';

export type DecodedResultArtifact = {
  accepted: EventsRow;
  terminal: JobTerminal;
  markdown: string | null;
  age: number | 'unknown' | 'regression';
};

export class ResultArtifactPublicationError extends Error {}

type DurabilityStorage = Pick<
  StoragePort,
  | 'openSync'
  | 'fstatSync'
  | 'statSync'
  | 'fdatasyncSync'
  | 'syncDirectoryDurableSync'
  | 'closeSync'
  | 'syncFileDataDurable'
  | 'syncDirectoryDurable'
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

function provenBy(storage: DurabilityStorage): Map<string, string> {
  let proven = provenArtifacts.get(storage);
  if (proven === undefined) provenArtifacts.set(storage, (proven = new Map()));
  return proven;
}

/**
 * Forced durability is not lost while a file keeps its inode and change time, so a proof is remembered only under a
 * stamp carrying both; a stat without a change time cannot show the file unchanged and yields no stamp.
 */
function durabilityStamp(file: StorageBigIntStat, jobsRoot: string): string | null {
  return file.ctimeNs === undefined
    ? null
    : [jobsRoot, file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join('\0');
}

/**
 * Forgets every proof an artifact's current stamp no longer confirms, so no proof outlives the file it proved, and
 * returns the artifacts left to force; null when one is not a nonempty regular file.
 */
function reconfirmProofs(
  storage: DurabilityStorage,
  proven: Map<string, string>,
  resultPaths: readonly string[],
  jobsRoot: string,
): Map<string, string | null> | null {
  const pending = new Map<string, string | null>();
  for (const resultPath of resultPaths) {
    const remembered = proven.get(resultPath);
    proven.delete(resultPath);
    const file = storage.statSync(resultPath, { bigint: true });
    if (!file.isFile() || file.size === 0n) return null;
    const stamp = durabilityStamp(file, jobsRoot);
    if (stamp !== null && stamp === remembered) proven.set(resultPath, stamp);
    else pending.set(resultPath, stamp);
  }
  return pending;
}

/**
 * Forces nonempty result artifacts and every directory naming them to stable storage; an artifact that changes while
 * it is forced stays unproven. Each artifact is remembered as soon as it is proven, so a proof that stops part way keeps
 * what it finished. A directory forced for one artifact serves the others it names only because every stamp was taken
 * before any directory was forced. Throws when an artifact cannot be observed.
 */
export function proveResultArtifactsDurable(
  storage: DurabilityStorage,
  resultPaths: readonly string[],
  jobsRoot: string,
): boolean {
  const proven = provenBy(storage);
  const pending = reconfirmProofs(storage, proven, resultPaths, jobsRoot);
  if (pending === null) return false;
  const forced = new Set<string>();
  for (const [resultPath, stamp] of pending) {
    const fd = storage.openSync(resultPath, 'r');
    try {
      storage.fdatasyncSync(fd);
      if (durabilityStamp(storage.fstatSync(fd, { bigint: true }), jobsRoot) !== stamp) return false;
    } finally {
      storage.closeSync(fd);
    }
    for (const directory of namingDirectories(resultPath, jobsRoot)) {
      if (forced.has(directory)) continue;
      if (!storage.syncDirectoryDurableSync(directory)) return false;
      forced.add(directory);
    }
    if (stamp !== null) proven.set(resultPath, stamp);
  }
  return true;
}

/** `proveResultArtifactsDurable` with every force awaited off the event loop. */
export async function proveResultArtifactsDurableAsync(
  storage: DurabilityStorage,
  resultPaths: readonly string[],
  jobsRoot: string,
  signal: AbortSignal,
): Promise<boolean> {
  const proven = provenBy(storage);
  const pending = reconfirmProofs(storage, proven, resultPaths, jobsRoot);
  if (pending === null) return false;
  const forced = new Set<string>();
  for (const [resultPath, stamp] of pending) {
    if (signal.aborted || !(await storage.syncFileDataDurable(resultPath))) return false;
    if (durabilityStamp(storage.statSync(resultPath, { bigint: true }), jobsRoot) !== stamp) return false;
    for (const directory of namingDirectories(resultPath, jobsRoot)) {
      if (forced.has(directory)) continue;
      if (signal.aborted || !(await storage.syncDirectoryDurable(directory))) return false;
      forced.add(directory);
    }
    if (stamp !== null) proven.set(resultPath, stamp);
  }
  return true;
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
