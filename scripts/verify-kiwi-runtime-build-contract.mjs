import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
if (!existsSync(buildDir)) {
  throw new Error(`Kiwi build contract is missing ${buildDir}; run \`npm run build\` before this verifier.`);
}
const buildFiles = readdirSync(buildDir);
const missingBuildFiles = [...expectedBuildFiles].filter((entry) => !buildFiles.includes(entry));
const unexpectedBuildFiles = buildFiles.filter(
  (entry) => !expectedBuildFiles.has(entry) && entry !== 'build-receipt.json',
);
if (missingBuildFiles.length > 0 || unexpectedBuildFiles.length > 0) {
  throw new Error(
    `Kiwi build contract expected the four bundle files and optional build receipt, with no WASM staged beside them; got: ${buildFiles.sort().join(', ')}`,
  );
}

const projectManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8'));
const packageManifest = JSON.parse(readFileSync(join(repoRoot, 'node_modules', 'kiwi-nlp', 'package.json'), 'utf-8'));
const tempRoot = mkdtempSync(join(tmpdir(), 'coral-kiwi-build-smoke-'));
const isolatedBundleDir = join(tempRoot, 'bundle');
const runtimeRoot = join(tempRoot, 'runtime');
// Deliberately derive the kiwi/wasm/v<ver>/ layout and installed version independently of
// src/engines/kiwi/paths.ts and KIWI_NLP_VERSION so drift makes this verifier fail instead of
// silently passing.
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
