/**
 * Mark-based flaky test runner with isolated batches.
 *
 * Test files containing a `// @flaky` comment are detected automatically,
 * excluded from the main vitest run, then executed in isolation.
 * To mark a test as flaky, add `// @flaky` anywhere in the file (typically
 * line 1 with a short reason).
 *
 * The main/flaky batches and the simulation batch run sequentially to avoid
 * cross-batch contention in CLI and backend integration tests.
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { glob } from 'fs/promises';

const TEST_PATTERN = 'src/**/*.test.ts';
const MARKER = /\/\/\s*@flaky\b/;

const flaky = [];
for await (const file of glob(TEST_PATTERN)) {
  const head = readFileSync(file, 'utf8').slice(0, 512);
  if (MARKER.test(head)) flaky.push(file);
}

function runAsync(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { stdio: 'inherit' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${cmd}`))));
    child.on('error', reject);
  });
}

const jobs = [];

if (flaky.length) {
  const excludes = flaky.map((f) => `--exclude '${f}'`).join(' ');
  jobs.push(runAsync(`npx vitest run ${excludes}`));
  jobs.push(runAsync(`npx vitest run ${flaky.join(' ')}`));
} else {
  jobs.push(runAsync('npx vitest run'));
}

jobs.push(runAsync('npx vitest run --config vitest.simulation.config.ts'));

try {
  for (const job of jobs) {
    await job;
  }
} catch {
  process.exit(1);
}
