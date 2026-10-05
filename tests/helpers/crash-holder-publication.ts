import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';

export function crashHolderPublication(baseDir: string, storeRoot: string): string {
  symlinkSync(resolve('node_modules'), join(baseDir, 'node_modules'), 'dir');
  const bundle = join(baseDir, 'holder-writer.cjs');
  buildSync({
    stdin: {
      contents: `import { createRealRuntime } from './src/runtime/real.ts';
import { registerStoreEpochHolder } from './src/store/epoch/holder.ts';
const runtime = createRealRuntime('prod', { baseDir: process.argv[2] });
const write = runtime.storage.writeAtomicDurableSync;
runtime.storage.writeAtomicDurableSync = (path, data, options) => write(path, data, {
  ...options, beforeRename: () => { runtime.storage.writeFileSync(process.argv[2] + '/crashed-stage-path', options?.stagePath ?? runtime.storage.readdirSync(process.argv[3]).find((name) => name.startsWith('.epoch-holder-'))); process.kill(process.pid, 'SIGKILL'); return true; }
});
const storeRoot = process.argv[3];
runtime.storage.mkdirSync(storeRoot + '/epoch-1', { recursive: true });
registerStoreEpochHolder(runtime, { storeRoot, epoch: '1', path: storeRoot + '/epoch-1/store.db' },
  runtime.storage.openSqliteDatabaseSync(':memory:'), () => {});`,
      resolveDir: resolve('.'),
      loader: 'ts',
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    loader: { '.sql': 'text' },
    define: { 'import.meta.url': JSON.stringify(import.meta.url) },
  });
  const child = spawnSync(process.execPath, [bundle, baseDir, storeRoot], {
    env: { PATH: process.env.PATH, HOME: baseDir, LANG: 'C.UTF-8', TMPDIR: '/tmp' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (child.signal !== 'SIGKILL') throw new Error(`Holder writer did not crash at beforeRename: ${child.stderr}`);
  const path = readFileSync(join(baseDir, 'crashed-stage-path'), 'utf8');
  return path.startsWith('/') ? path : join(storeRoot, path);
}
