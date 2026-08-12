import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';

import { z } from 'zod';

function isCanonicalWirePath(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value && resolve(value) === value;
}

export const canonicalWorkDirWireSchema = z
  .string()
  .refine(isCanonicalWirePath, 'Work directory must be absolute and normalized')
  .describe('canonical-work-dir-wire')
  .brand<'CanonicalWorkDir'>();

export type CanonicalWorkDir = z.infer<typeof canonicalWorkDirWireSchema>;

export class WorkDirectoryError extends Error {
  readonly code = 'invalid_work_directory';
  readonly workDir: string;
  readonly baseDir: string;

  constructor(workDir: string, baseDir: string, reason: string, cause?: unknown) {
    super(`Invalid work directory '${workDir}' resolved from '${baseDir}': ${reason}`, { cause });
    this.name = 'WorkDirectoryError';
    this.workDir = workDir;
    this.baseDir = baseDir;
  }
}

export function canonicalizeWorkDir(workDir: string, projectRoot: string): CanonicalWorkDir {
  if (workDir.length === 0) {
    throw new WorkDirectoryError(workDir, projectRoot, 'path is empty');
  }

  const candidate = resolve(projectRoot, workDir);
  try {
    const canonical = realpathSync(candidate);
    if (!statSync(canonical).isDirectory()) {
      throw new WorkDirectoryError(workDir, projectRoot, 'path is not a directory');
    }
    return canonicalWorkDirWireSchema.parse(canonical);
  } catch (error: unknown) {
    if (error instanceof WorkDirectoryError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkDirectoryError(workDir, projectRoot, reason, error);
  }
}
