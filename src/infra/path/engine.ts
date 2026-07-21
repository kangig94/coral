import { join } from 'node:path';
import type { BuildFlavor } from '../build-flavor.js';
import { coralStateRoot } from './root.js';

// Phase 2 reservation: `~/.coral/expansions/<name>/` is reserved for
// filesystem-discovered third-party engines (Phase 2; out of scope for the
// `kb-engine-uniform-binding` plan). Phase 1's loader does not scan this
// directory; bundled engines live under `data/engines/<name>/` (this layer's
// `dataDir`) and installed engines write through their per-engine installer.
// Reservation lives here — at the engine path authority — so a future Phase 2
// loader has one canonical place to extend without re-scattering the literal.

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
  const engineRoot = join(coralStateRoot(opts?.baseDir), base);
  const dataDir = (name: string): string => join(engineRoot, name);
  return {
    engineRoot,
    dataDir,
    installLockPath: (name) => join(dataDir(name), 'install.lock'),
  };
}
