/**
 * Mark-based flaky test runner with isolated batches.
 *
 * Test files containing a `// @flaky` comment are detected automatically,
 * excluded from the main vitest run, then executed in isolation.
 * To mark a test as flaky, add `// @flaky` anywhere in the file (typically
 * line 1 with a short reason).
 *
 * `npm test` includes both the production-unit batch and the simulation
 * harness batch. Simulation keeps a dedicated Vitest config only for
 * single-fork isolation, not because it is optional.
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

const commands = [];

if (flaky.length) {
  const excludes = flaky.map((f) => `--exclude '${f}'`).join(' ');
  commands.push(`npx vitest run ${excludes}`);
  commands.push(`npx vitest run ${flaky.join(' ')}`);
} else {
  commands.push('npx vitest run');
}

commands.push('npx vitest run --config vitest.simulation.config.ts');

try {
  for (const command of commands) {
    await runAsync(command);
  }
} catch {
  process.exit(1);
}
