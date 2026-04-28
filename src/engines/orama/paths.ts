import { join } from 'node:path';

export function oramaSnapshotDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'orama');
}
