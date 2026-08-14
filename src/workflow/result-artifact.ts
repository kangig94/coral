import { dirname } from 'node:path';

import type { StoragePort } from '../infra/port-types.js';
import { resultPathFor } from '../jobs/terminal/export.js';

/**
 * Workflow roots export a synthesized multi-step report rather than a provider terminal payload.
 * Keeping this writer in the workflow module prevents provider terminal paths from bypassing the
 * durable terminal materializer in `jobs/terminal/export.ts`.
 */
export function writeWorkflowResultArtifact(
  storage: Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>,
  jobsRoot: string,
  workflowJobId: string,
  markdown: string,
): string {
  const targetPath = resultPathFor(jobsRoot, workflowJobId);
  storage.mkdirSync(dirname(targetPath), { recursive: true });
  if (!storage.writeAtomicSync(targetPath, markdown, { encoding: 'utf-8' })) {
    throw new Error(`Failed to write workflow result artifact for ${workflowJobId}`);
  }
  return targetPath;
}
