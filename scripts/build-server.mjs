import * as esbuild from 'esbuild';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

mkdirSync('clients/build', { recursive: true });

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

const { flavor, release } = parseArgs(process.argv.slice(2));
// Debug-only simulation must keep compiling against production source and must
// stay sealed from concrete provider/bootstrap implementations.
execFileSync('node', ['scripts/check-simulation.mjs'], { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// Sync manifest versions (single source of truth: package.json). The plugin
// manifests live under clients/ (the plugin root); marketplace.json stays at
// the repo root and points at ./clients via a git-subdir source.
for (const path of ['clients/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'clients/.codex-plugin/plugin.json']) {
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

  if (release && path === '.claude-plugin/marketplace.json') {
    const pluginSource = json.plugins?.[0]?.source;
    const releaseRef = `v${version}`;
    if (pluginSource && typeof pluginSource === 'object') {
      if (pluginSource.ref !== releaseRef) {
        pluginSource.ref = releaseRef;
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  }
}

const sharedOpts = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['node:*', '@lydell/node-pty'],
  loader: { '.sql': 'text' },
  minify: true,
  banner: {
    js:
      'var __PLUGIN_ROOT__=require("path").resolve(__dirname,"..");' +
      'var __BUNDLE_DIR__=__dirname;' +
      'var __importMetaUrl=require("url").pathToFileURL(__filename).href;',
  },
  define: {
    __VERSION__: JSON.stringify(version),
    // esbuild empties `import.meta` in CJS output, so `import.meta.url` would be
    // `undefined`; redirect it to a banner-injected file URL of the bundle file
    // so `createRequire(import.meta.url)` (e.g. engines/kiwi/paths.ts) resolves.
    'import.meta.url': '__importMetaUrl',
  },
};

await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/coordinator/bootstrap.ts'],
  outfile: 'clients/build/coral-backend.cjs',
  define: { ...sharedOpts.define, __IS_CORAL_BACKEND_MAIN__: 'true' },
});
console.log('Built clients/build/coral-backend.cjs');

await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/cli/bootstrap.ts'],
  outfile: 'clients/build/coral-cli.cjs',
  banner: { js: '#!/usr/bin/env node\n' + sharedOpts.banner.js },
});
console.log('Built clients/build/coral-cli.cjs');

await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/providers/claude/appserver/server.ts'],
  outfile: 'clients/build/coral-claude-appserver.cjs',
});
console.log('Built clients/build/coral-claude-appserver.cjs');

// Write bundle manifest with content hash for version-independent change detection
const backendHash = createHash('sha256').update(readFileSync('clients/build/coral-backend.cjs')).digest('hex').slice(0, 16);
const manifestPath = 'clients/build/manifest.json';
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
  // The shipped bundle (clients/bridge/) and the staging dir (clients/build/)
  // share one parent — the plugin root, clients/. So __PLUGIN_ROOT__
  // (resolve(bundleDir, '..') === clients/) is identical whether the staging or
  // shipped bundle runs, keeping inject/methods/agents co-located with both.
  const bridgeDir = 'clients/bridge';
  mkdirSync(bridgeDir, { recursive: true });
  const bridgeFiles = ['coral-backend.cjs', 'coral-cli.cjs', 'coral-claude-appserver.cjs', 'manifest.json'];
  // Sweep stale leftovers from prior releases (e.g., bridge/store/schemas/
  // from the pre-flatten era) so bridge contains only the current bundle
  // surface. Anything not in `bridgeFiles` is removed.
  const expected = new Set(bridgeFiles);
  for (const entry of readdirSync(bridgeDir)) {
    if (!expected.has(entry)) {
      rmSync(join(bridgeDir, entry), { recursive: true, force: true });
    }
  }
  for (const file of bridgeFiles) {
    copyFileSync(join('clients', 'build', file), join(bridgeDir, file));
  }
  chmodSync(join(bridgeDir, 'coral-cli.cjs'), 0o755);
  console.log(`Copied clients/build/ -> ${bridgeDir}/`);
}
