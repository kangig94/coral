import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BuildFlavor } from '../../runtime/flavor.js';

export interface CorpusPaths {
  kbRoot: string;
  notesDir: string;
  sourcesDir: string;
  principlesDir: string;
  communitiesDir: string;
  derivedDir: string;
}

export function corpusPaths(flavor: BuildFlavor): CorpusPaths {
  const base = flavor === 'dev' ? 'kb-dev' : 'kb';
  const kbRoot = join(homedir(), '.coral', base);
  return {
    kbRoot,
    notesDir: join(kbRoot, 'notes'),
    sourcesDir: join(kbRoot, 'sources'),
    principlesDir: join(kbRoot, 'principles'),
    communitiesDir: join(kbRoot, 'communities'),
    derivedDir: join(kbRoot, 'derived'),
  };
}
