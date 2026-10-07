import { sharedFixture } from './shared-fixtures.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function crashHolderPublication(baseDir: string, storeRoot: string): string {
  const bundle = sharedFixture('holder');
  const child = spawnSync(process.execPath, [bundle, baseDir, storeRoot], {
    env: { PATH: process.env.PATH, HOME: baseDir, LANG: 'C.UTF-8', TMPDIR: '/tmp' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (child.signal !== 'SIGKILL') throw new Error(`Holder writer did not crash at beforeRename: ${child.stderr}`);
  const path = readFileSync(join(baseDir, 'crashed-stage-path'), 'utf8');
  return path.startsWith('/') ? path : join(storeRoot, path);
}
