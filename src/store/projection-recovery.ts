import { rebuildProjections as rebuildJournalProjections, type RebuildOptions } from './rebuild.js';

export function rebuildProjections(opts: RebuildOptions): void {
  rebuildJournalProjections(opts);
}
