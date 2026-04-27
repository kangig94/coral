import { join } from 'node:path';
import type { BuildFlavor } from '../build-flavor.js';
import { coralRoot } from './root.js';

export const EXPANSION_ADDON_FILENAMES = {
  needle: 'coral-needle.node',
} as const satisfies Record<string, string>;

export interface ExpansionPaths {
  readonly expansionRoot: string;
  dataDir(name: string): string;
  installLockPath(name: string): string;
  addonPath(name: string): string;
}

export interface ExpansionPathOptions {
  readonly baseDir?: string;
}

export function expansionPaths(flavor: BuildFlavor, opts?: ExpansionPathOptions): ExpansionPaths {
  const base = flavor === 'dev' ? 'data-dev/expansion' : 'data/expansion';
  const expansionRoot = join(coralRoot(opts?.baseDir), base);
  const dataDir = (name: string): string => join(expansionRoot, name);
  return {
    expansionRoot,
    dataDir,
    installLockPath: (name) => join(dataDir(name), 'install.lock'),
    addonPath: (name) =>
      join(
        dataDir(name),
        EXPANSION_ADDON_FILENAMES[name as keyof typeof EXPANSION_ADDON_FILENAMES] ?? `${name}.node`,
      ),
  };
}
