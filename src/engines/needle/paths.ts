import { join } from 'node:path';

export function needleIndexDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'needle');
}

export function needleStagingDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'needle-staging');
}
