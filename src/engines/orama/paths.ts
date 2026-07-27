import { join } from 'node:path';
import { KB_RUNTIME_AUTHORITY } from '../../runtime/kb-runtime-authority.js';

const ORAMA_INDEX_FILE = 'orama-index.json';
const ORAMA_INDEX_METADATA_FILE = 'orama-index.metadata.json';

export function oramaSnapshotDir(runtimeRoot: string): string {
  return join(runtimeRoot, KB_RUNTIME_AUTHORITY.orama);
}

export function oramaIndexPath(runtimeRoot: string): string {
  return join(oramaSnapshotDir(runtimeRoot), ORAMA_INDEX_FILE);
}

export function oramaIndexMetadataPath(runtimeRoot: string): string {
  return join(oramaSnapshotDir(runtimeRoot), ORAMA_INDEX_METADATA_FILE);
}
