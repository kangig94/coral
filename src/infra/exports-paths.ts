import { join } from 'node:path';

import type { BuildFlavor } from './build-flavor.js';
import { coralRoot } from './paths.js';

export interface ExportsPaths {
  jobsRoot: string;
}

export interface ExportsPathOptions {
  readonly baseDir?: string;
}

export function exportsPaths(flavor: BuildFlavor, opts?: ExportsPathOptions): ExportsPaths {
  const base = flavor === 'dev' ? 'exports-dev' : 'exports';
  return {
    jobsRoot: join(coralRoot(opts?.baseDir), base, 'jobs'),
  };
}
