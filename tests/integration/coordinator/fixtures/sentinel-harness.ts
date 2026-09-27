import { runCoordinatorSentinel } from '#src/runtime/sentinel.js';

const executable = process.argv[2];
if (executable === undefined) throw new Error('Missing coordinator fixture');
void runCoordinatorSentinel(executable, [], {
  fixtureRelaunch: process.argv[3] !== 'no-fixture-relaunch',
  isChildUninterruptible: process.argv[3] === 'd-state' ? () => true : undefined,
  writeRecord: process.argv[3] === 'arm-write-fails' ? (_runDir, _id, record) => record.state !== 'armed' : undefined,
  timing:
    process.argv[3] === 'slow'
      ? { challengeMs: 100, schedulingGapMs: 5_000, lapseMs: 42_000, graceMs: 500, dStateDeferralMs: 1_000 }
      : process.argv[3] === 'grace-gap'
        ? { challengeMs: 20, schedulingGapMs: 80, lapseMs: 600, graceMs: 300, dStateDeferralMs: 400 }
        : { challengeMs: 20, schedulingGapMs: 80, lapseMs: 300, graceMs: 80, dStateDeferralMs: 120 },
}).then((code) => {
  process.exitCode = code;
});
