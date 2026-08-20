import * as esbuild from 'esbuild';
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'path';

import {
  createProductionServerEsbuildOptions,
  PLACEHOLDER_STORE_FORMAT_FINGERPRINT,
} from './server-esbuild-options.mjs';

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
const buildSetId = randomUUID();
// Debug-only simulation must keep compiling against production source and must
// stay sealed from concrete provider/bootstrap implementations.
execFileSync('node', ['scripts/check-simulation.mjs'], { stdio: 'inherit' });

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

/**
 * Copilot rejects the `git-subdir` object Claude Code uses — verified against Copilot CLI 1.0.78, where only
 * `{source:"github", repo, ref, path}` installs — so the two marketplaces name the same tag in different
 * shapes. The repo slug is read back out of the Claude manifest rather than repeated here, so a fork changes
 * one URL and both clients follow.
 */
function pinnedCopilotSource(releaseVersion) {
  const claudeUrl = JSON.parse(readFileSync('.claude-plugin/marketplace.json', 'utf8')).plugins?.[0]?.source?.url;
  const repo = /github\.com[/:](?<slug>[^/]+\/[^/]+?)(?:\.git)?$/u.exec(claudeUrl ?? '')?.groups?.slug;
  if (repo === undefined) {
    throw new Error(`Cannot derive the Copilot marketplace repo from the Claude marketplace url: ${claudeUrl}`);
  }
  return { source: 'github', repo, ref: `v${releaseVersion}`, path: 'clients' };
}

// Sync manifest versions (single source of truth: package.json). Each client reads a different
// manifest path, so all of them are kept in lockstep here:
//   Claude Code — clients/.claude-plugin/plugin.json + .claude-plugin/marketplace.json
//   Codex       — clients/.codex-plugin/plugin.json
//   Copilot CLI — clients/.github/plugin/plugin.json + .github/plugin/marketplace.json
//                 (Copilot also reads .claude-plugin/, but resolves .github/plugin/
//                 first, so the Copilot-specific manifests win without the Claude
//                 ones needing a Copilot-compatible shape.)
for (const path of [
  'clients/.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  'clients/.codex-plugin/plugin.json',
  'clients/.github/plugin/plugin.json',
  '.github/plugin/marketplace.json',
]) {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  let changed = false;

  if (json.version !== undefined && json.version !== version) {
    json.version = version;
    changed = true;
  }

  if (json.metadata?.version !== undefined && json.metadata.version !== version) {
    json.metadata.version = version;
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

  // Copilot's manifest is read from the default branch, so `main` must carry a source that installs today —
  // a bare `./clients`, which resolves against that same branch. Pinning is therefore written by the release
  // rather than committed: the release commit lands on `main`, so from then until the next release Copilot
  // resolves the tag just built instead of whatever has since merged.
  if (release && path === '.github/plugin/marketplace.json') {
    const pinned = pinnedCopilotSource(version);
    if (JSON.stringify(json.plugins?.[0]?.source) !== JSON.stringify(pinned)) {
      json.plugins[0].source = pinned;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
  }
}

let sharedOpts = createProductionServerEsbuildOptions({
  version,
  buildSetId,
  flavor,
  storeFormatFingerprint: PLACEHOLDER_STORE_FORMAT_FINGERPRINT,
});

await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/coordinator/bootstrap.ts'],
  outfile: 'clients/build/coral-backend.cjs',
  define: { ...sharedOpts.define, __IS_CORAL_BACKEND_MAIN__: 'true' },
});

const storeFormatFingerprint = execFileSync(
  process.execPath,
  ['clients/build/coral-backend.cjs', '--print-store-format-fingerprint'],
  { encoding: 'utf8' },
).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(storeFormatFingerprint)) {
  throw new Error(`Built backend reported an invalid store format fingerprint: ${storeFormatFingerprint}`);
}
sharedOpts = createProductionServerEsbuildOptions({
  version,
  buildSetId,
  flavor,
  storeFormatFingerprint,
});
const backendBuild = await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/coordinator/bootstrap.ts'],
  outfile: 'clients/build/coral-backend.cjs',
  define: { ...sharedOpts.define, __IS_CORAL_BACKEND_MAIN__: 'true' },
  metafile: true,
});

const backendBundle = readFileSync('clients/build/coral-backend.cjs');
for (const fragmentPath of ['core.md', 'tools.md', 'kb/common.md', 'kb/session.md']) {
  if (!backendBundle.includes(Buffer.from(JSON.stringify(fragmentPath)))) {
    throw new Error(`Built backend does not reference inject fragment: ${fragmentPath}`);
  }
}
const legacyInjectMonolith = 'INJECT.md';
if (backendBundle.includes(Buffer.from(JSON.stringify(legacyInjectMonolith)))) {
  throw new Error('Built backend still references the removed monolithic inject file');
}
console.log('Built clients/build/coral-backend.cjs');

