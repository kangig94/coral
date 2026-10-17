import { expect, it } from 'vitest';
import { Command } from 'commander';
import { validateWaitJobsOptions, waitInvocationMode } from '#src/cli/wait-invocation.js';

it('checks snapshot syntax at the invocation boundary before preflight or requests', () => {
  const program = new Command();
  program
    .command('wait')
    .command('jobs')
    .argument('<jobIds...>')
    .option('--snapshot')
    .option('--lines <N>')
    .option('--cursor <c>');
  expect(() =>
    waitInvocationMode(program, [
      'node',
      'cli',
      'wait',
      'jobs',
      'a',
      '--snapshot',
      '--lines',
      '20',
      '--cursor',
      'saved',
    ]),
  ).toThrow('--lines cannot be used with --cursor');
  expect(waitInvocationMode(program, ['node', 'cli', 'wait', 'jobs', 'a', '--snapshot', '--lines', '500'])).toBe(
    'snapshot',
  );
  expect(validateWaitJobsOptions({ snapshot: true })).toBeUndefined();
  for (const lines of ['0', '501', '1.1'])
    expect(() => validateWaitJobsOptions({ snapshot: true, lines })).toThrow('--lines must be an integer');
});

it('rejects --snapshot with --embed before requesting a snapshot', () => {
  expect(() => validateWaitJobsOptions({ snapshot: true, embed: true })).toThrow(
    '--snapshot cannot be used with --embed or --verbose',
  );
  expect(() => validateWaitJobsOptions({ embed: true })).not.toThrow();
});
