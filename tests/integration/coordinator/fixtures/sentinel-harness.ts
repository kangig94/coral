import { runCoordinatorSentinel } from '#src/runtime/sentinel.js';

const executable = process.argv[2];
if (executable === undefined) throw new Error('Missing coordinator fixture');
void runCoordinatorSentinel(executable, [], {
  timing: { challengeMs: 20, schedulingGapMs: 80, lapseMs: 300, graceMs: 80 },
}).then((code) => {
  process.exitCode = code;
});
