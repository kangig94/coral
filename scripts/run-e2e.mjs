import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [bundleArgument, mode] = process.argv.slice(2);
if (!bundleArgument || (mode !== undefined && mode !== '--store-reset-only')) {
  throw new Error('Usage: run-e2e.mjs <bundle-dir> [--store-reset-only]');
}

const bundleDir = resolve(bundleArgument);
const args = ['vitest', 'run', '--config', 'vitest/e2e.ts'];
if (mode === '--store-reset-only') args.push('tests/e2e/cli/store-reset.test.ts');

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(npx, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    CORAL_E2E_BUNDLE_DIR: bundleDir,
  },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
