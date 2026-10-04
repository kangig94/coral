import { expect, it } from 'vitest';
import { Command } from 'commander';
import { validateWaitJobsOptions, waitInvocationMode } from '#src/cli/wait-invocation.js';

it('checks snapshot syntax at the invocation boundary before preflight or requests', () => {
  const program = new Command();
  program
    .command('wait')
    .command('jobs')
    .argument('<jobIds...>')
    .option('--now')
    .option('--lines <N>')
    .option('--cursor <c>');
  expect(() =>
    waitInvocationMode(program, ['node', 'cli', 'wait', 'jobs', 'a', '--now', '--lines', '20', '--cursor', 'saved']),
  ).toThrow('--lines cannot be used with --cursor');
  expect(waitInvocationMode(program, ['node', 'cli', 'wait', 'jobs', 'a', '--now', '--lines', '500'])).toBe('snapshot');
  expect(validateWaitJobsOptions({ now: true })).toBeUndefined();
  for (const lines of ['0', '501', '1.1', 'not-a-number'])
    expect(() => validateWaitJobsOptions({ now: true, lines })).toThrow('--lines must be an integer');
});

it.each(['embed', 'verbose'] as const)('rejects --now with --%s before requesting a snapshot', (option) => {
  expect(() => validateWaitJobsOptions({ now: true, [option]: true })).toThrow(
    '--now cannot be used with --embed or --verbose',
  );
  expect(() => validateWaitJobsOptions({ [option]: true })).not.toThrow();
});

it.each([
  [{ now: true, lines: '20', cursor: 'saved' }, ['Remove --lines to resume', 'remove --cursor to show']],
  [{ lines: '20' }, ['Add --now', 'remove --lines']],
  [{ now: true, embed: true }, ['Remove --embed', 'remove --now']],
  [{ now: true, verbose: true }, ['Remove --verbose', 'remove --now']],
] as const)('states the intent-specific repairs for %j', (options, repairs) => {
  for (const repair of repairs) expect(() => validateWaitJobsOptions(options)).toThrow(repair);
});
