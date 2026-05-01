import { join } from 'node:path';
import type { Runtime } from '#src/runtime/ports.js';

export const NEEDLE_ADDON_FILENAME = 'coral-needle.node';
export const NEEDLE_STORE_FILE = 'store.db';
export const NEEDLE_MANIFEST_FILE = 'manifest.json';
export const NEEDLE_ACTIVE_POINTER_FILE = 'ACTIVE';

export function needleIndexDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'needle');
}

export function needleStagingDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'needle-staging');
}

export function needleAddonPath(runtime: Pick<Runtime, 'paths'>): string {
  return join(runtime.paths.coral.engine.dataDir('needle'), NEEDLE_ADDON_FILENAME);
}

export function needleSnapshotsDir(runtimeDir: string): string {
  return join(needleIndexDir(runtimeDir), 'snapshots');
}

export function needleSnapshotDir(runtimeDir: string, snapshotId: string): string {
  return join(needleSnapshotsDir(runtimeDir), snapshotId);
}

export function needleSnapshotDbPath(runtimeDir: string, snapshotId: string): string {
  return join(needleSnapshotDir(runtimeDir, snapshotId), NEEDLE_STORE_FILE);
}

export function needleSnapshotManifestPath(snapshotDir: string): string {
  return join(snapshotDir, NEEDLE_MANIFEST_FILE);
}

export function needleActivePointerPath(runtimeDir: string): string {
  return join(needleIndexDir(runtimeDir), NEEDLE_ACTIVE_POINTER_FILE);
}
