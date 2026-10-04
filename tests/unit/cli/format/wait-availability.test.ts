import { expect, it } from 'vitest';
import { formatResultAvailability, formatWaitTerminal } from '#src/cli/format/wait.js';
import type { ResultAvailability } from '#src/jobs/terminal/export.js';

it.each([
  [{ kind: 'available', resultPath: '/real/result.md' }, 'Result path: /real/result.md'],
  [{ kind: 'retained-away', retentionDays: 14 }, 'no longer kept: past the 14-day retention window'],
  [{ kind: 'repair-pending', ageUncertain: false }, 'the outcome above is final; Coral is writing the result file'],
  [{ kind: 'failed', cause: 'repair-failed', retryScheduled: true }, 'Coral retries on its next maintenance pass'],
  [{ kind: 'failed', cause: 'source-epoch-retired', retryScheduled: false }, 'not repaired: source-epoch-retired'],
] as const)('prints truthful artifact state %j', (availability, text) => {
  const output = formatResultAvailability(availability as ResultAvailability);
  expect(output).toContain(text);
  if (availability.kind !== 'available') expect(output).not.toContain('Result path:');
});

it('labels an older coordinator path and renders a single exact cursor-aware continuation', () => {
  const terminal = {
    type: 'terminal' as const,
    jobId: 'a',
    seq: 7,
    resultPath: '/claimed/result.md',
    result: { content: 'done', outcome: { kind: 'completed' as const }, durationMs: 1 },
    remainingJobIds: ['b'],
  };
  const output = formatWaitTerminal(terminal, 'saved', false);
  expect(output).toContain('Unverified result path: /claimed/result.md');
  expect(output).toContain('coral-cli wait jobs b --cursor saved');
  expect(output.match(/Run coral-cli/g)).toHaveLength(1);
  expect(formatResultAvailability({ kind: 'available', resultPath: '/settled' }, true)).toBe(
    'result file now available\nResult path: /settled',
  );
});
