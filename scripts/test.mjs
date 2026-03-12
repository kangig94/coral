/**
 * Mark-based flaky test runner.
 *
 * Test files containing a `// @flaky` comment are detected automatically,
 * excluded from the main vitest run, then executed in isolation afterward.
 * To mark a test as flaky, add `// @flaky` anywhere in the file (typically
 * line 1 with a short reason).
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { glob } from 'fs/promises';

const TEST_PATTERN = 'src/**/*.test.ts';
const MARKER = /\/\/\s*@flaky\b/;

// Collect all test files that carry the @flaky marker.
const flaky = [];
for await (const file of glob(TEST_PATTERN)) {
  const head = readFileSync(file, 'utf8').slice(0, 512);
  if (MARKER.test(head)) flaky.push(file);
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

try {
  if (flaky.length) {
    const excludes = flaky.map((f) => `--exclude '${f}'`).join(' ');
    run(`npx vitest run ${excludes}`);
    run(`npx vitest run ${flaky.join(' ')}`);
  } else {
    run('npx vitest run');
  }
} catch {
  process.exit(1);
}
