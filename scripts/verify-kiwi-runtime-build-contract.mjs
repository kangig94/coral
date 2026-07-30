import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

import {
  createProductionServerEsbuildOptions,
  PLACEHOLDER_STORE_FORMAT_FINGERPRINT,
} from './server-esbuild-options.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const buildDir = resolve(repoRoot, process.argv[2] ?? 'clients/build');
const expectedBuildFiles = new Set([
  'coral-backend.cjs',
  'coral-cli.cjs',
  'coral-claude-appserver.cjs',
  'manifest.json',
]);
const buildFiles = readdirSync(buildDir);
if (buildFiles.length !== expectedBuildFiles.size || buildFiles.some((entry) => !expectedBuildFiles.has(entry))) {
  throw new Error(`Kiwi build contract expected only the four bundle files, got: ${buildFiles.sort().join(', ')}`);
}

const projectManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const packageManifest = JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'kiwi-nlp', 'package.json'), 'utf-8'));
const tempRoot = mkdtempSync(join(tmpdir(), 'coral-kiwi-build-smoke-'));
const isolatedBundleDir = join(tempRoot, 'bundle');
const runtimeRoot = join(tempRoot, 'runtime');
const runtimeWasmPath = join(runtimeRoot, 'kiwi', 'wasm', `v${String(packageManifest.version)}`, 'kiwi-wasm.wasm');
const smokeBundle = join(isolatedBundleDir, 'kiwi-smoke.cjs');

try {
  mkdirSync(isolatedBundleDir, { recursive: true });
  mkdirSync(dirname(runtimeWasmPath), { recursive: true });
  copyFileSync(join(repoRoot, 'node_modules', 'kiwi-nlp', 'dist', 'kiwi-wasm.wasm'), runtimeWasmPath);

  const productionOptions = createProductionServerEsbuildOptions({
    version: String(projectManifest.version),
    buildSetId: 'kiwi-runtime-smoke',
    flavor: 'prod',
    storeFormatFingerprint: PLACEHOLDER_STORE_FORMAT_FINGERPRINT,
  });
  await esbuild.build({
    ...productionOptions,
    stdin: {
      contents: `
        import { join } from 'node:path';
        import { createKiwiApi } from './src/engines/kiwi/wasm-loader.ts';

        void (async () => {
          const runtimeRoot = process.env.CORAL_KIWI_SMOKE_ROOT;
          if (!runtimeRoot) throw new Error('CORAL_KIWI_SMOKE_ROOT is required');
          const runtime = {
            paths: {
              coral: {
                engine: {
                  dataDir: (name) => join(runtimeRoot, name),
                },
              },
            },
          };
          const api = await createKiwiApi(runtime);
          if (typeof api.cmd !== 'function' || typeof api.loadModelFiles !== 'function') {
            throw new Error('Kiwi Emscripten API did not initialize');
          }
          process.stdout.write('kiwi-runtime-wasm-ok\\n');
        })().catch((error) => {
          process.stderr.write(String(error?.stack ?? error) + '\\n');
          process.exitCode = 1;
        });
      `,
      resolveDir: repoRoot,
      sourcefile: 'kiwi-runtime-smoke.ts',
      loader: 'ts',
    },
    outfile: smokeBundle,
  });

  const output = execFileSync(process.execPath, [smokeBundle], {
    cwd: isolatedBundleDir,
    encoding: 'utf-8',
    env: {
      CORAL_KIWI_SMOKE_ROOT: runtimeRoot,
      NODE_PATH: '',
    },
  }).trim();
  if (output !== 'kiwi-runtime-wasm-ok') {
    throw new Error(`Unexpected Kiwi runtime smoke output: ${output}`);
  }
  console.log('Verified runtime-downloaded Kiwi WASM against an isolated bundled initializer');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
