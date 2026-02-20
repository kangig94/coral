import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';

mkdirSync('bridge', { recursive: true });

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// Sync version to .claude-plugin/ (single source of truth: package.json)
for (const file of ['plugin.json', 'marketplace.json']) {
  const path = `.claude-plugin/${file}`;
  const json = JSON.parse(readFileSync(path, 'utf8'));
  let changed = false;
  if (json.version !== version) { json.version = version; changed = true; }
  if (json.plugins?.[0]?.version !== undefined && json.plugins[0].version !== version) {
    json.plugins[0].version = version; changed = true;
  }
  if (changed) writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
}

await esbuild.build({
  entryPoints: ['src/codex/server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'bridge/coral-codex.cjs',
  external: ['node:*'],
  minify: true,
  banner: { js: 'var __PLUGIN_ROOT__=require("path").resolve(__dirname,"..");' },
  define: {
    '__VERSION__': JSON.stringify(version),
  },
});

console.log('Built bridge/coral-codex.cjs');
