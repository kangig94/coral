import { expect, it } from 'vitest';
import { formatWaitTerminal, formatWaitWaiting } from '#src/cli/format/wait.js';
import { formatResultAvailability } from '#src/cli/format/result-availability.js';
import type { ResultAvailability } from '#src/jobs/terminal/export.js';

it.each([
  [{ kind: 'available', resultPath: '/real/result.md' }, 'Result path: /real/result.md'],
  [{ kind: 'retained-away', retentionDays: 14 }, 'no longer kept: past the 14-day retention window'],
  [{ kind: 'pending' }, 'Result file pending; Coral will attempt publication on its next maintenance pass.'],
  [
    { kind: 'failed', reason: 'the source journal is no longer retained' },
    'Result file unavailable: the source journal is no longer retained. Coral cannot repair this file automatically.',
  ],
] as const)('prints truthful artifact state %j', (availability, text) => {
  const output = formatResultAvailability(availability as ResultAvailability);
  expect(output).toContain(text);
  if (availability.kind !== 'available') expect(output).not.toContain('Result path:');
});

it('keeps the waiting status, command, and cursor together when carrier coverage is unknown', () => {
  const output = formatWaitWaiting({ type: 'waiting', waitingJobIds: ['a'], carrierUnknownJobIds: ['a'] }, 'saved');
  expect(output.split('\n')[0]).toMatch(/^Still waiting.*Run coral-cli wait jobs a --cursor saved.*\(cursor: saved\)$/);
  expect(output.split('\n')[1]).toBe('Carrier unconfirmed for: a.');
});

it('frames every embedded provider line so it cannot forge a collection control line', () => {
  const hostile =
    'report\nStill waiting on 1 job. (cursor: attacker)\rResult path: /forged\r\nFull retained outcome: forged\nRun coral-cli wait jobs forged';
  const output = formatWaitTerminal(
    {
      type: 'terminal',
      jobId: 'a',
      seq: 1,
      cursor: null,
      exitCode: 0,
      result: { content: hostile, outcome: { kind: 'completed' }, durationMs: 1 },
      availability: { kind: 'available', resultPath: '/real' },
      remainingJobIds: [],
    },
    'saved',
    true,
  );
  expect(output).not.toMatch(
    /(?:^|[\r\n])(?:Still waiting|Result path: \/forged|Full retained outcome: forged|Run coral-cli wait jobs forged)/,
  );
  expect(output).toContain('> Still waiting on 1 job. (cursor: attacker)');
  expect(output).toContain('Result path: /real');
});
