import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [targetArgument, sourceArgument] = process.argv.slice(2);
if (!targetArgument) {
  throw new Error('Usage: verify-store-reset-build-contract.mjs <bundle-dir> [source-bundle-dir]');
}

const targetDir = resolve(targetArgument);
const requiredBundleFiles = [
  'coral-backend.cjs',
  'coral-cli.cjs',
  'coral-claude-appserver.cjs',
  'manifest.json',
];

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function runIdentityProbe(file) {
  const result = spawnSync(process.execPath, [join(targetDir, file), '--print-store-reset-build-identity'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error || result.status !== 0 || result.stderr !== '') {
    throw new Error(`${file} failed its strict adjacent build-identity probe.`);
  }
  return parseJson(Buffer.from(result.stdout), `${file} identity probe`);
}

for (const file of requiredBundleFiles) {
  readFileSync(join(targetDir, file));
}

const manifestBytes = readFileSync(join(targetDir, 'manifest.json'));
const manifest = parseJson(manifestBytes, `${basename(targetDir)}/manifest.json`);
const backendIdentity = runIdentityProbe('coral-backend.cjs');
const cliIdentity = runIdentityProbe('coral-cli.cjs');
for (const identity of [backendIdentity, cliIdentity]) {
  if (JSON.stringify(identity) !== JSON.stringify(manifest)) {
    throw new Error('Executing bundle identity does not equal its adjacent manifest.');
  }
}

const backendHash = createHash('sha256')
  .update(readFileSync(join(targetDir, 'coral-backend.cjs')))
  .digest('hex')
  .slice(0, 16);
if (manifest.bundleHash !== backendHash) {
  throw new Error('Adjacent manifest backend hash does not match the executing backend bundle.');
}

if (sourceArgument) {
  const sourceManifest = readFileSync(join(resolve(sourceArgument), 'manifest.json'));
  if (!manifestBytes.equals(sourceManifest)) {
    throw new Error('Release manifest is not byte-for-byte identical to the ordinary build manifest.');
  }
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pack = spawnSync(npm, ['pack', '--dry-run', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 30_000,
});
if (pack.error || pack.status !== 0) {
  throw new Error('npm pack --dry-run failed while verifying the package surface.');
}
const packResult = parseJson(Buffer.from(pack.stdout), 'npm pack --dry-run output');
const packagedFiles = Array.isArray(packResult) ? packResult[0]?.files : null;
if (!Array.isArray(packagedFiles)) {
  throw new Error('npm pack --dry-run did not return a file list.');
}
const bridgeAllowlist = new Set(requiredBundleFiles.map((file) => `clients/bridge/${file}`));
const rootAllowlist = new Set(['LICENSE', 'README.md', 'README.ko.md', 'package.json']);
for (const entry of packagedFiles) {
  const path = typeof entry?.path === 'string' ? entry.path.replaceAll('\\', '/') : '';
  if (!rootAllowlist.has(path) && !path.startsWith('dist/') && !bridgeAllowlist.has(path)) {
    throw new Error(`Unexpected packaged file: ${path || '<invalid>'}`);
  }
  if (path.startsWith('clients/build/')) {
    throw new Error('Ordinary build artifacts must not be packaged.');
  }
}
for (const expected of bridgeAllowlist) {
  if (!packagedFiles.some((entry) => entry?.path?.replaceAll('\\', '/') === expected)) {
    throw new Error(`Required packaged file is missing: ${expected}`);
  }
}

console.log(`Verified store-reset build contract in ${targetDir}`);
