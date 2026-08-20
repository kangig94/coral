import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runAsync(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { stdio: 'inherit' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${cmd}`))));
    child.on('error', reject);
  });
}

// Vitest reports `success: true` even when a worker dies and its test file is
// reclassified as a "pending suite".
async function runVitestStrict(cmd) {
  const tmp = mkdtempSync(join(tmpdir(), 'coral-vitest-'));
  const reportPath = join(tmp, 'report.json');
  const fullCmd = `${cmd} --reporter=default --reporter=json --outputFile.json=${reportPath}`;
  try {
    await runAsync(fullCmd);
  } finally {
    try {
      const raw = readFileSync(reportPath, 'utf8');
      const report = JSON.parse(raw);
      const pendingSuites = report.numPendingTestSuites ?? 0;
      if (pendingSuites > 0) {
        const pending = (report.testResults ?? [])
          .filter((r) => r.status === 'pending' || r.assertionResults?.every((a) => a.status === 'pending'))
          .map((r) => r.name);
        console.error(
          `\nFAIL: ${pendingSuites} test suite(s) ended in 'pending' state — likely worker crash:\n${pending.map((p) => `  - ${p}`).join('\n')}\n`,
        );
        rmSync(tmp, { recursive: true, force: true });
        process.exit(1);
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.error('warning: could not parse vitest JSON report:', err.message);
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

// tsc is mostly single-threaded (1 core); vitest spawns N workers (5-6 cores).
// They don't contend on the same resources, so wall-clock drops to max(tsc, vitest)
// instead of sum.
//
// `tests/types/tsconfig.json` is a strict subset of `tsconfig/typecheck.json`
// (whole repo) — running both is redundant. The comprehensive typecheck covers
// the .test-d.ts assertions too.
const tasks = [
  runAsync('npx tsc -p tsconfig/typecheck.json'),
  runVitestStrict('npx vitest run --config vitest/default.ts'),
  runVitestStrict('npx vitest run --config vitest/simulation.ts'),
];

const results = await Promise.allSettled(tasks);
const failed = results.filter((r) => r.status === 'rejected');
if (failed.length > 0) {
  for (const failure of failed) {
    console.error(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
  }
  process.exit(1);
}
