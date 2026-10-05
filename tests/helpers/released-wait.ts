import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { WaitStreamEvent, WaitCursor } from '#src/jobs/wait/contract.js';
import type { JobLocationIndex } from '#src/jobs/location-index.js';
import type { readPendingProtections } from '#src/store/epoch/pending-protection.js';
import type * as Holders from '#src/store/epoch/holder.js';
import type * as Sweep from '#src/store/epoch/post-ready-sweep.js';

type ReleasedWait = {
  parseWaitStreamEventValue(value: unknown): WaitStreamEvent;
  advanceWaitRenderCursor(cursor: WaitCursor, event: WaitStreamEvent): { cursor: WaitCursor };
  formatWaitTerminal(event: WaitStreamEvent, labels: null, embed: boolean): string;
  formatWaitWaiting(event: WaitStreamEvent, cursor: string, jobIds: string[]): string;
  serializeWaitCursor(cursor: WaitCursor): string;
  JobLocationIndex?: typeof JobLocationIndex;
  jobWaitSchema: { parse(request: unknown): unknown };
  readPendingProtections?: typeof readPendingProtections;
  pruneStoreEpochHolders?: typeof Holders.pruneStoreEpochHolders;
  sweepStoreEpochsPostReady?: typeof Sweep.sweepStoreEpochsPostReady;
};

/** Load the released decoder and formatter rather than approximating their contracts in a test double. */
export async function loadReleasedWait(
  tag: 'v0.10.15' | 'v0.10.16' | 'v0.10.17',
  directories: string[],
): Promise<ReleasedWait> {
  const root = mkdtempSync(join(tmpdir(), 'coral-released-wait-'));
  directories.push(root);
  execFileSync('tar', ['-x', '-C', root], {
    input: execFileSync('git', ['archive', tag, 'src'], { maxBuffer: 50 * 1024 * 1024 }),
  });
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const entry = join(root, 'entry.ts');
  writeFileSync(
    entry,
    `export { parseWaitStreamEventValue, advanceWaitRenderCursor } from './src/jobs/wait-stream-event.ts';
export { jobWaitSchema } from './src/transport/rpc/jobs.ts';
export { formatWaitTerminal, formatWaitWaiting } from './src/cli/format/wait.ts';
export { serializeWaitCursor } from './src/jobs/wait.ts';
${tag === 'v0.10.15' ? "export { sweepStoreEpochsPostReady } from './src/store/epoch.ts';" : (tag === 'v0.10.17' ? "export { pruneStoreEpochHolders } from './src/store/epoch/holder.ts';\n" : '') + "export { sweepStoreEpochsPostReady } from './src/store/epoch/post-ready-sweep.ts';\nexport { JobLocationIndex } from './src/jobs/location-index.ts';\nexport { readPendingProtections } from './src/store/epoch/pending-protection.ts';"}`,
  );
  const outfile = join(root, 'released.mjs');
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    loader: { '.sql': 'text' },
  });
  return import(pathToFileURL(outfile).href) as Promise<ReleasedWait>;
}
