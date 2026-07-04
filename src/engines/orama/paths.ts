import { join } from 'node:path';

const ORAMA_INDEX_FILE = 'orama-index.json';
const ORAMA_INDEX_METADATA_FILE = 'orama-index.metadata.json';

export function oramaSnapshotDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'orama');
}

export function oramaIndexPath(runtimeRoot: string): string {
  return join(oramaSnapshotDir(runtimeRoot), ORAMA_INDEX_FILE);
}

export function oramaIndexMetadataPath(runtimeRoot: string): string {
  return join(oramaSnapshotDir(runtimeRoot), ORAMA_INDEX_METADATA_FILE);
}
