import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { jobsDir } from '../../infra/paths.js';

export function resultPathFor(jobId: string): string {
  return join(jobsDir(), jobId, 'result.md');
}

export function writeWorkflowResult(jobId: string, markdown: string): string {
  const targetPath = resultPathFor(jobId);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, markdown, 'utf-8');
  return targetPath;
}
