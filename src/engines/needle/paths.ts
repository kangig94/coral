import { join } from 'node:path';
import type { Runtime } from '#src/runtime/ports.js';

export const NEEDLE_ADDON_FILENAME = 'coral-needle.node';

export function needleIndexDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'needle');
}

export function needleStagingDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'needle-staging');
}

export function needleAddonPath(runtime: Pick<Runtime, 'paths'>): string {
  return join(runtime.paths.coral.engine.dataDir('needle'), NEEDLE_ADDON_FILENAME);
}