const cliBuild = await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/cli/bootstrap.ts'],
  outfile: 'clients/build/coral-cli.cjs',
  banner: { js: '#!/usr/bin/env node\n' + sharedOpts.banner.js },
  metafile: true,
});
console.log('Built clients/build/coral-cli.cjs');

const claudeAppserverBuild = await esbuild.build({
  ...sharedOpts,
  entryPoints: ['src/providers/claude/appserver/server.ts'],
  outfile: 'clients/build/coral-claude-appserver.cjs',
  metafile: true,
});
console.log('Built clients/build/coral-claude-appserver.cjs');

const backendHash = createHash('sha256').update(backendBundle).digest('hex').slice(0, 16);
const cliHash = createHash('sha256').update(readFileSync('clients/build/coral-cli.cjs')).digest('hex').slice(0, 16);
const claudeAppserverHash = createHash('sha256')
  .update(readFileSync('clients/build/coral-claude-appserver.cjs'))
  .digest('hex')
  .slice(0, 16);
const manifestPath = 'clients/build/manifest.json';
const manifestTmp = manifestPath + '.tmp';

writeFileSync(
  manifestTmp,
  JSON.stringify({
    version,
    buildSetId,
    bundleHash: backendHash,
    cliBundleHash: cliHash,
    claudeAppserverBundleHash: claudeAppserverHash,
    flavor,
    storeFormatFingerprint,
  }) + '\n',
);
renameSync(manifestTmp, manifestPath);
execFileSync(process.execPath, ['scripts/verify-kiwi-runtime-build-contract.mjs', 'clients/build'], {
  stdio: 'inherit',
});

const repositoryRoot = process.cwd();
const requiredReceiptInputs = [
  'package.json',
  'scripts/build-server.mjs',
  'scripts/server-esbuild-options.mjs',
  'tsconfig.json',
];

function canonicalReceiptInput(input) {
  const repositoryRelative = isAbsolute(input) ? relative(repositoryRoot, input) : input;
  const canonical = repositoryRelative.split(sep).join('/').replaceAll('\\', '/');
  if (
    canonical.length === 0 ||
    posix.isAbsolute(canonical) ||
    posix.normalize(canonical) !== canonical ||
    canonical.split('/').includes('..') ||
    resolve(repositoryRoot, canonical) === repositoryRoot ||
    !resolve(repositoryRoot, canonical).startsWith(`${repositoryRoot}${sep}`)
  ) {
    throw new Error(`Build input is not a canonical repository-relative path: ${input}`);
  }
  return canonical;
}

function framedSourceSha256(inputs) {
  const digest = createHash('sha256');
  for (const input of inputs) {
    const pathBytes = Buffer.from(input, 'utf8');
    const content = readFileSync(resolve(repositoryRoot, input));
    const pathLength = Buffer.alloc(4);
    pathLength.writeUInt32BE(pathBytes.length);
    const contentLength = Buffer.alloc(8);
    contentLength.writeBigUInt64BE(BigInt(content.length));
    digest.update(pathLength).update(pathBytes).update(contentLength).update(content);
  }
  return digest.digest('hex');
}

const receiptInputs = [
  ...new Set([
    ...Object.keys(backendBuild.metafile.inputs),
    ...Object.keys(cliBuild.metafile.inputs),
    ...Object.keys(claudeAppserverBuild.metafile.inputs),
    ...requiredReceiptInputs,
  ].map(canonicalReceiptInput)),
].sort();
const receiptOutputs = {
  backend: { path: 'clients/build/coral-backend.cjs' },
  cli: { path: 'clients/build/coral-cli.cjs' },
  claudeAppserver: { path: 'clients/build/coral-claude-appserver.cjs' },
  manifest: { path: 'clients/build/manifest.json' },
};
for (const output of Object.values(receiptOutputs)) {
  output.sha256 = createHash('sha256').update(readFileSync(output.path)).digest('hex');
}
const buildReceiptPath = 'clients/build/build-receipt.json';
const buildReceiptTmp = `${buildReceiptPath}.tmp`;
writeFileSync(
  buildReceiptTmp,
  JSON.stringify({
    schemaVersion: 1,
    algorithm: 'sha256',
    flavor,
    sourceSha256: framedSourceSha256(receiptInputs),
    inputs: receiptInputs,
    outputs: receiptOutputs,
  }) + '\n',
);
renameSync(buildReceiptTmp, buildReceiptPath);

if (release) {
  // The shipped bundle (clients/bridge/) and the staging dir (clients/build/)
  // share one parent — the plugin root, clients/. So __PLUGIN_ROOT__
  // (resolve(bundleDir, '..') === clients/) is identical whether the staging or
  // shipped bundle runs, keeping inject/methods/agents co-located with both.
  const bridgeDir = 'clients/bridge';
  mkdirSync(bridgeDir, { recursive: true });
  const bridgeFiles = ['coral-backend.cjs', 'coral-cli.cjs', 'coral-claude-appserver.cjs', 'manifest.json'];
  // Sweep stale leftovers from prior releases so bridge contains only the current bundle surface.
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
