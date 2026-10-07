import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
export async function buildSharedFixture(name: string, directory: string): Promise<void> {
  const root = resolve('.');
  mkdirSync(directory, { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'));
  const entries = new Map<string, string>();
  const add = (name: string, path: string): void => {
    entries.set(name, path);
  };
  writeFileSync(
    join(directory, 'holder.ts'),
    "import { createRealRuntime } from '#src/runtime/real.js';\nimport { registerStoreEpochHolder } from '#src/store/epoch/holder.js';\nconst runtime = createRealRuntime('prod', { baseDir: process.argv[2] });\nconst write = runtime.storage.writeAtomicDurableSync;\nruntime.storage.writeAtomicDurableSync = (path, data, options) => write(path, data, {\n  ...options, beforeRename: () => { runtime.storage.writeFileSync(process.argv[2] + '/crashed-stage-path', options?.stagePath ?? runtime.storage.readdirSync(process.argv[3]).find((name) => name.startsWith('.epoch-holder-'))); process.kill(process.pid, 'SIGKILL'); return true; }\n});\nconst storeRoot = process.argv[3];\nruntime.storage.mkdirSync(storeRoot + '/epoch-1', { recursive: true });\nregisterStoreEpochHolder(runtime, { storeRoot, epoch: '1', path: storeRoot + '/epoch-1/store.db' },\n  runtime.storage.openSqliteDatabaseSync(':memory:'), () => {});",
  );
  add('holder', join(directory, 'holder.ts'));
  for (const tag of ['v0.10.15', 'v0.10.16', 'v0.10.17', 'v0.10.18']) {
    if (tag !== name) continue;
    const releaseRoot = join(directory, tag);
    mkdirSync(releaseRoot);
    execFileSync('tar', ['-x', '-C', releaseRoot], {
      input: execFileSync('git', ['archive', tag, 'src'], { maxBuffer: 50 * 1024 * 1024 }),
    });
    const durableExports =
      tag === 'v0.10.15'
        ? "export { sweepStoreEpochsPostReady } from './src/store/epoch.ts';"
        : "export { JobLocationIndex } from './src/jobs/location-index.ts'; export { readPendingProtections } from './src/store/epoch/pending-protection.ts'; export { sweepStoreEpochsPostReady } from './src/store/epoch/post-ready-sweep.ts';" +
          (tag === 'v0.10.16' ? '' : "export { pruneStoreEpochHolders } from './src/store/epoch/holder.ts';");
    const entry = join(releaseRoot, 'released.ts');
    writeFileSync(entry, durableExports);
    add(tag, entry);
  }
  await build({
    entryPoints: { [name]: `fixture:${name}` },
    outdir: directory,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(root, 'src/runtime/wrapper-entrypoint.ts')).href) },
    plugins: [
      {
        name: 'shared-fixtures',
        setup(builder) {
          builder.onResolve({ filter: /^fixture:/ }, ({ path }) => ({
            path: entries.get(path.slice(8))!,
            namespace: path.slice(8),
          }));
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (!entries.has(args.namespace)) return undefined;
            let path: string;
            if (/^#(?:src|tests|tools)\//.test(args.path)) path = join(root, args.path.slice(1));
            else if (args.path.startsWith('.')) path = resolve(dirname(args.importer), args.path);
            else if (args.path.startsWith('/')) path = args.path;
            else return { path: args.path, external: true };
            if (path.endsWith('.js') && !existsSync(path)) path = path.slice(0, -3) + '.ts';
            return { path, namespace: args.namespace };
          });
          builder.onLoad({ filter: /.*/ }, ({ path, namespace }) => {
            if (!entries.has(namespace)) return undefined;
            const source = readFileSync(path, 'utf8');
            if (extname(path) === '.sql') return { contents: source, loader: 'text' };
            return { contents: source, loader: extname(path) === '.ts' ? 'ts' : 'js' };
          });
        },
      },
    ],
  });
  if (name.startsWith('v0.')) rmSync(join(directory, name), { recursive: true, force: true });
  rmSync(join(directory, 'holder.ts'), { force: true });
}
if (process.argv[1]?.endsWith('/shared-fixtures.ts')) {
  const [name, pending, destination] = process.argv.slice(2);
  const stage = join(dirname(pending), basename(pending).replace(/^stage-\d+-/, `stage-${process.pid}-`));
  renameSync(pending, stage);
  try {
    await buildSharedFixture(name, stage);
    try {
      renameSync(stage, destination);
    } catch (error) {
      if (!existsSync(join(destination, `${name}.cjs`))) throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
