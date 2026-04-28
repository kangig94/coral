import { join } from 'node:path';
import type { BuildFlavor } from '../build-flavor.js';
import { coralRoot } from './root.js';

export interface EnginePaths {
  readonly engineRoot: string;
  dataDir(name: string): string;
  installLockPath(name: string): string;
}

export interface EnginePathOptions {
  readonly baseDir?: string;
}

export function enginePaths(flavor: BuildFlavor, opts?: EnginePathOptions): EnginePaths {
  const base = flavor === 'dev' ? 'data-dev/engines' : 'data/engines';
  const engineRoot = join(coralRoot(opts?.baseDir), base);
  const dataDir = (name: string): string => join(engineRoot, name);
  return {
    engineRoot,
    dataDir,
    installLockPath: (name) => join(dataDir(name), 'install.lock'),
  };
}
