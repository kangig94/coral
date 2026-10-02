import { spawn } from 'child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  casesWithoutHeadroom,
  collectDurations,
  describeCase,
  formatDurations,
  headroomRatio,
} from './test-report.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPORTS_DIR = join(REPO_ROOT, 'reports');

// A gate on headroom, not a budget: a case must finish inside its own declared budget divided by this
// ratio. Two runners given the same tree measured 25-33% apart on the lint, format:check and build steps
// that precede every test (GitHub Actions runs 35137382902 and 35168294965, 2026-09-17), so a case with
// less margin than that is a timeout waiting for the next slow machine, on whichever unrelated pull
// request meets it; failing a green run here is the cheaper place to learn it.
let ratio;
try {
  ratio = headroomRatio(process.env.CORAL_HEADROOM_RATIO);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

function runAsync(cmd) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { stdio: 'inherit' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}: ${cmd}`))));
    child.on('error', reject);
  });
}

function readReport(reportPath) {
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('warning: could not parse vitest JSON report:', err.message);
    }
    return null;
  }
}

// Vitest reports `success: true` even when a worker dies and its test file is
// reclassified as a "pending suite".
function pendingSuiteNames(report) {
  if ((report.numPendingTestSuites ?? 0) === 0) {
    return [];
  }

  return (report.testResults ?? [])
    .filter((r) => r.status === 'pending' || r.assertionResults?.every((a) => a.status === 'pending'))
    .map((r) => r.name);
}

// The report is written to a stable path so that a green run's per-case durations outlive it. Vitest
// writes the report once, at the end, so a run that dies earlier leaves the previous run's file in place:
// it has to be deleted before the run, and a missing report afterwards means this run measured nothing
// and may not pass the gate on the strength of having measured nothing.
async function runVitestStrict(configName) {
  const reportPath = join(REPORTS_DIR, `vitest-${configName}.json`);
  mkdirSync(REPORTS_DIR, { recursive: true });
  rmSync(reportPath, { force: true });

  let failure;
  try {
    await runAsync(
      `npx vitest run --config vitest/${configName}.ts --reporter=default --reporter=json --outputFile.json=${reportPath}`,
    );
  } catch (err) {
    failure = err;
  }

  const report = readReport(reportPath);
  if (report === null) {
    failure ??= new Error(`${configName}: vitest wrote no JSON report at ${reportPath}`);
  } else {
    const durations = collectDurations(report, REPO_ROOT);
    console.log(`\nvitest ${configName} durations\n${formatDurations(durations)}\n`);

    const pending = pendingSuiteNames(report);
    if (pending.length > 0) {
      console.error(
        `\nFAIL: ${pending.length} test suite(s) ended in 'pending' state — likely worker crash:\n${pending.map((p) => `  - ${p}`).join('\n')}\n`,
      );
      failure ??= new Error(`${configName}: ${pending.length} pending test suite(s)`);
    }

    const { withoutHeadroom, unjudged, unbounded } = casesWithoutHeadroom(durations.cases, { ratio });
    if (unbounded.length > 0) {
      const listed = unbounded.map((entry) => `  - ${describeCase(entry)}`).join('\n');
      console.log(
        `\nnote: ${unbounded.length} case(s) ran with no timer, so this gate judges them against nothing:\n${listed}\n`,
      );
    }
    if (withoutHeadroom.length > 0) {
      const listed = withoutHeadroom.map((entry) => `  - ${describeCase(entry)}`).join('\n');
      console.error(`\nFAIL: ${withoutHeadroom.length} case(s) ran within ${ratio}x of their own budget:\n${listed}\n`);
      failure ??= new Error(`${configName}: ${withoutHeadroom.length} case(s) without budget headroom`);
    }
    if (unjudged.length > 0) {
      const listed = unjudged.map((entry) => `  - ${describeCase(entry)}`).join('\n');
      console.error(`\nFAIL: ${unjudged.length} case(s) reported no budget to judge them against:\n${listed}\n`);
      failure ??= new Error(`${configName}: ${unjudged.length} case(s) with no reported budget`);
    }
  }

  if (failure) {
    throw failure;
  }
}

// `tsc -p tsconfig/typecheck.json` must run exactly once per gate, and a failed typecheck must fail under
// its own CI step name rather than from inside `npm test`. So under CI it belongs to the workflow's own
// step (see typecheck:tests in .github/workflows/ci.yml) and must not run here; a local `npm test` has no
// such step and still has to typecheck.
//
// `tests/types/tsconfig.json` is a strict subset of `tsconfig/typecheck.json`
// (whole repo) — running both is redundant. The comprehensive typecheck covers
// the .test-d.ts assertions too.
//
// GitHub gives a public repository's `ubuntu-latest` job 4 vCPU (GitHub Actions runner specification, read
// 2026-09-17), and every entry of `tasks` runs on them at once. No pool may assume a dedicated core: each
// case shares the available cores, which is only survivable while no single case holds a core
// for tens of seconds — see casesWithoutHeadroom in scripts/test-report.mjs.
if (process.env.CI) {
  console.error('skipping tsc: the CI gate typechecks the tree under its own step');
}
const tasks = [
  ...(process.env.CI ? [] : [runAsync('npx tsc -p tsconfig/typecheck.json')]),
  runVitestStrict('default'),
];

const results = await Promise.allSettled(tasks);
const failed = results.filter((r) => r.status === 'rejected');
if (failed.length > 0) {
  for (const failure of failed) {
    console.error(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
  }
  process.exit(1);
}
