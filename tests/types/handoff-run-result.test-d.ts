import { consumeHandoffRunResult, type HandoffRunResult } from '#src/coordinator/handoff-runner.js';

declare const result: HandoffRunResult;

// @ts-expect-error callers must narrow the recording disposition before reading observed work.
void result.continuation;

// @ts-expect-error observed work is unavailable until a recording-incident handler is supplied.
consumeHandoffRunResult(result);

if (result.kind === 'recorded') {
  void result.continuation;
}
