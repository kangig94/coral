import { join } from 'node:path';

export const ORAMA_INDEX_FILE = 'orama-index.json';

export function oramaSnapshotDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'orama');
}

export function oramaIndexPath(runtimeRoot: string): string {
  return join(oramaSnapshotDir(runtimeRoot), ORAMA_INDEX_FILE);
}
