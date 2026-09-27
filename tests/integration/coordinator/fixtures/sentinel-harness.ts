import { runCoordinatorSentinel } from '#src/runtime/sentinel.js';

const executable = process.argv[2];
if (executable === undefined) throw new Error('Missing coordinator fixture');
void runCoordinatorSentinel(executable, [], {
  timing:
    process.argv[3] === 'slow'
      ? { challengeMs: 100, schedulingGapMs: 5_000, lapseMs: 42_000, graceMs: 500 }
      : { challengeMs: 20, schedulingGapMs: 80, lapseMs: 300, graceMs: 80 },
}).then((code) => {
  process.exitCode = code;
});
