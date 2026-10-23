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
  const boundary = dirname(jobsRoot);
  for (let directory = dirname(targetPath); ; directory = dirname(directory)) {
    if (!storage.syncDirectoryDurableSync(directory))
      throw new ResultArtifactPublicationError(`Failed to sync result artifact: ${targetPath}`);
    if (directory === boundary || directory === dirname(directory)) break;
  }
}
