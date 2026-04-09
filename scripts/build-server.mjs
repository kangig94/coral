import * as esbuild from 'esbuild';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

mkdirSync('bridge', { recursive: true });

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
  external: ['node:*'],
  minify: true,
  banner: { js: 'var __PLUGIN_ROOT__=require("path").resolve(__dirname,"..");' },
  define: {
    __VERSION__: JSON.stringify(version),
  },
};

await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/execution/server.ts'],
  outfile: 'bridge/coral-backend.cjs',
  define: { ...sharedOpts.define, __IS_CORAL_BACKEND_MAIN__: 'true' },
});
console.log('Built bridge/coral-backend.cjs');

await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/cli/bootstrap.ts'],
  outfile: 'bridge/coral-cli.cjs',
  banner: { js: '#!/usr/bin/env node\n' + sharedOpts.banner.js },
});
console.log('Built bridge/coral-cli.cjs');

await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/providers/claude-appserver/server.ts'],
  outfile: 'bridge/coral-claude-appserver.cjs',
});
console.log('Built bridge/coral-claude-appserver.cjs');

// Write bundle manifest with content hash for version-independent change detection
const backendHash = createHash('sha256').update(readFileSync('bridge/coral-backend.cjs')).digest('hex').slice(0, 16);

writeFileSync(
  'bridge/manifest.json',
  JSON.stringify({
    bundleHash: backendHash,
  }) + '\n',
);
