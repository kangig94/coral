import { dirname, join } from 'node:path';

import { jobsDir } from '../../infra/paths.js';
import type { StoragePort } from '../../runtime/ports.js';

export function resultPathFor(jobId: string): string {
  return join(jobsDir(), jobId, 'result.md');
}

export function writeWorkflowResult(
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  jobId: string,
  markdown: string,
): string {
  const targetPath = resultPathFor(jobId);
  storage.mkdirSync(dirname(targetPath), { recursive: true });
  if (!storage.writeAtomicSync(targetPath, markdown, { encoding: 'utf-8' })) {
    throw new Error(`Failed to write workflow result for ${jobId}`);
  }
  return targetPath;
}
