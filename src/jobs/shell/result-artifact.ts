import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { jobsDir } from '../../infra/paths.js';

export function resultPathFor(jobId: string): string {
  return join(jobsDir(), jobId, 'result.md');
}

export function writeWorkflowResult(jobId: string, markdown: string): string {
  const targetPath = resultPathFor(jobId);
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(dirname(targetPath), { recursive: true });
  try {
    writeFileSync(tmpPath, markdown, 'utf-8');
    renameSync(tmpPath, targetPath);
  } catch (error: unknown) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  return targetPath;
}
