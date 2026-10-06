import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
function body(source: string, name: string, replacement: string): string {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const node = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!node?.body) throw new Error(`No body for ${name}`);
  return source.slice(0, node.body.getStart(file)) + `{ ${replacement} }` + source.slice(node.body.end);
}
function transformWait(source: string, path: string): string {
  if (path.endsWith('/cli/wait-invocation.ts')) {
    source = replaceLiteral(
      replaceLiteral(
        replaceLiteral(
          replaceLiteral(source, 'const WAIT_BUDGET_MS = 590_000', 'const WAIT_BUDGET_MS = 450'),
          'const WAIT_CLEANUP_MS = 10_000',
          'const WAIT_CLEANUP_MS = 100',
        ),
        'const SNAPSHOT_BUDGET_MS = 30_000',
        'const SNAPSHOT_BUDGET_MS = 450',
      ),
      'const SNAPSHOT_CLEANUP_MS = 1_000',
      'const SNAPSHOT_CLEANUP_MS = 100',
    );
  }
  if (path.endsWith('/cli/follow.ts'))
    source = replaceLiteral(source, 'deadlineMs - performance.now() <= 1000', 'deadlineMs - performance.now() <= 1');
  if (path.endsWith('/handoff-routing/runner.ts')) {
    source = replaceLiteral(
      source,
      '  return new Promise((resolveContract) => {',
      "  if (!['old-target', 'old-hanging-target'].includes(process.env.WAIT_PROBE_SCENARIO)) return Promise.resolve(true); return new Promise((resolveContract) => {",
    );
    source = body(source, 'resolveHandoffRoutingForOperation', 'return globalThis.waitProbe.routing();');
    source = body(source, 'publishHandoffTransition', 'return globalThis.waitProbe.publication(transition);');
    source = replaceLiteral(
      source,
      'const childObservation = observeChild(child);',
      'process.stderr.write(`OWNED_MONITOR:${child.pid}\\nHANDOFF_BUDGET:${JSON.parse(spawnOptions.env[WAIT_INVOCATION_CONTEXT_ENV]).remainingMs}\\n`); const childObservation = observeChild(child);',
    );
  }
  if (path.endsWith('/infra/handoff-target.ts')) {
    source = body(source, 'withValidatedHandoffTarget', 'return globalThis.waitProbe.execution;');
    source = body(
      source,
      'inspectValidatedHandoffTarget',
      'return { build: globalThis.waitProbe.execution.manifest };',
    );
  }
  if (path.endsWith('/ipc/ensure.ts')) source = body(source, 'ensure', 'return globalThis.waitProbe.ensure();');
  return source;
}
function transformPhase(source: string, path: string, variant: string): string {
  if (variant === 'unbounded-observer' && path.endsWith('/jobs/wait/reader.ts'))
    source = replaceLiteral(
      source,
      'observing = true;',
      'await observeCarriers(input, session, signal); observing = true;',
    );
  if (variant === 'no-handover' && path.endsWith('/transport/dispatch.ts'))
    source = replaceLiteral(source, '      rpcPorts.jobs.waitHandoverSignal(),', '      undefined,');
  if (variant === 'include-missing' && path.endsWith('/jobs/wait/session.ts'))
    source = replaceLiteral(
      source,
      "job.disposition === 'discovery-unknown' ||",
      "job.disposition === 'missing' || job.disposition === 'discovery-unknown' ||",
    );
  if (variant === 'property-decoder' && path.endsWith('/jobs/wait/cursor.ts'))
    source = replaceLiteral(
      source,
      'if (!isRecord(value) || Object.keys(value).length !== 1) return REJECTED;',
      "if (isRecord(value) && 'afterSeq' in value) return { kind: 'decoded', cursor: value as WaitCursor }; if (!isRecord(value) || Object.keys(value).length !== 1) return REJECTED;",
    );
  return source;
}
function transformAtomic(source: string, path: string, variant: string): string {
  if (variant === 'shared')
    source = replaceLiteral(
      source,
      '`${path}.stage-${process.pid}-${++durableStageCounter}-${randomUUID()}`',
      '`${path}.tmp`',
    ).replaceAll("openSync(tempPath, 'wx'", "openSync(tempPath, 'w'");
  if (variant === 'sweep')
    source = replaceLiteral(
      source,
      '  let ownsStage = false;',
      `
            for (const sibling of readdirSync(parent)) {
              const stage = join(parent, sibling);
              if (sibling.includes('.stage-') && Date.now() - statSync(stage).mtimeMs > 86400000) unlinkSync(stage);
            }
            let ownsStage = false;`,
    );
  return source;
}
export async function buildSharedFixture(name: string, directory: string): Promise<void> {
  const root = resolve('.');
  mkdirSync(directory, { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'));
  const entries = new Map<
    string,
    {
      path: string;
      family?: string;
      variant?: string;
    }
  >();
  const add = (name: string, path: string, family?: string, variant?: string): void => {
    entries.set(name, { path, family, variant });
  };
  add('wait-real', join(root, 'tests/fixtures/wait-invocation/cli.mjs'), 'wait');
  for (const variant of ['real', 'no-handover', 'include-missing', 'property-decoder', 'unbounded-observer'])
    add(`phase-${variant}`, join(root, 'tests/fixtures/wait-lifetime/phase-a.mjs'), 'phase', variant);
  for (const variant of ['real', 'shared', 'sweep'])
    add(`atomic-${variant}`, join(root, 'src/runtime/real.ts'), 'atomic', variant);
  add('publisher', join(root, 'tests/fixtures/terminal-export/publisher.ts'), 'publisher');
  add('kb-host', join(root, 'src/kb-daemon/runtime-host.ts'), 'kb');
  writeFileSync(
    join(directory, 'holder.ts'),
    "import { createRealRuntime } from '#src/runtime/real.js';\nimport { registerStoreEpochHolder } from '#src/store/epoch/holder.js';\nconst runtime = createRealRuntime('prod', { baseDir: process.argv[2] });\nconst write = runtime.storage.writeAtomicDurableSync;\nruntime.storage.writeAtomicDurableSync = (path, data, options) => write(path, data, {\n  ...options, beforeRename: () => { runtime.storage.writeFileSync(process.argv[2] + '/crashed-stage-path', options?.stagePath ?? runtime.storage.readdirSync(process.argv[3]).find((name) => name.startsWith('.epoch-holder-'))); process.kill(process.pid, 'SIGKILL'); return true; }\n});\nconst storeRoot = process.argv[3];\nruntime.storage.mkdirSync(storeRoot + '/epoch-1', { recursive: true });\nregisterStoreEpochHolder(runtime, { storeRoot, epoch: '1', path: storeRoot + '/epoch-1/store.db' },\n  runtime.storage.openSqliteDatabaseSync(':memory:'), () => {});",
  );
  add('holder', join(directory, 'holder.ts'));
  writeFileSync(
    join(directory, 'maintenance.ts'),
    "import { createRealRuntime } from '#src/runtime/real.js';\nimport { JobStore } from '#src/jobs/store.js';\nimport { JobLocationIndex } from '#src/jobs/location-index.js';\nimport { createEventBodyCodec } from '#src/store/event-body-codec.js';\nimport { newRawDatabase } from '#tests/helpers/test-db.js';\nimport { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';\nconst runtime = createRealRuntime('prod', { baseDir: process.argv[2] });\nconst db = newRawDatabase(process.argv[3]);\nconst index = new JobLocationIndex(runtime, process.argv[2]);\nconst store = new JobStore('fixture', runtime, createEventBodyCodec(), { db, providers: permissiveProviderLookupPort });\nstore.configureResultExports(index);\nconsole.log(JSON.stringify(store.ensureResultArtifact(process.argv[4])));\ndb.close();\n",
  );
  add('maintenance', join(directory, 'maintenance.ts'));
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
            path: entries.get(path.slice(8))!.path,
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
            const entry = entries.get(namespace);
            if (!entry) return undefined;
            let source = readFileSync(path, 'utf8');
            if (extname(path) === '.sql') return { contents: source, loader: 'text' };
            if (entry.family === 'wait') source = transformWait(source, path);
            if (entry.family === 'phase') source = transformPhase(source, path, entry.variant!);
            if (entry.family === 'atomic' && path.endsWith('/runtime/real.ts'))
              source = transformAtomic(source, path, entry.variant!);
            if (entry.family === 'publisher' && path.endsWith('/runtime/real.ts')) {
              const start = source.indexOf('function writeAtomicDurableSyncNode(');
              const stage = source.indexOf('    fd = null;', start);
              source = source.slice(0, stage) + '    globalThis.phaseCStage?.(path);\n' + source.slice(stage);
            }
            if (entry.family === 'kb' && path.endsWith('/kb-daemon/runtime-host.ts'))
              source += '\nexport { createKbDaemonProgressStore };\n';
            if (path.endsWith('/wait-invocation/cli.mjs'))
              source = replaceLiteral(source, 'await runCli();', 'void runCli();')
                .replaceAll('pause(250)', 'pause(150)')
                .replaceAll(', 0, 0, 850)', ', 0, 0, 450)');
            if (path.endsWith('/wait-lifetime/phase-a.mjs')) {
              const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
              const imports = file.statements.filter(ts.isImportDeclaration);
              const end = imports.at(-1)?.end ?? 0;
              source = source.slice(0, end) + '\nvoid (async () => {' + source.slice(end) + '\n})();';
            }
            return { contents: source, loader: extname(path) === '.ts' ? 'ts' : 'js' };
          });
        },
      },
    ],
  });
  if (name.startsWith('v0.')) rmSync(join(directory, name), { recursive: true, force: true });
  rmSync(join(directory, 'holder.ts'), { force: true });
  rmSync(join(directory, 'maintenance.ts'), { force: true });
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

export function replaceLiteral(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) throw new Error(`Fixture patch did not match: ${search}`);
  return source.replace(search, replacement);
}
