import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { coralStateRoot } from './root.js';

export type JobExportPaths = Readonly<{
  resultMarkdown: string;
  workflowMetadata: string;
}>;

export interface ExportsPaths {
  readonly jobsRoot: string;
  forJob(jobId: string): JobExportPaths;
}

export function exportsPaths(flavor: BuildFlavor, opts?: { readonly baseDir?: string }): ExportsPaths {
  const base = flavor === 'dev' ? 'exports-dev' : 'exports';
  const jobsRoot = join(coralStateRoot(opts?.baseDir), base, 'jobs');
  return {
    jobsRoot,
    forJob: (jobId) => {
      const jobRoot = join(jobsRoot, jobId);
      return {
        resultMarkdown: join(jobRoot, 'result.md'),
        workflowMetadata: join(jobRoot, 'workflow.json'),
      };
    },
  };
}
