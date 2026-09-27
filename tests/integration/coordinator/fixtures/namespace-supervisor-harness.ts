import { runNamespaceSupervisor } from '#src/coordinator-launch/supervisor.js';
import { launchLegacyBackend } from '#src/coordinator-launch/legacy-bootstrap.js';

const executable = process.argv[2];
if (executable === '--launch-legacy') {
  const target = process.argv[3];
  if (target === undefined) throw new Error('Missing legacy backend');
  void launchLegacyBackend(target, process.argv.slice(4));
} else {
  const runDir = process.env.CORAL_SENTINEL_RUN_DIR;
  if (executable === undefined || runDir === undefined) throw new Error('Missing coordinator fixture or run directory');

  void runNamespaceSupervisor(executable, [], runDir, {
    timing:
      process.env.CORAL_FIXTURE_REAL_BACKEND === '1'
        ? { challengeMs: 100, schedulingGapMs: 1_000, lapseMs: 8_000, graceMs: 200, dStateDeferralMs: 4_000 }
        : { challengeMs: 20, schedulingGapMs: 80, lapseMs: 300, graceMs: 80, dStateDeferralMs: 120 },
    startupBudgetMs: 25_000,
  }).then((code) => {
    process.exitCode = code;
  });
}
