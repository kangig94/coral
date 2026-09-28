# TODO — make the remaining wall-clock test budgets reliable under load

**Status**: partly implemented. The concurrent tier no longer uses file-backed stores for tests that do not exercise durability, and `vitest/default.ts` caps local workers at eight. Timing-sensitive tests remain.

The worker cap reduced the measured peak number of blocked processes but did not eliminate filesystem stalls. Integration and e2e tests still exercise file-backed stores where the file itself is the subject. The suite needs enough margin under ordinary concurrent developer load to distinguish a code failure from a delayed deadline; the cap alone is not that proof.

The observed failures were not among the 22 short raw sleeps previously inventoried. `waitForTerminalEvent` in `tests/unit/jobs/shell/launch.test.ts` waits up to five wall-clock seconds for a real child process to finish and emit a terminal event. That case has failed under machine load and passed on rerun. The build e2e gate has shown the same class of intermittent wall-clock failure. Fake timers alone cannot advance a real subprocess.

Decide, for the named subprocess cases, whether the real process can be replaced by a controlled fixture without losing the behavior the test proves. If it must remain real, give its wall-clock budget enough measured margin under ordinary concurrent developer load. Then assess raw sleeps individually only when a current failure points to one; their aggregate duration is small and a mechanical fake-timer conversion can change what a test proves.

## Start condition

Reproduce or instrument the named real-subprocess waits under the current suite configuration. Change the specific budget or fixture that fails, with its reason visible in the test.
