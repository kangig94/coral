import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { thrownErrnoCode } from '../infra/error-format.js';

function isCanonicalWirePath(value: string): boolean {
  return isAbsolute(value) && normalize(value) === value && resolve(value) === value;
}

export const canonicalWorkDirWireSchema = z
  .string()
  .refine(isCanonicalWirePath, 'Work directory must be absolute and normalized')
  .describe('canonical-work-dir-wire')
  .brand<'CanonicalWorkDir'>();

export type CanonicalWorkDir = z.infer<typeof canonicalWorkDirWireSchema>;

export function containsWorkDir(scopeRoot: CanonicalWorkDir, candidate: CanonicalWorkDir): boolean {
  const descendant = relative(scopeRoot, candidate);
  return descendant === '' || (!descendant.startsWith(`..${sep}`) && descendant !== '..' && !isAbsolute(descendant));
}

export class WorkDirectoryError extends Error {
  readonly code = 'invalid_work_directory';
  readonly workDir: string;
  readonly baseDir: string;

  // A POSIX path may contain any byte but NUL and '/', newline included, so workDir, baseDir, and
  // reason must never carry caller-controlled path text into this message: a rendered newline reads
  // as a line `formatErrorEnvelope` did not write, indistinguishable from Coral's own output.
  // `.workDir`/`.baseDir` carry the exact values structurally instead.
  constructor(workDir: string, baseDir: string, reason: string, cause?: unknown) {
    super(`Invalid work directory: ${reason}`, { cause });
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
    // Node's ENOENT/ENOTDIR/... messages quote the failing (caller-controlled) candidate path
    // verbatim, so error.message is barred from `reason` by the same constraint as workDir and
    // baseDir; the errno code names the failure without repeating the path.
    const reason = thrownErrnoCode(error) ?? 'path could not be resolved';
    throw new WorkDirectoryError(workDir, projectRoot, reason, error);
  }
}
