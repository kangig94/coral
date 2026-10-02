import { observeProcessLiveness, probeProcessIncarnation } from '#src/infra/node-process.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

export function freezeRecordedProcesses(recorded: readonly { pid: number; incarnation: string | null }[]): void {
  for (const { pid, incarnation } of recorded) {
    if (incarnation === null || probeProcessIncarnation(pid) !== incarnation) continue;
    try {
      process.kill(pid, 'SIGSTOP');
    } catch {
      // stopRecordedProcesses still verifies departure if the process exited during observation.
    }
  }
}

export async function stopRecordedProcesses(
  recorded: readonly { pid: number; incarnation: string | null }[],
  signal: NodeJS.Signals = 'SIGKILL',
  timeoutMs = 5_000,
): Promise<void> {
  const pending = new Map(recorded.map(({ pid, incarnation }) => [pid, incarnation]));
  try {
    await waitForCondition(() => {
      for (const [pid, incarnation] of pending) {
        const observed = probeProcessIncarnation(pid);
        if (
          observeProcessLiveness(pid) === 'absent' ||
          (incarnation !== null && observed !== null && observed !== incarnation)
        ) {
          pending.delete(pid);
          continue;
        }
        if (incarnation === null || observed !== incarnation) continue;
        try {
          process.kill(pid, signal);
        } catch {
          // The next observation must prove departure even if signalling fails.
        }
      }
      return pending.size === 0;
    }, timeoutMs);
  } catch (cause) {
    throw new Error(`Fixture process departure unproven after ${timeoutMs}ms: ${[...pending.keys()].join(', ')}`, {
      cause,
    });
  }
}
