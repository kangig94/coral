import type { HandoffRunResult } from '#src/coordinator/handoff-runner.js';

declare const result: HandoffRunResult;

// @ts-expect-error callers must narrow the recording disposition before reading observed work.
void result.continuation;

if (result.kind === 'recorded') {
  void result.continuation;
}
