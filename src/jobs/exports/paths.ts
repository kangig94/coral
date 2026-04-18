import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BuildFlavor } from '../../runtime/flavor.js';

export interface ExportsPaths {
  jobsRoot: string;
}

export function exportsPaths(flavor: BuildFlavor): ExportsPaths {
  const base = flavor === 'dev' ? 'exports-dev' : 'exports';
  return {
    jobsRoot: join(homedir(), '.coral', base, 'jobs'),
  };
}
