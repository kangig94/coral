import * as esbuild from 'esbuild';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';

mkdirSync('build', { recursive: true });

function parseArgs(argv) {
  let flavor = 'prod';
  let release = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--flavor') {
      const value = argv[++i];
      if (value !== 'prod' && value !== 'dev') {
        throw new Error("--flavor must be followed by 'prod' or 'dev'");
      }
      flavor = value;
    } else if (argv[i] === '--release') {
      release = true;
    }
  }

  return { flavor, release };
}

function copyStoreSchemaAssets(outRoot) {
  rmSync(`${outRoot}/store/schema.sql`, { force: true });
  rmSync(`${outRoot}/store/migrations`, { recursive: true, force: true });
  rmSync(`${outRoot}/store/__tests__`, { recursive: true, force: true });
  for (const extension of ['.d.ts', '.d.ts.map', '.js', '.js.map']) {
    rmSync(`${outRoot}/store/migrations${extension}`, { force: true });
    rmSync(`${outRoot}/store/schemas${extension}`, { force: true });
  }
  rmSync(`${outRoot}/store/schemas`, { recursive: true, force: true });
  mkdirSync(`${outRoot}/store/schemas`, { recursive: true });

  for (const file of readdirSync('src/store/schemas')) {
    if (!file.endsWith('.sql')) continue;
    copyFileSync(`src/store/schemas/${file}`, `${outRoot}/store/schemas/${file}`);
  }
}

const { flavor, release } = parseArgs(process.argv.slice(2));
// Debug-only simulation must keep compiling against production source and must
// stay sealed from concrete provider/bootstrap implementations.
execFileSync('node', ['scripts/check-simulation.mjs'], { stdio: 'inherit' });
copyStoreSchemaAssets('dist');

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// Sync version to .claude-plugin/ (single source of truth: package.json)
for (const file of ['plugin.json', 'marketplace.json']) {
  const path = `.claude-plugin/${file}`;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  let changed = false;

  if (json.version !== version) {
    json.version = version;
    changed = true;
  }

  if (json.plugins?.[0]?.version !== undefined && json.plugins[0].version !== version) {
    json.plugins[0].version = version;
    changed = true;
  }

  if (changed) {
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  }
}

const sharedOpts = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['node:*', 'better-sqlite3'],
  minify: true,
  banner: { js: 'var __PLUGIN_ROOT__=require("path").resolve(__dirname,"..");' },
  define: {
    __VERSION__: JSON.stringify(version),
  },
};

await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/coordinator/bootstrap.ts'],
  outfile: 'build/coral-backend.cjs',
  define: { ...sharedOpts.define, __IS_CORAL_BACKEND_MAIN__: 'true' },
});
copyStoreSchemaAssets('build');
console.log('Built build/coral-backend.cjs');

await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/cli/bootstrap.ts'],
  outfile: 'build/coral-cli.cjs',
  banner: { js: '#!/usr/bin/env node\n' + sharedOpts.banner.js },
});
console.log('Built build/coral-cli.cjs');

await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/providers/claude-appserver/server.ts'],
  outfile: 'build/coral-claude-appserver.cjs',
});
console.log('Built build/coral-claude-appserver.cjs');

// Write bundle manifest with content hash for version-independent change detection
const backendHash = createHash('sha256').update(readFileSync('build/coral-backend.cjs')).digest('hex').slice(0, 16);
const manifestPath = 'build/manifest.json';
const manifestTmp = manifestPath + '.tmp';

writeFileSync(
  manifestTmp,
  JSON.stringify({
    bundleHash: backendHash,
    flavor,
  }) + '\n',
);
renameSync(manifestTmp, manifestPath);

if (release) {
  mkdirSync('bridge', { recursive: true });
  for (const file of ['coral-backend.cjs', 'coral-cli.cjs', 'coral-claude-appserver.cjs', 'manifest.json']) {
    copyFileSync(`build/${file}`, `bridge/${file}`);
  }
  chmodSync('bridge/coral-cli.cjs', 0o755);
  console.log('Copied build/ -> bridge/');
}
