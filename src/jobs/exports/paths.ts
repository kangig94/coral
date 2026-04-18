import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BuildFlavor } from '../../runtime/flavor.js';

export interface ExportsPaths {
  jobsRoot: string;
}

export interface ExportsPathOptions {
  readonly baseDir?: string;
}

function coralRoot(opts?: ExportsPathOptions): string {
  return opts?.baseDir ?? join(homedir(), '.coral');
}

export function exportsPaths(flavor: BuildFlavor, opts?: ExportsPathOptions): ExportsPaths {
  const base = flavor === 'dev' ? 'exports-dev' : 'exports';
  return {
    jobsRoot: join(coralRoot(opts), base, 'jobs'),
  };
}
