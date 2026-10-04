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
